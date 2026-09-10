/**
 * The three axes.
 *
 * A phone call produces three independent facts, and every integration bug we
 * have read in the wild comes from collapsing them into one status field:
 *
 *   1. how the call ended      -> Endstate
 *   2. whether the job got done -> TaskOutcome
 *   3. whether usable data came back -> ResultState
 *
 * A call can end perfectly (`answered_human`) and still fail its task. A task
 * can be met while the structured result comes back null. Keeping the axes
 * apart is the whole point.
 */

/** How the phone call ended. One value per call attempt. */
export const ENDSTATES = [
  /** A person picked up and a conversation happened. */
  "answered_human",
  /** An answering machine, voicemail box, or recorded greeting took the call. */
  "answered_machine",
  /** Something picked up, but the source cannot say whether it was a person. */
  "answered_unspecified",
  /** The line rang out with no pickup. */
  "no_answer",
  /** The line was busy. */
  "busy",
  /** Someone picked up and refused the call. */
  "declined",
  /** The number could not be reached at all: invalid, disconnected, blocked, out of region. */
  "unreachable",
  /** The platform or carrier failed before or during the call. */
  "provider_failed",
  /** The run was stopped by the system or the operator before a natural end. */
  "canceled",
  /** The run aged out before reaching a natural end. */
  "expired",
  /** The source does not carry enough information to say how the call ended. */
  "unknown",
] as const;

export type Endstate = (typeof ENDSTATES)[number];

/** Whether the thing the call was placed to achieve actually happened. */
export const TASK_OUTCOMES = [
  /** The source asserts the objective was accomplished. */
  "met",
  /** The source asserts the objective was not accomplished. */
  "not_met",
  /** The source makes no assertion, or the assertion is not trustworthy on its own. */
  "unverified",
] as const;

export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

/** Whether structured data came back in the shape the caller asked for. */
export const RESULT_STATES = [
  /** A schema-valid structured result is present. */
  "valid",
  /**
   * A schema-shaped result is present on a call that never reached a
   * conversation, so nothing in it was sourced from anybody speaking.
   *
   * Seen, not theorised: a call that rang out unanswered can come back
   * `status: failed` with `structured_result` filled in anyway. The
   * object matched the requested schema. Its required `evidence` field was an
   * empty string, because there was no speech to quote.
   */
  "unsourced",
  /** A schema was requested, but the source returned nothing usable. */
  "null",
  /** A result was produced and then failed validation. */
  "schema_invalid",
  /** No structured result was ever asked for. */
  "not_requested",
] as const;

export type ResultState = (typeof RESULT_STATES)[number];

/** Which CALL-E surface a payload came from. */
export const SURFACES = ["calls-api", "goal-runs", "mcp"] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * How a single axis value was arrived at.
 *
 * `quoted`  the source stated it outright
 * `derived` we inferred it from other fields, and the inference is named in `note`
 * `absent`  the source cannot express this fact at all, so the value is `unknown`
 */
export type Basis = "quoted" | "derived" | "absent";

export interface AxisReading<T> {
  value: T;
  basis: Basis;
  /** The exact source field(s) the reading came from. */
  from: string[];
  /** Plain sentence saying why this value and not another. */
  note: string;
}

export interface Disposition {
  surface: Surface;
  endstate: AxisReading<Endstate>;
  taskOutcome: AxisReading<TaskOutcome>;
  resultState: AxisReading<ResultState>;
  /** True when any axis is `unknown` or rests on a `derived` basis. */
  needsHuman: boolean;
  /** Why `needsHuman` is set, one line per reason. Empty when it is false. */
  reasons: string[];
}

/**
 * Endstates that mean the call reached a human and a conversation took place.
 * Nothing else may be read as an opportunity to have asked the question.
 */
export const CONVERSATIONAL_ENDSTATES: readonly Endstate[] = [
  "answered_human",
];

/** Decide `needsHuman` from the three readings. Fail closed: doubt routes to a person. */
export function reviewFlags(
  endstate: AxisReading<Endstate>,
  taskOutcome: AxisReading<TaskOutcome>,
  resultState: AxisReading<ResultState>,
): { needsHuman: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (endstate.value === "unknown") {
    reasons.push("The source cannot say how the call ended.");
  }
  if (endstate.value === "answered_unspecified") {
    reasons.push(
      "Something answered, but the source cannot say whether it was a person or a machine.",
    );
  }
  if (endstate.basis === "derived") {
    reasons.push(`Endstate was inferred, not stated: ${endstate.note}`);
  }
  if (taskOutcome.value === "unverified") {
    reasons.push("Nothing in the payload establishes whether the task was done.");
  }
  if (taskOutcome.basis === "derived") {
    reasons.push(`Task outcome was inferred, not stated: ${taskOutcome.note}`);
  }
  // The dangerous pairing, and the reason this rule is written down rather than
  // left to the two axes to imply. A call can reach a voicemail box, the bot
  // asks its question into the tone, and the payload comes back
  // task_completed true with a high score and the greeting quoted as evidence. Every axis was read correctly
  // and the combination is still the one that gets somebody hurt.
  if (taskOutcome.value === "met" && !CONVERSATIONAL_ENDSTATES.includes(endstate.value)) {
    reasons.push(
      "The payload says the task was completed, but nothing in it establishes that a person was ever on the line.",
    );
  }
  if (resultState.value === "schema_invalid") {
    reasons.push("A structured result came back and failed validation.");
  }
  if (resultState.value === "null") {
    reasons.push("A structured result was asked for and none came back.");
  }
  if (resultState.value === "unsourced") {
    reasons.push(
      "A structured result came back from a call that never reached a conversation, so nothing in it was sourced from speech.",
    );
  }

  return { needsHuman: reasons.length > 0, reasons };
}
