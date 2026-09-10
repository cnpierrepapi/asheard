/**
 * MCP call runs -> the three axes.
 *
 * MCP is the richest of the three surfaces for how a call ended. It is the only
 * one that can say VOICEMAIL or BUSY, and it distinguishes NO_ANSWER from
 * DECLINED from FAILED. Everything the Calls API cannot express about the end
 * of a call, this surface says outright.
 *
 * It is also the poorest for results. MCP has no result_schema input, so there
 * is no structured result to validate and `result_state` is always
 * `not_requested` here. Anything typed has to be pulled out of the transcript
 * afterwards, downstream of this mapping.
 *
 * Two spellings quirks are handled rather than tidied away, because both appear
 * in the published terminal set: CANCELED and CANCELLED are both valid, and
 * NO_ANSWER also arrives as "NO ANSWER" with a space.
 */

import {
  type AxisReading,
  type Disposition,
  type Endstate,
  type ResultState,
  type TaskOutcome,
  reviewFlags,
} from "../axes.js";

/** Terminal statuses published in the MCP guide. Both cancel spellings are real. */
export const MCP_TERMINAL_STATUSES = [
  "COMPLETED",
  "FAILED",
  "NO_ANSWER",
  "DECLINED",
  "CANCELED",
  "CANCELLED",
  "VOICEMAIL",
  "BUSY",
  "EXPIRED",
] as const;

const ENDSTATE_BY_STATUS: Record<string, Endstate> = {
  COMPLETED: "answered_human",
  FAILED: "provider_failed",
  NO_ANSWER: "no_answer",
  DECLINED: "declined",
  CANCELED: "canceled",
  CANCELLED: "canceled",
  VOICEMAIL: "answered_machine",
  BUSY: "busy",
  EXPIRED: "expired",
};

/** Fold the spelling variants onto one key before lookup. */
export function canonicalMcpStatus(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const squashed = raw.trim().toUpperCase().replace(/\s+/g, "_");
  return squashed === "" ? null : squashed;
}

export function isMcpTerminal(raw: string | null | undefined): boolean {
  const status = canonicalMcpStatus(raw);
  return status !== null && status in ENDSTATE_BY_STATUS;
}

export interface McpRunPayload {
  run_id?: string;
  status?: string | null;
  activity?: Array<{ ts?: string; message?: string }> | null;
  transcript?: string | Array<unknown> | null;
  summary?: string | null;
  post_summary?: string | null;
  next_step?: string | null;
}

function mapEndstate(payload: McpRunPayload): AxisReading<Endstate> {
  const status = canonicalMcpStatus(payload.status);

  if (status === null) {
    return {
      value: "unknown",
      basis: "absent",
      from: ["status"],
      note: "The run carries no status.",
    };
  }

  const mapped = ENDSTATE_BY_STATUS[status];

  if (!mapped) {
    return {
      value: "unknown",
      basis: "absent",
      from: ["status"],
      note: `Status "${payload.status}" is not in the published terminal set, so this run is still going. The MCP guide says to follow next_step rather than read terminality from elapsed time.`,
    };
  }

  if (status === "COMPLETED") {
    return {
      value: "answered_human",
      basis: "quoted",
      from: ["status"],
      note: "Status is COMPLETED. The MCP guide is explicit that this means the run completed and not that the task succeeded, so it is read here only as a person having answered.",
    };
  }

  return {
    value: mapped,
    basis: "quoted",
    from: ["status"],
    note: `Status is ${status}.`,
  };
}

function mapTaskOutcome(payload: McpRunPayload): AxisReading<TaskOutcome> {
  const status = canonicalMcpStatus(payload.status);

  if (status && status in ENDSTATE_BY_STATUS && status !== "COMPLETED") {
    return {
      value: "not_met",
      basis: "quoted",
      from: ["status"],
      note: `Status ${status} is terminal and not successful, so the task was not done.`,
    };
  }

  return {
    value: "unverified",
    basis: "absent",
    from: ["status"],
    note: "MCP carries no task-completion judgment. COMPLETED means the run finished, not that the objective was met, so this has to be decided against the summary and transcript by the workflow's own criteria.",
  };
}

function mapResultState(_payload: McpRunPayload): AxisReading<ResultState> {
  return {
    value: "not_requested",
    basis: "absent",
    from: [],
    note: "MCP has no result_schema input, so no structured result is ever asked for or returned on this surface. Typed output has to be extracted from the transcript downstream.",
  };
}

export function normalizeMcpRun(payload: McpRunPayload): Disposition {
  const endstate = mapEndstate(payload);
  const taskOutcome = mapTaskOutcome(payload);
  const resultState = mapResultState(payload);
  const { needsHuman, reasons } = reviewFlags(endstate, taskOutcome, resultState);

  return { surface: "mcp", endstate, taskOutcome, resultState, needsHuman, reasons };
}
