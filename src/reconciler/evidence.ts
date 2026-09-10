/**
 * The evidence package: one structured document per call.
 *
 * Everything downstream reads this and nothing else. The briefing writer, a
 * queue row, an alert, a screen: all of them take an EvidencePackage and none
 * of them get to reach past it into a raw payload. That is deliberate. The
 * moment a renderer is allowed to read the payload directly it starts making
 * its own judgements, and then two parts of the system disagree about what
 * happened to a call while both look correct in isolation.
 *
 * One rule runs through the whole file. Every item carries the field it came
 * from, and anything that cannot be sourced is left out rather than guessed.
 * A package with a gap in it is telling the truth. A package that fills the gap
 * from inference, and does not say so, is the bug this library exists to
 * complain about.
 *
 * Nothing here talks to the network. The builder takes what you already
 * fetched and arranges it, so the whole thing is testable off fixtures and a
 * call never has to be placed to develop against it.
 */

import type { Disposition } from "../disposition/axes.js";
import { maskDestination, type Intent } from "../ledger/intent.js";

/**
 * A value together with where it came from.
 *
 * `from` is never empty. If you cannot name the field, you do not have the
 * fact, and `sourced()` will refuse to build the item rather than let a
 * sourceless value into the package.
 */
export interface Sourced<T> {
  value: T;
  /** Exact field paths, in the same notation `AxisReading.from` uses. */
  from: string[];
  /** Set when the value was computed rather than read straight off a field. */
  note?: string;
}

/** Build a sourced value. Throws if nobody can say where it came from. */
export function sourced<T>(value: T, from: string[], note?: string): Sourced<T> {
  if (from.length === 0) {
    throw new Error(
      "An evidence item needs at least one source field. Leave the item out instead.",
    );
  }
  return note === undefined ? { value, from } : { value, from, note };
}

/**
 * One developer-facing call event, as the API documents it.
 *
 * `created_at` is the field this whole module leans on. The spec declares it
 * `format: date-time` and every event we have read carried a zone, which is
 * what makes the event stream usable for timing when the attempt timestamps
 * are not.
 */
export interface CallEvent {
  id: string;
  type: string;
  call_id: string;
  created_at: string;
  level?: "debug" | "info" | "warning" | "error";
  status?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/** One page of `GET /v1/calls/{call_id}/events`. */
export interface EventPage {
  object?: string;
  data: CallEvent[];
  next_cursor?: string | null;
}

/** What somebody approved before the call went out. */
export interface Authorized {
  /** Masked. The callable number never enters an evidence package. */
  destination: Sourced<string>;
  purpose: Sourced<string>;
  authorizedAt: Sourced<string>;
  idempotencyKey: Sourced<string>;
  ledgerState: Sourced<string>;
  /** The id CALL-E gave back, once there was one. */
  boundId: Sourced<string> | null;
}

/** One entry in the call's status timeline, taken from the event stream. */
export interface TimelineEntry {
  /**
   * The event's own id. Kept because it is the same value the delivery header
   * carries, so a line in a timeline can be matched to a webhook that arrived.
   */
  id: string;
  at: string;
  type: string;
  status: string | null;
  level: string | null;
  message: string | null;
  /** True when `at` carried a zone. A naive timestamp is not comparable. */
  zoned: boolean;
  from: string[];
}

/** One dialling attempt as the payload reports it. */
export interface AttemptView {
  index: number;
  startedAt: string | null;
  completedAt: string | null;
  failureCode: string | null;
  /** True only when both timestamps are present and both carry a zone. */
  zoned: boolean;
  from: string[];
}

/** Who spoke, counted rather than judged. */
export interface TurnCounts {
  total: number;
  user: number;
  bot: number;
  unknown: number;
}

/** What the platform actually reported, before anybody interprets it. */
export interface ObservedState {
  status: Sourced<string> | null;
  timeline: TimelineEntry[];
  attempts: AttemptView[];
  turns: Sourced<TurnCounts> | null;
  /** Present only when a webhook delivery for this call was recorded. */
  webhook: Sourced<{ eventId: string | null; receivedAt: string | null }> | null;
}

/** A reconciliation finding. One per open issue the platform has not closed. */
export interface Flag {
  code: "stuck" | "replayed" | "retry_unsafe" | "duration_unreliable";
  /** One plain sentence, safe to render with no further wording. */
  summary: string;
  /** The fields that set it. Never empty. */
  from: string[];
  /** Higher means it costs you more to ignore. Used by the ranker. */
  weight: number;
}

export interface EvidencePackage {
  callId: Sourced<string> | null;
  /** Null when the call was not placed through a ledger we hold. */
  authorized: Authorized | null;
  observed: ObservedState;
  /** The three axes, from the engine that already exists. */
  read: Disposition;
  flags: Flag[];
  /**
   * Whether the detectors have actually run over this package.
   *
   * An empty `flags` array is ambiguous on its own: it means either that
   * nothing fired or that nobody looked. Those are opposite facts and the
   * ranker treats them very differently, so the difference is recorded rather
   * than inferred. `classify` refuses a package where this is false.
   */
  flagsComputed: boolean;
  builtAt: string;
}

/** Inputs the builder arranges. Everything is optional except the reading. */
export interface EvidenceInput {
  /** The raw call payload, already fetched. */
  payload?: unknown;
  /** Every event page you fetched, oldest page first. */
  events?: EventPage[];
  /** The ledger record that authorized the call, if there is one. */
  intent?: Intent;
  /** Set when this call arrived by webhook rather than by polling. */
  webhook?: { eventId: string | null; receivedAt: string | null };
  /** The disposition the engine already produced for this payload. */
  read: Disposition;
  /** Overridable so tests are not clock-dependent. */
  now?: () => Date;
}

/** True when a timestamp states its offset. `2000-01-02T21:14:05` does not. */
export function isZoned(ts: string | null | undefined): boolean {
  if (!ts) return false;
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(ts.trim());
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Pull the call id from whichever surface shape the payload happens to be. */
function readCallId(payload: unknown): Sourced<string> | null {
  const p = asRecord(payload);
  if (!p) return null;
  const direct = str(p["id"]);
  if (direct) return sourced(direct, ["id"]);
  const data = asRecord(p["data"]);
  const nested = data ? str(data["id"]) : null;
  if (nested) return sourced(nested, ["data.id"]);
  return null;
}

function readStatus(payload: unknown): Sourced<string> | null {
  const p = asRecord(payload);
  if (!p) return null;
  const direct = str(p["status"]);
  if (direct) return sourced(direct, ["status"]);
  const data = asRecord(p["data"]);
  const nested = data ? str(data["status"]) : null;
  if (nested) return sourced(nested, ["data.status"]);
  return null;
}

/** The call object, whether it arrived bare or wrapped in a webhook envelope. */
function callObject(payload: unknown): Record<string, unknown> | null {
  const p = asRecord(payload);
  if (!p) return null;
  const data = asRecord(p["data"]);
  if (data && (data["status"] !== undefined || data["recipients"] !== undefined)) {
    return data;
  }
  return p;
}

function readAttempts(payload: unknown): AttemptView[] {
  const call = callObject(payload);
  if (!call) return [];
  const recipients = call["recipients"];
  if (!Array.isArray(recipients) || recipients.length === 0) return [];
  const first = asRecord(recipients[0]);
  if (!first) return [];
  const attempts = first["attempts"];
  if (!Array.isArray(attempts)) return [];

  const base = "recipients[0].attempts";
  return attempts.map((raw, i) => {
    const a = asRecord(raw) ?? {};
    const startedAt = str(a["started_at"]);
    const completedAt = str(a["completed_at"]);
    const failureCode = str(a["failure_code"]);
    const from = [`${base}[${i}]`];
    return {
      index: i,
      startedAt,
      completedAt,
      failureCode,
      zoned: isZoned(startedAt) && isZoned(completedAt),
      from,
    };
  });
}

/**
 * Count who spoke. A count, never a judgement about what was said.
 *
 * Returns null when the payload carries no transcript at all, which is a
 * different fact from a transcript with nobody in it and must not be flattened
 * into one.
 */
function readTurns(payload: unknown): Sourced<TurnCounts> | null {
  const call = callObject(payload);
  if (!call) return null;

  // The transcript hangs off the attempt, not off the call. Every payload the
  // API has actually returned puts it at
  // recipients[i].attempts[j].transcript_turns, and an earlier version of this
  // function looked only at the top level, so it reported "no transcript" for
  // every real call while passing its tests against a fixture nobody had
  // checked against the wire. The top level is still read as a fallback,
  // because the shape is not documented and being wrong in the other direction
  // costs nothing.
  const found: { turns: unknown[]; from: string } | null = (() => {
    const recipients = call["recipients"];
    if (Array.isArray(recipients)) {
      const collected: unknown[] = [];
      const paths: string[] = [];
      recipients.forEach((rawRecipient, r) => {
        const recipient = asRecord(rawRecipient);
        const attempts = recipient?.["attempts"];
        if (!Array.isArray(attempts)) return;
        attempts.forEach((rawAttempt, a) => {
          const attempt = asRecord(rawAttempt);
          const turns = attempt?.["transcript_turns"];
          if (Array.isArray(turns)) {
            collected.push(...turns);
            paths.push(`recipients[${r}].attempts[${a}].transcript_turns[].speaker`);
          }
        });
      });
      if (paths.length > 0) return { turns: collected, from: paths.join(", ") };
    }
    const top = call["transcript_turns"];
    return Array.isArray(top) ? { turns: top, from: "transcript_turns[].speaker" } : null;
  })();

  if (!found) return null;

  const counts: TurnCounts = { total: found.turns.length, user: 0, bot: 0, unknown: 0 };
  for (const raw of found.turns) {
    const t = asRecord(raw);
    const speaker = t ? str(t["speaker"]) : null;
    if (speaker === "user") counts.user += 1;
    else if (speaker === "bot") counts.bot += 1;
    else counts.unknown += 1;
  }
  return sourced(counts, [found.from]);
}

/**
 * Flatten every event page into one timeline, oldest first.
 *
 * Pages arrive oldest-to-newest within a window, and the caller hands them over
 * in fetch order, so concatenating preserves the order the API published. We
 * sort only when every entry is zoned, because sorting a mix of zoned and naive
 * timestamps invents an ordering that the data does not support.
 */
function readTimeline(pages: EventPage[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  pages.forEach((page, pageIndex) => {
    (page.data ?? []).forEach((ev, i) => {
      const at = ev.created_at;
      entries.push({
        id: ev.id,
        at,
        type: ev.type,
        status: ev.status ?? null,
        level: ev.level ?? null,
        message: ev.message ?? null,
        zoned: isZoned(at),
        from: [`events[${pageIndex}].data[${i}]`],
      });
    });
  });

  if (entries.length > 1 && entries.every((e) => e.zoned)) {
    entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
  return entries;
}

function readAuthorized(intent: Intent | undefined): Authorized | null {
  if (!intent) return null;
  return {
    destination: sourced(
      maskDestination(intent.authorization.destination),
      ["intent.authorization.destination"],
      "Masked on the way in. The callable number is never put in a package.",
    ),
    purpose: sourced(intent.authorization.purpose, ["intent.authorization.purpose"]),
    authorizedAt: sourced(intent.createdAt, ["intent.createdAt"]),
    idempotencyKey: sourced(
      intent.idempotencyKey,
      ["intent.idempotencyKey"],
      "Derived from the authorization, so every retry of the same approved action carries the same key.",
    ),
    ledgerState: sourced(intent.state, ["intent.state"]),
    boundId: intent.boundId ? sourced(intent.boundId, ["intent.boundId"]) : null,
  };
}

/**
 * Arrange what you fetched into the package.
 *
 * Flags are not set here. This function only records what is observable, and
 * the detectors in `flags.ts` run over the finished package, so every flag can
 * point at an item that is already in the document rather than at a payload
 * nobody else can see.
 */
export function buildEvidence(input: EvidenceInput): EvidencePackage {
  const now = input.now ?? (() => new Date());
  const pages = input.events ?? [];

  return {
    callId: readCallId(input.payload),
    authorized: readAuthorized(input.intent),
    observed: {
      status: readStatus(input.payload),
      timeline: readTimeline(pages),
      attempts: readAttempts(input.payload),
      turns: readTurns(input.payload),
      webhook: input.webhook
        ? sourced(input.webhook, ["webhook.call-e-event-id", "webhook.receivedAt"])
        : null,
    },
    read: input.read,
    flags: [],
    flagsComputed: false,
    builtAt: now().toISOString(),
  };
}
