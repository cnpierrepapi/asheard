/**
 * One entry point over the three surfaces.
 *
 * Detection is deliberately conservative. When a payload does not clearly
 * belong to one surface we refuse it rather than picking the closest match,
 * because guessing the surface means guessing the mapping table, and a wrong
 * table produces a confident wrong answer.
 */

import type { Disposition, Surface } from "./axes.js";
import { type CallsApiPayload, normalizeCallsApi } from "./surfaces/calls-api.js";
import { type GoalRunPayload, normalizeGoalRun } from "./surfaces/goal-runs.js";
import { type McpRunPayload, canonicalMcpStatus, normalizeMcpRun } from "./surfaces/mcp.js";

export type AnyPayload = CallsApiPayload | GoalRunPayload | McpRunPayload;

const CALLS_API_STATUSES = new Set(["queued", "in_progress", "completed", "failed", "canceled"]);

export class UnknownSurfaceError extends Error {
  readonly checked: string[];
  constructor(checked: string[]) {
    super(
      "Could not tell which CALL-E surface this payload came from. " +
        "Pass the surface explicitly rather than letting it be guessed.",
    );
    this.name = "UnknownSurfaceError";
    this.checked = checked;
  }
}

/** Work out which surface a payload came from, or return null. */
export function detectSurface(payload: Record<string, unknown>): Surface | null {
  if (payload.object === "goal_run") return "goal-runs";
  if (payload.object === "call_task") return "calls-api";

  const hasGoalId = typeof payload.goal_id === "string";
  const hasRunId = typeof payload.run_id === "string";
  const status = typeof payload.status === "string" ? payload.status : null;

  // A Goal Run always names its Goal.
  if (hasGoalId) return "goal-runs";

  // MCP statuses are upper case and MCP runs have a run_id and no Goal.
  if (hasRunId && status !== null && status === status.toUpperCase() && /[A-Z]/.test(status)) {
    return "mcp";
  }

  // Calls API statuses are lower case, and the surface has fields no other has.
  if (status !== null && CALLS_API_STATUSES.has(status)) return "calls-api";
  if ("task_completed" in payload || "completion_confidence" in payload) return "calls-api";
  if ("recipients" in payload && Array.isArray(payload.recipients)) return "calls-api";

  // An MCP run mid-flight may carry only a run_id and a non-terminal status.
  if (hasRunId && canonicalMcpStatus(status) !== null) return "mcp";

  return null;
}

/**
 * Normalize a terminal payload from any surface.
 *
 * Pass `surface` when you already know it. Leaving it out asks for detection,
 * which throws rather than guessing when the payload is ambiguous.
 */
export function normalize(payload: AnyPayload, surface?: Surface): Disposition {
  const resolved = surface ?? detectSurface(payload as Record<string, unknown>);

  if (resolved === null || resolved === undefined) {
    throw new UnknownSurfaceError(["object", "goal_id", "run_id", "status", "recipients"]);
  }

  switch (resolved) {
    case "calls-api":
      return normalizeCallsApi(payload as CallsApiPayload);
    case "goal-runs":
      return normalizeGoalRun(payload as GoalRunPayload);
    case "mcp":
      return normalizeMcpRun(payload as McpRunPayload);
  }
}

/**
 * Unwrap a webhook envelope into the call task it carries, keeping the event
 * type so the result axis can tell a validation failure apart from a null.
 */
export function fromWebhookEvent(event: {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
}): Disposition {
  if (!event.data) {
    throw new UnknownSurfaceError(["data"]);
  }
  return normalizeCallsApi({
    ...(event.data as CallsApiPayload),
    webhook_event_type: event.type ?? null,
  });
}

/**
 * The reason an unsigned arrival always carries.
 *
 * Exported so a console can match on it rather than on the wording, which will
 * change.
 */
export const UNSIGNED_REASON =
  "This arrived over a webhook that nobody signed, so it is a claim about a call rather than a reading of one. Anyone who knows the URL can post to it.";

/**
 * Mark a reading as having arrived over a channel that proves nothing.
 *
 * CALL-E webhooks carry no signature and no shared secret. Their own issue #91
 * is open on exactly that. So a payload that arrives at a webhook endpoint has
 * one property nothing in the payload itself can fix: anybody who learned the
 * URL could have sent it, and it would look identical.
 *
 * That is a fact about the channel, not about the call, which is why it is a
 * reason rather than a fourth axis. The three axes describe what happened on
 * the phone. This describes whether to believe the description.
 *
 * It is deliberately not in the headline. Every event through an unsigned
 * webhook would carry the same one, and a headline that is identical on every
 * row stops being read by the second day. It goes first in the reasons, where
 * somebody deciding whether to act on the call will actually meet it.
 *
 * Applied at the call site rather than inside `fromWebhookEvent`, because
 * whether a channel is trusted is something only the caller knows. A payload
 * pulled from the API and passed through the same unwrapping is not unsigned.
 */
export function unsigned(disposition: Disposition): Disposition {
  if (disposition.reasons.includes(UNSIGNED_REASON)) return disposition;
  return {
    ...disposition,
    needsHuman: true,
    reasons: [UNSIGNED_REASON, ...disposition.reasons],
  };
}
