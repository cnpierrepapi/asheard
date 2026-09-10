/**
 * Calls API -> the three axes.
 *
 * This is the surface that can say the least, and the mapping is mostly a record
 * of what it cannot express.
 *
 * Two limits drive everything below, and both are stated in CALL-E's own docs:
 *
 *   1. There is no answered-by field. The Calls guide says the API "does not
 *      return a built-in AMD disposition or `answered_by` field" and tells you
 *      to define one yourself in a per-recipient result schema. So a `completed`
 *      call does not tell you whether a person or a voicemail box took it.
 *
 *   2. `failure_code` is a nullable string with no published enum. The errors
 *      guide says to treat it as diagnostic context and not to branch on it, and
 *      that the API "does not guarantee a distinct no-answer or callee-decline
 *      value". All true, and all about the top-level field, which in practice
 *      just repeats the status. The ending is elsewhere: a second failure_code
 *      on the attempt, in a different vocabulary, which does tell no-answer
 *      and busy apart. See ATTEMPT_CODES below.
 *
 *   3. `structured_result` can be filled in on calls that never connected. A
 *      call that rang out unanswered can come back `failed` with a
 *      schema-shaped result object, its required `evidence` field an empty
 *      string. So the presence of a result proves the shape and nothing
 *      about whether anybody spoke, which is why a result on a non-completed
 *      call reads `unsourced` here rather than `valid`.
 *
 * Where an app has declared its own answered-by field we read it, and say so.
 * Everything else stays `unknown` rather than being guessed.
 */

import {
  type AxisReading,
  type Disposition,
  type Endstate,
  type ResultState,
  type TaskOutcome,
  reviewFlags,
} from "../axes.js";

/** Property names an app may have used for its own answered-by classification. */
const ANSWERED_BY_KEYS = ["answered_by", "answeredBy", "final_endpoint", "picked_up_by"];

/** Values we accept from an app-declared answered-by field, lowercased. */
const ANSWERED_BY_HUMAN = new Set(["human", "person", "live", "agent"]);
const ANSWERED_BY_MACHINE = new Set(["voicemail", "machine", "answering_machine", "vm"]);
const ANSWERED_BY_IVR = new Set(["ivr", "menu", "auto_attendant"]);

export interface CallsApiPayload {
  id?: string;
  object?: string;
  status?: string;
  task_completed?: boolean | null;
  completion_confidence?: { score?: number; label?: string } | null;
  structured_result?: Record<string, unknown> | null;
  recipients?: Array<{
    status?: string;
    structured_result?: Record<string, unknown> | null;
    attempts?: Array<{
      status?: string;
      failure_code?: string | null;
      transcript_turns?: Array<{ speaker?: string; text?: string; offset_seconds?: number }>;
    }>;
  }> | null;
  failure_code?: string | null;
  failure_message?: string | null;
  /** Set when the payload arrived as a webhook rather than a direct read. */
  webhook_event_type?: string | null;
  /** Set by the caller when it knows a result schema was sent with the request. */
  result_schema_requested?: boolean;
}

function readAnsweredBy(payload: CallsApiPayload): { value: string; from: string } | null {
  const sources: Array<[Record<string, unknown> | null | undefined, string]> = [
    [payload.structured_result, "structured_result"],
  ];
  (payload.recipients ?? []).forEach((recipient, index) => {
    sources.push([recipient.structured_result, `recipients[${index}].structured_result`]);
  });

  for (const [object, path] of sources) {
    if (!object) continue;
    for (const key of ANSWERED_BY_KEYS) {
      const raw = object[key];
      if (typeof raw === "string" && raw.trim() !== "") {
        return { value: raw.trim().toLowerCase(), from: `${path}.${key}` };
      }
    }
  }
  return null;
}

/**
 * Attempt-level failure codes, and what live calls showed them to mean.
 *
 * This is a second `failure_code`, sitting on the attempt, in a different
 * vocabulary from the top-level one. The numbers look like SIP response codes
 * and the ones observed behave like them, but nothing published says so, which
 * is why only codes that have actually been watched happen are in this table.
 *
 *   408  the line rang out and nobody picked up
 *   486  the line was busy and the call stopped almost at once
 *   404  a number in the range reserved for fiction, assigned to no subscriber,
 *        in a US area code. Nothing rang. This is a controlled test rather than
 *        a call that happened to fail: the number cannot be reached by
 *        construction, so what came back is what "cannot be reached" looks like.
 *   403  the same shape, but observed on a Canadian number, and that matters.
 *
 * The 403 reading needs a correction rather than a footnote. It was recorded on
 * 4 September against a 226 number, and CALL-E now refuses Canadian
 * destinations outright at creation time with `422 unsupported_region`. So the
 * 403 was plausibly a region refusal rather than an unassigned number, and the
 * two are not the same thing even though both end the call before it rings.
 * Both still resolve to `unreachable` here, because that is the honest reading
 * of "the call never got to the destination", but the note said more than the
 * evidence supported and now it does not.
 *
 * Worth keeping in view: two unreachable destinations produced two different
 * codes. Whatever this field is, it is not a stable one-to-one map onto an
 * ending, which is the reason the basis on this reading is never `quoted`.
 */
const ATTEMPT_CODES: Record<string, Endstate> = {
  "408": "no_answer",
  "486": "busy",
  "403": "unreachable",
  "404": "unreachable",
};

/** Does any attempt carry a transcript array at all? */
function hasTranscript(payload: CallsApiPayload): boolean {
  return (payload.recipients ?? []).some((recipient) =>
    (recipient.attempts ?? []).some((attempt) => Array.isArray(attempt.transcript_turns)),
  );
}

/** How many turns in the whole call came from the person on the other end. */
function countUserTurns(payload: CallsApiPayload): number {
  let turns = 0;
  for (const recipient of payload.recipients ?? []) {
    for (const attempt of recipient.attempts ?? []) {
      for (const turn of attempt.transcript_turns ?? []) {
        if (turn.speaker === "user") turns += 1;
      }
    }
  }
  return turns;
}

/** Pull the attempt-level code out of the first attempt that carries one. */
function readAttemptCode(
  payload: CallsApiPayload,
): { code: string; from: string } | null {
  const recipients = payload.recipients ?? [];
  for (const [r, recipient] of recipients.entries()) {
    for (const [a, attempt] of (recipient.attempts ?? []).entries()) {
      const code = attempt.failure_code ?? "";
      if (code !== "") {
        return { code, from: `recipients[${r}].attempts[${a}].failure_code` };
      }
    }
  }
  return null;
}

function mapEndstate(payload: CallsApiPayload): AxisReading<Endstate> {
  const status = payload.status ?? null;

  if (status === "queued" || status === "in_progress") {
    return {
      value: "unknown",
      basis: "absent",
      from: ["status"],
      note: `The call is still at "${status}" and has not ended.`,
    };
  }

  if (status === "canceled") {
    return {
      value: "canceled",
      basis: "quoted",
      from: ["status"],
      note: "The call task status is canceled.",
    };
  }

  if (status === "failed") {
    const code = payload.failure_code ?? null;

    // The top-level failure_code is a dead end by design, and their errors
    // guide says so. What is not documented is that the ending survives twice
    // more on the same object, at different resolutions.
    //
    // failure_message is the low-resolution one, and it is worse than
    // low-resolution. A call that rang out and a call refused on the spot
    // can both come back with "calling task status=NO ANSWER (Hangup by:
    // bot)", one carrying attempt code 408 and the other 486. Same sentence,
    // two different endings, so the sentence cannot be read as an ending at all.
    //
    // The attempt code is the one worth reading, and only for the values that
    // have actually been watched happen.
    const attempt = readAttemptCode(payload);

    if (attempt) {
      const mapped = ATTEMPT_CODES[attempt.code];
      if (mapped) {
        return {
          value: mapped,
          basis: "derived",
          from: [attempt.from],
          note: `The attempt carries its own failure_code "${attempt.code}", a different vocabulary from the top-level "${code ?? "nothing"}", and that code was observed on a call that ended this way.`,
        };
      }
      return {
        value: "unknown",
        basis: "absent",
        from: [attempt.from],
        note: `The attempt failure_code is "${attempt.code}", which has never been watched happen and has no published meaning, so it is not being turned into an ending.`,
      };
    }

    return {
      value: "unknown",
      basis: "absent",
      from: ["status", "failure_code", "failure_message"],
      note: code
        ? `The call failed with failure_code "${code}", which has no published enum and repeats the status, and no attempt carried a code. failure_message is not read here because it has been observed saying NO ANSWER for a busy line, so no-answer, busy, declined and carrier fault stay indistinguishable.`
        : "The call failed and no failure_code was returned at either level, so no-answer, busy, declined and carrier fault stay indistinguishable here.",
    };
  }

  if (status === "completed") {
    const answeredBy = readAnsweredBy(payload);

    if (answeredBy) {
      const { value, from } = answeredBy;
      if (ANSWERED_BY_HUMAN.has(value)) {
        return {
          value: "answered_human",
          basis: "quoted",
          from: [from],
          note: `The app declared its own answered-by field and it reads "${value}".`,
        };
      }
      // An IVR is not a person, and CALL-E's own description of this field is
      // explicit about it: use `human` only "if an IVR transfers the call to a
      // person". A recorded line can come back `answered_by: "ivr"` with
      // `task_completed: true`, and an earlier
      // version of this branch read that as `answered_human` and cleared the
      // call as safe to act on. That is the exact collapse this library exists
      // to stop, committed here, in the file that complains about it.
      if (ANSWERED_BY_IVR.has(value) || ANSWERED_BY_MACHINE.has(value)) {
        return {
          value: "answered_machine",
          basis: "quoted",
          from: [from],
          note: `The app declared its own answered-by field and it reads "${value}", so something automated took the call rather than a person.`,
        };
      }
      return {
        value: "answered_unspecified",
        basis: "absent",
        from: [from],
        note: `The app declared an answered-by field, but "${value}" is not a value this mapping recognises.`,
      };
    }

    return {
      value: "answered_unspecified",
      basis: "absent",
      from: ["status"],
      note: "The call completed, but the Calls API has no answered-by field and this app did not declare one, so a person and a voicemail box look identical here.",
    };
  }

  return {
    value: "unknown",
    basis: "absent",
    from: ["status"],
    note: status
      ? `Unrecognised call status "${status}".`
      : "The payload carries no call status.",
  };
}

function mapTaskOutcome(payload: CallsApiPayload): AxisReading<TaskOutcome> {
  if (payload.task_completed === true) {
    return {
      value: "met",
      basis: "quoted",
      from: ["task_completed"],
      note: "task_completed is true in the post-call summary.",
    };
  }
  if (payload.task_completed === false) {
    return {
      value: "not_met",
      basis: "quoted",
      from: ["task_completed"],
      note: "task_completed is false in the post-call summary.",
    };
  }
  return {
    value: "unverified",
    basis: "absent",
    from: ["task_completed"],
    note: "The payload carries no task_completed judgment.",
  };
}

function mapResultState(payload: CallsApiPayload): AxisReading<ResultState> {
  if (payload.webhook_event_type === "call.result_validation_failed") {
    return {
      value: "schema_invalid",
      basis: "quoted",
      from: ["webhook_event_type"],
      note: "The webhook event is call.result_validation_failed, so a result was produced and then failed validation.",
    };
  }
  const hasResult =
    payload.structured_result != null && Object.keys(payload.structured_result).length > 0;

  // A completed call where the other side never said a word. The call
  // connects, the agent talks, the transcript holds bot turns and no user
  // turns, and structured_result comes back filled in regardless.
  //
  // This is counted separately from the status check below because the status
  // was "completed" and nothing about it looked wrong. The only thing that
  // gives it away is that nobody spoke, which is a count rather than a guess.
  // A payload with no transcript at all says nothing either way and is left
  // alone.
  if (hasResult && hasTranscript(payload) && countUserTurns(payload) === 0) {
    return {
      value: "unsourced",
      basis: "derived",
      from: ["recipients[0].attempts[0].transcript_turns", "structured_result"],
      note: "A structured result is present and the transcript contains no turns from the other side, so whatever is in the result did not come from anybody speaking.",
    };
  }

  // A result is only worth the word "valid" if a call happened to produce it.
  // CALL-E fills structured_result in on calls that never connected, so shape
  // alone is not evidence that anybody said anything.
  if (hasResult && payload.status !== "completed") {
    return {
      value: "unsourced",
      basis: "derived",
      from: ["status", "structured_result"],
      note: `structured_result is present but the call status is "${payload.status ?? "missing"}", so the object was produced without a conversation behind it.`,
    };
  }

  if (hasResult) {
    return {
      value: "valid",
      basis: "quoted",
      from: ["structured_result"],
      note: "A structured result is present, and CALL-E validates it before returning a terminal call task.",
    };
  }
  if (payload.result_schema_requested === true) {
    return {
      value: "null",
      basis: "quoted",
      from: ["structured_result"],
      note: "A result schema was sent with the request and structured_result came back null.",
    };
  }
  return {
    value: "not_requested",
    basis: "absent",
    from: ["structured_result"],
    note: "structured_result is null and nothing tells us a schema was ever requested, so this may simply be a call that never asked for one.",
  };
}

export function normalizeCallsApi(payload: CallsApiPayload): Disposition {
  const endstate = mapEndstate(payload);
  const taskOutcome = mapTaskOutcome(payload);
  const resultState = mapResultState(payload);
  const { needsHuman, reasons } = reviewFlags(endstate, taskOutcome, resultState);

  return { surface: "calls-api", endstate, taskOutcome, resultState, needsHuman, reasons };
}
