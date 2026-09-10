/**
 * Goal Runs -> the three axes.
 *
 * Goal Runs is the middle surface. Unlike the Calls API it has a real error
 * enum, so `no_answer` and `declined` survive the trip. What it does not have
 * is any way to say voicemail or busy: a machine picking up and a line ringing
 * out arrive here looking the same, and there is no value for an engaged tone
 * at all.
 *
 * The completion rule comes from the Goal Runs guide: stop polling when either
 * `result` or `error` is non-null. `status` describes the telephone execution
 * and can still read `completed` while both are null and CALL-E is parsing.
 */

import {
  type AxisReading,
  type Disposition,
  type Endstate,
  type ResultState,
  type TaskOutcome,
  reviewFlags,
} from "../axes.js";

/** The published Goal Run error codes. Anything outside this set is unrecognised. */
export const GOAL_RUN_ERROR_CODES = [
  "call_failed",
  "no_answer",
  "declined",
  "timed_out",
  "canceled",
  "result_invalid",
  "result_unavailable",
  "result_failed",
] as const;

export type GoalRunErrorCode = (typeof GOAL_RUN_ERROR_CODES)[number];

/** Error codes that describe how the call ended. */
const ENDSTATE_BY_ERROR: Partial<Record<GoalRunErrorCode, Endstate>> = {
  call_failed: "provider_failed",
  no_answer: "no_answer",
  declined: "declined",
  canceled: "canceled",
};

/** Error codes that describe a result problem, leaving the call end unstated. */
const RESULT_ERRORS = new Set<GoalRunErrorCode>([
  "result_invalid",
  "result_unavailable",
  "result_failed",
]);

export interface GoalRunPayload {
  id?: string;
  object?: string;
  goal_id?: string;
  run_id?: string;
  status?: string;
  result?: Record<string, unknown> | null;
  error?: { code?: string; message?: string; detail_code?: string } | null;
  completed_at?: string | null;
}

function isTerminal(payload: GoalRunPayload): boolean {
  return Boolean(payload.result) || Boolean(payload.error);
}

function mapEndstate(payload: GoalRunPayload): AxisReading<Endstate> {
  if (!isTerminal(payload)) {
    return {
      value: "unknown",
      basis: "absent",
      from: ["result", "error"],
      note: `Both result and error are null, so this run is not finished yet whatever status says${
        payload.status ? ` (status reads "${payload.status}")` : ""
      }.`,
    };
  }

  const code = payload.error?.code;

  if (code) {
    const mapped = ENDSTATE_BY_ERROR[code as GoalRunErrorCode];
    if (mapped) {
      return {
        value: mapped,
        basis: "quoted",
        from: ["error.code"],
        note: `The Goal Run error code is "${code}".`,
      };
    }
    if (code === "timed_out") {
      return {
        value: "unknown",
        basis: "absent",
        from: ["error.code"],
        note: "The run timed out, which says the wait ended and not how the call did. A timeout on the caller's side does not cancel the call.",
      };
    }
    if (RESULT_ERRORS.has(code as GoalRunErrorCode)) {
      return {
        value: "unknown",
        basis: "absent",
        from: ["error.code"],
        note: `Error code "${code}" describes a problem producing the result, not how the call ended.`,
      };
    }
    return {
      value: "unknown",
      basis: "absent",
      from: ["error.code"],
      note: `Error code "${code}" is not one of the eight published Goal Run codes.`,
    };
  }

  return {
    value: "answered_human",
    basis: "derived",
    from: ["result"],
    note: "A parsed result came back, which cannot happen without a conversation, so a person answered. Goal Runs never states this outright and has no voicemail or busy value at all.",
  };
}

function mapTaskOutcome(payload: GoalRunPayload): AxisReading<TaskOutcome> {
  if (payload.error) {
    return {
      value: "not_met",
      basis: "quoted",
      from: ["error"],
      note: `The run ended in error "${payload.error.code ?? "unknown"}", so the goal was not achieved.`,
    };
  }
  if (payload.result) {
    return {
      value: "unverified",
      basis: "absent",
      from: ["result"],
      note: "A result came back, but Goal Runs has no task-completion judgment of its own. Whether the goal was met has to be read from the result fields against the workflow's own policy.",
    };
  }
  return {
    value: "unverified",
    basis: "absent",
    from: ["result", "error"],
    note: "The run has not reached a terminal state.",
  };
}

function mapResultState(payload: GoalRunPayload): AxisReading<ResultState> {
  const code = payload.error?.code;

  if (code === "result_invalid" || code === "result_failed") {
    return {
      value: "schema_invalid",
      basis: "quoted",
      from: ["error.code"],
      note: `Error code "${code}" means a result was produced and could not be used.`,
    };
  }
  if (code === "result_unavailable") {
    return {
      value: "null",
      basis: "quoted",
      from: ["error.code"],
      note: "Error code result_unavailable means no result could be produced.",
    };
  }
  if (payload.result && Object.keys(payload.result).length > 0) {
    return {
      value: "valid",
      basis: "quoted",
      from: ["result"],
      note: "A result object came back, shaped by the Goal's published result schema.",
    };
  }
  if (payload.error) {
    return {
      value: "null",
      basis: "derived",
      from: ["error"],
      note: "The run ended in error, so no result was produced.",
    };
  }
  return {
    value: "null",
    basis: "absent",
    from: ["result"],
    note: "No result and no error. The run is still going.",
  };
}

export function normalizeGoalRun(payload: GoalRunPayload): Disposition {
  const endstate = mapEndstate(payload);
  const taskOutcome = mapTaskOutcome(payload);
  const resultState = mapResultState(payload);
  const { needsHuman, reasons } = reviewFlags(endstate, taskOutcome, resultState);

  return { surface: "goal-runs", endstate, taskOutcome, resultState, needsHuman, reasons };
}
