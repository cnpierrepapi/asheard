/**
 * Match a terminal payload back to the intent that authorized it, then read it.
 *
 * A terminal status is not permission to act. Before a result is allowed to
 * move anything in your system it has to be the result of the call you actually
 * authorized, to the number you actually approved, under the contract version
 * you were expecting. Those checks come first. The disposition comes second.
 *
 * When a check fails the intent goes to needs_human and stays there. There is
 * no branch in this file that recovers a mismatch automatically, because a
 * payload that does not match its intent is either a bug or somebody else's
 * call, and neither should quietly update a record.
 */

import type { Disposition } from "../disposition/axes.js";
import { normalize } from "../disposition/normalize.js";
import type { AnyPayload } from "../disposition/normalize.js";
import { type Intent, maskDestination } from "./intent.js";
import type { IntentStore } from "./store.js";

export interface BindingCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * Why a payload was never read.
 *
 * When a binding check fails we stop before parsing, and the operator sees a
 * record with no disposition on it. Without this, that reads as the system
 * having nothing to say. It has plenty to say: it refused, and here is why.
 *
 * `summary` is written to be rendered straight into a review queue with no
 * further wording. `code` is there so a UI can filter or badge on it.
 */
export interface NotRead {
  code: "binding_failed";
  summary: string;
  failedChecks: BindingCheck[];
}

export interface Reconciliation {
  intentId: string;
  checks: BindingCheck[];
  /** Present only when every binding check passed. */
  disposition: Disposition | null;
  /**
   * Present only when the payload was refused before being parsed. Exactly one
   * of `disposition` and `notRead` is set on any reconciliation.
   */
  notRead: NotRead | null;
  /** What the intent moved to. */
  state: Intent["state"];
  reasons: string[];
}

/** Plain sentence per failed check, in the words an operator needs. */
const REFUSAL_WORDING: Record<string, string> = {
  "call-id": "It came back for a different call than the one this record authorized.",
  destination: "The call went to a number nobody approved.",
  "authorization-window": "Permission to make this call had already run out.",
};

function describeRefusal(failed: BindingCheck[]): NotRead {
  const sentences = failed.map(
    (check) => REFUSAL_WORDING[check.name] ?? `The ${check.name} check did not pass.`,
  );

  return {
    code: "binding_failed",
    summary: `This result was not read. ${sentences.join(" ")} Nothing here has been applied, and the reading was never attempted, so treat the call itself as still unaccounted for.`,
    failedChecks: failed,
  };
}

function readId(payload: Record<string, unknown>): string | null {
  for (const key of ["id", "run_id", "call_id"]) {
    const value = payload[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function readDestinations(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  const recipients = payload.recipients;
  if (Array.isArray(recipients)) {
    for (const recipient of recipients) {
      const phones = (recipient as { phones?: unknown }).phones;
      if (Array.isArray(phones)) {
        for (const phone of phones) if (typeof phone === "string") out.push(phone);
      }
    }
  }
  const phone = payload.phone;
  if (typeof phone === "string") out.push(phone);
  return out;
}

/**
 * Run the binding checks.
 *
 * A check that cannot be run is not a check that passed. Where a surface does
 * not echo a field back, the check records that it could not be made, and that
 * counts as a failure for anything consequential.
 */
export function runBindingChecks(intent: Intent, payload: AnyPayload): BindingCheck[] {
  const raw = payload as Record<string, unknown>;
  const checks: BindingCheck[] = [];

  const returnedId = readId(raw);
  if (intent.boundId === null) {
    checks.push({
      name: "call-id",
      passed: false,
      detail: "The intent was never bound to a call id, so this payload cannot be tied to it.",
    });
  } else if (returnedId === null) {
    checks.push({
      name: "call-id",
      passed: false,
      detail: "The payload carries no id to compare against the bound call.",
    });
  } else {
    checks.push({
      name: "call-id",
      passed: returnedId === intent.boundId,
      detail:
        returnedId === intent.boundId
          ? `Payload id matches the bound call ${intent.boundId}.`
          : `Payload id ${returnedId} is not the bound call ${intent.boundId}.`,
    });
  }

  const destinations = readDestinations(raw);
  if (destinations.length === 0) {
    checks.push({
      name: "destination",
      passed: intent.channel === "goal-runs" || intent.channel === "mcp",
      detail:
        intent.channel === "goal-runs"
          ? "Goal Runs never echoes the phone back, so the destination is carried by the intent alone. Nothing to compare, and nothing contradicts it."
          : intent.channel === "mcp"
            ? "MCP run reads do not echo the approved destination, so the intent is the only record of it."
            : "The payload carries no destination to compare against the approved one.",
    });
  } else {
    const approved = intent.authorization.destination;
    const matched = destinations.includes(approved);
    checks.push({
      name: "destination",
      passed: matched,
      detail: matched
        ? `The payload called the approved number ${maskDestination(approved)}.`
        : `The payload called ${destinations.map(maskDestination).join(", ")}, which is not the approved ${maskDestination(approved)}.`,
    });
  }

  const notAfter = intent.authorization.notAfter;
  if (notAfter) {
    const stillValid = Date.now() <= Date.parse(notAfter);
    checks.push({
      name: "authorization-window",
      passed: stillValid,
      detail: stillValid
        ? `The authorization is valid until ${notAfter}.`
        : `The authorization expired at ${notAfter}.`,
    });
  }

  return checks;
}

/**
 * Verify a terminal payload against its intent and record what came of it.
 *
 * Passing every check does not mean the call succeeded. It means the payload is
 * genuinely about this call, so the disposition it produces can be trusted to
 * be about this call too. Whether the disposition is good enough to act on is a
 * separate decision, and `disposition.needsHuman` carries it.
 */
export async function reconcile(
  store: IntentStore,
  intentId: string,
  payload: AnyPayload,
): Promise<Reconciliation> {
  const intent = await store.get(intentId);
  if (!intent) throw new Error(`No intent ${intentId}.`);

  const checks = runBindingChecks(intent, payload);
  const failed = checks.filter((check) => !check.passed);

  if (failed.length > 0) {
    const notRead = describeRefusal(failed);
    const reasons = [
      notRead.summary,
      ...failed.map((check) => `Binding check ${check.name} failed. ${check.detail}`),
    ];
    const updated = await store.advance(intentId, "needs_human", { reasons });
    return { intentId, checks, disposition: null, notRead, state: updated.state, reasons };
  }

  const disposition = normalize(payload, intent.channel);

  if (disposition.needsHuman) {
    const updated = await store.advance(intentId, "needs_human", { reasons: disposition.reasons });
    return {
      intentId,
      checks,
      disposition,
      notRead: null,
      state: updated.state,
      reasons: disposition.reasons,
    };
  }

  const updated = await store.advance(intentId, "terminal_verified");
  return { intentId, checks, disposition, notRead: null, state: updated.state, reasons: [] };
}
