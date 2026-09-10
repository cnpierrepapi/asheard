/**
 * Reconciliation flags: the open issues, written as code that runs.
 *
 * Each detector below is one thing CALL-E users have reported and nothing has
 * closed. They are deliberately literal. A flag fires on fields, points at the
 * fields it fired on, and says nothing it cannot source. None of them reads a
 * transcript, scores a confidence, or asks a model what it thinks.
 *
 * Where a flag comes from:
 *
 *   stuck               awesome#283, awesome#305, integrations#90
 *   replayed            awesome#315
 *   retry_unsafe        awesome#234, integrations#108
 *   duration_unreliable awesome#196, calle-docs#42
 *
 * The weights decide the order of the briefing and they are not cosmetic. They
 * rank by what it costs you to ignore the thing, so a call nobody is watching
 * outranks a duration you cannot trust, however annoying the second one is.
 */

import type { EvidencePackage, Flag, TimelineEntry } from "./evidence.js";
import { isZoned } from "./evidence.js";
import { isTerminal } from "../calle/client.js";

/**
 * The whole documented lifecycle, and nothing else.
 *
 * These five are the entire `CallStatus` enum in CALL-E's own spec. The list is
 * written down here so that a status outside it is a fact we can report rather
 * than something that quietly falls through a branch.
 *
 * There is one definition of terminal in this library and it lives on the
 * client. An earlier draft of this file kept a second one that also counted
 * `expired`, which is not a status CALL-E publishes. Two disagreeing
 * definitions of "finished" inside one package is the exact failure this
 * project was built to complain about, so it does not get to happen here.
 */
export const DOCUMENTED_STATUSES = [
  "queued",
  "in_progress",
  "completed",
  "failed",
  "canceled",
] as const;

/** Documented statuses that mean the platform still owes you an ending. */
export const NON_TERMINAL_STATUSES = ["queued", "in_progress"] as const;

export interface FlagOptions {
  /**
   * How long a call may sit non-terminal before nobody is watching it.
   *
   * Default is ten minutes because that is the SDK's own `waitForResult`
   * ceiling, and #283 is the case where the client gave up at ten minutes and
   * the phone rang at thirty-nine. Past this line the client and the platform
   * disagree about whether anything is still going to happen.
   */
  stuckAfterMs?: number;
  /** Overridable so tests are not clock-dependent. */
  now?: () => Date;
}

const DEFAULT_STUCK_AFTER_MS = 10 * 60 * 1000;

/** True when CALL-E publishes this status at all. */
export function isDocumentedStatus(status: string | null | undefined): boolean {
  return typeof status === "string"
    ? (DOCUMENTED_STATUSES as readonly string[]).includes(status)
    : false;
}

/**
 * True when the platform still owes you an ending.
 *
 * An undocumented status counts as open, and deliberately so. `integrations#90`
 * is a run that sat in `PREPARING`, which is not in the enum, and a check that
 * only knew the documented non-terminal values would have read that call as
 * finished. Not knowing what a status means is not the same as the call being
 * over, and only one of those two mistakes rings somebody's phone.
 */
export function isOpen(status: string | null | undefined): boolean {
  if (typeof status !== "string" || status.length === 0) return false;
  if (isTerminal(status)) return false;
  return true;
}

/** The earliest zoned event on the timeline, which is when the platform first spoke. */
function firstZoned(timeline: TimelineEntry[]): TimelineEntry | null {
  for (const entry of timeline) {
    if (entry.zoned) return entry;
  }
  return null;
}

function minutes(ms: number): number {
  return Math.floor(ms / 60000);
}

/**
 * Nobody is watching this one.
 *
 * Fires when the call is still non-terminal and enough time has passed that
 * anything waiting on it has already given up. Needs a zoned timestamp to
 * measure from, and says so rather than guessing when it has none.
 */
export function detectStuck(pkg: EvidencePackage, opts: FlagOptions = {}): Flag | null {
  const status = pkg.observed.status?.value ?? null;
  if (!isOpen(status)) return null;

  // A status outside the published enum is worth saying out loud on its own,
  // because nothing downstream can branch on a value nobody documented.
  const undocumented = !isDocumentedStatus(status);

  const now = (opts.now ?? (() => new Date()))();
  const limit = opts.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
  const start = firstZoned(pkg.observed.timeline);

  // No usable clock. The call is still open and we cannot say for how long,
  // which is its own finding and must not be reported as "fine".
  //
  // This fires whether or not the call has been dialled. An earlier version
  // returned nothing when an attempt existed, on the reasoning that dialling
  // proves something happened. It does not prove the call ever ended, and a
  // call that is open with no clock on it is exactly the one nobody notices.
  if (!start) {
    const dialled = pkg.observed.attempts.length > 0;
    return {
      code: "stuck",
      summary: dialled
        ? `This call is still ${status} and nothing here says how long it has been running.`
        : `This call is still ${status} and has never been dialled. Nothing here says how long it has been waiting.`,
      from: [...(pkg.observed.status?.from ?? [])],
      weight: 95,
    };
  }

  const waitedMs = now.getTime() - Date.parse(start.at);
  if (waitedMs < limit) return null;

  const waited = minutes(waitedMs);
  const noAttempts = pkg.observed.attempts.length === 0;
  const tail = noAttempts ? "and has never been dialled." : "and has not finished.";
  const summary = undocumented
    ? `This call has been sitting in "${status}" for ${waited} minutes ${tail} That is not one of the five states the API says a call can be in.`
    : `This call has been ${status} for ${waited} minutes ${tail}`;

  return {
    code: "stuck",
    summary,
    from: [...(pkg.observed.status?.from ?? []), ...start.from],
    weight: 100,
  };
}

/**
 * It may have gone out twice.
 *
 * The returned call is older than the request that returned it, which means the
 * platform handed back a call that already existed. A replay reads exactly like
 * a fresh creation otherwise, which is #315, and it cost the reporter two hours.
 *
 * `requestedAt` has to come from the caller because the payload cannot know when
 * you asked. Without it the check does not run rather than assuming a window.
 */
export function detectReplayed(
  pkg: EvidencePackage,
  requestedAt?: string,
): Flag | null {
  if (!requestedAt || !isZoned(requestedAt)) return null;
  const start = firstZoned(pkg.observed.timeline);
  if (!start) return null;

  const requested = Date.parse(requestedAt);
  const created = Date.parse(start.at);
  // A second of slack. Clocks are not the finding here.
  if (created >= requested - 1000) return null;

  return {
    code: "replayed",
    summary:
      "The call this request returned already existed before the request was made, so it may be a repeat of one that already went out.",
    from: [...start.from],
    weight: 90,
  };
}

/**
 * Do not send that key again.
 *
 * Two shapes, both reported. The ledger is sitting in `submission_unknown`, so
 * whether the call went out is genuinely unknown and a retry can ring somebody
 * twice. Or the same key came back 422 after a failure, which is #234, and the
 * docs do not say which key to use next.
 *
 * We can answer the second one, because the key is derived from the
 * authorization rather than the attempt. That answer is in the summary, since
 * it is the whole reason the derivation is built that way.
 */
export function detectRetryUnsafe(
  pkg: EvidencePackage,
  lastResponseStatus?: number,
): Flag | null {
  const state = pkg.authorized?.ledgerState.value ?? null;

  if (state === "submission_unknown") {
    return {
      code: "retry_unsafe",
      summary:
        "Nobody knows whether this call was accepted. Check before sending it again, because a repeat here rings a real person twice.",
      from: [...(pkg.authorized?.ledgerState.from ?? [])],
      weight: 85,
    };
  }

  if (lastResponseStatus === 422 && pkg.authorized) {
    return {
      code: "retry_unsafe",
      summary:
        "The last attempt was refused for reusing its key. The key is derived from the authorization, so the same one is correct for the next attempt and a new one would place a second call.",
      from: [...pkg.authorized.idempotencyKey.from],
      weight: 80,
    };
  }

  return null;
}

/**
 * The clock on this call does not add up.
 *
 * Three shapes, all seen on the wire. The attempt timestamps carry no zone, so they
 * cannot be compared with anything. Start equals end, so the duration is zero
 * on a call that plainly took time. Or the attempt window disagrees with the
 * event stream by more than a minute.
 *
 * The event stream is treated as the better clock, because its timestamps are
 * zoned and the attempt ones are not. That is the reconstruction #196 asks for.
 */
export function detectDurationUnreliable(pkg: EvidencePackage): Flag | null {
  const attempts = pkg.observed.attempts;
  if (attempts.length === 0) return null;

  const naive = attempts.filter((a) => a.startedAt && a.completedAt && !a.zoned);
  if (naive.length > 0) {
    const a = naive[0]!;
    return {
      code: "duration_unreliable",
      summary:
        "The attempt times on this call do not say what timezone they are in, so how long it ran cannot be worked out from them.",
      from: [...a.from],
      weight: 60,
    };
  }

  const zeroLength = attempts.filter(
    (a) => a.startedAt && a.completedAt && a.startedAt === a.completedAt,
  );
  if (zeroLength.length > 0) {
    const a = zeroLength[0]!;
    return {
      code: "duration_unreliable",
      summary:
        "This attempt reports the same moment for start and end, so it reads as lasting no time at all.",
      from: [...a.from],
      weight: 60,
    };
  }

  // Only a contradiction counts, never a difference.
  //
  // An earlier version of this compared the attempt window against the whole
  // event stream and flagged any gap over a minute. That is plainly wrong on
  // an ordinary call: the stream runs well past the attempt, because it also
  // covers queuing before the dial and
  // finalization after the hangup. Those are different things and a wider
  // stream is exactly what you would expect.
  //
  // What cannot be true is an attempt that claims to have lasted longer than
  // the entire life of the call, or one that ran outside the window the
  // platform says the call existed in. Those are contradictions rather than
  // differences, and only those are reported.
  const span = timelineSpanMs(pkg);
  const attemptSpan = attemptSpanMs(attempts);
  if (span !== null && attemptSpan !== null && attemptSpan > span + 1000) {
    return {
      code: "duration_unreliable",
      summary: `The attempt claims ${Math.round(attemptSpan / 1000)} seconds on a call the event stream says only lasted ${Math.round(span / 1000)}. One of those two is wrong.`,
      from: [...attempts[0]!.from, ...(pkg.observed.timeline[0]?.from ?? [])],
      weight: 65,
    };
  }

  const outside = attemptOutsideStream(pkg, attempts);
  if (outside !== null) return outside;

  return null;
}

/** An attempt that starts before the call existed or ends after it was over. */
function attemptOutsideStream(
  pkg: EvidencePackage,
  attempts: EvidencePackage["observed"]["attempts"],
): Flag | null {
  const zonedEvents = pkg.observed.timeline.filter((e) => e.zoned);
  if (zonedEvents.length < 2) return null;

  const times = zonedEvents.map((e) => Date.parse(e.at));
  const first = Math.min(...times);
  const last = Math.max(...times);

  for (const a of attempts) {
    if (!a.zoned || !a.startedAt || !a.completedAt) continue;
    const started = Date.parse(a.startedAt);
    const ended = Date.parse(a.completedAt);
    if (started < first - 1000 || ended > last + 1000) {
      return {
        code: "duration_unreliable",
        summary:
          "This attempt is timestamped outside the window the event stream says the call existed in, so the two clocks are not describing the same thing.",
        from: [...a.from, ...(pkg.observed.timeline[0]?.from ?? [])],
        weight: 65,
      };
    }
  }
  return null;
}

/** How long the event stream says the call took, when every event is zoned. */
export function timelineSpanMs(pkg: EvidencePackage): number | null {
  const zoned = pkg.observed.timeline.filter((e) => e.zoned);
  if (zoned.length < 2) return null;
  const times = zoned.map((e) => Date.parse(e.at));
  return Math.max(...times) - Math.min(...times);
}

function attemptSpanMs(attempts: EvidencePackage["observed"]["attempts"]): number | null {
  const usable = attempts.filter((a) => a.zoned && a.startedAt && a.completedAt);
  if (usable.length === 0) return null;
  const starts = usable.map((a) => Date.parse(a.startedAt!));
  const ends = usable.map((a) => Date.parse(a.completedAt!));
  return Math.max(...ends) - Math.min(...starts);
}

export interface DetectOptions extends FlagOptions {
  /** When the request that produced this call was sent. Enables replay detection. */
  requestedAt?: string;
  /** HTTP status of the last create attempt, if there was one. */
  lastResponseStatus?: number;
}

/**
 * Run every detector and return the flags in weight order.
 *
 * Returns a new package rather than mutating, so an evidence package that has
 * been handed to a renderer cannot grow a flag underneath it.
 */
export function withFlags(
  pkg: EvidencePackage,
  opts: DetectOptions = {},
): EvidencePackage {
  const found = [
    detectStuck(pkg, opts),
    detectReplayed(pkg, opts.requestedAt),
    detectRetryUnsafe(pkg, opts.lastResponseStatus),
    detectDurationUnreliable(pkg),
  ].filter((f): f is Flag => f !== null);

  found.sort((a, b) => b.weight - a.weight);
  return { ...pkg, flags: found, flagsComputed: true };
}

