/**
 * What a browser is allowed to see of a call.
 *
 * A page that shows "what the API returned" is tempting to build by handing the
 * raw payload straight to the client. That is what this file exists to stop.
 * The raw object carries destinations and full transcripts, and a response is
 * not a private thing once it has been rendered into somebody's browser.
 *
 * So the view is an allowlist. Fields are copied in by name, one at a time, and
 * anything not named here does not travel. A denylist would only ever know
 * about the fields somebody had already thought of, and providers add fields.
 *
 * The transcript is the clearest case. The count of who spoke is the useful
 * part and the words are the sensitive part, so the count crosses and the words
 * do not.
 */

/** Show enough of a number to recognise it, never enough to dial it. */
export function maskNumber(value: string): string {
  const digits = value.replace(/[^\d+]/g, "");
  if (digits.length <= 5) return "*".repeat(digits.length);
  return `${digits.slice(0, 3)}${"*".repeat(Math.max(0, digits.length - 5))}${digits.slice(-2)}`;
}

/**
 * Mask anything phone-shaped inside free text.
 *
 * Structured results are written by whoever wrote the task, so a result field
 * can quote a number back at you. A recorded line can read its own number out.
 */
export function maskInText(text: string): string {
  return text.replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => maskNumber(m));
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Recursively mask phone-shaped strings in a small JSON value. */
function maskDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (typeof value === "string") return maskInText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => maskDeep(v, depth + 1));
  const record = asRecord(value);
  if (record) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      // Never carry a field whose name says it holds a number.
      if (/phone|msisdn|e164|number|destination|caller/i.test(k)) {
        out[k] = typeof v === "string" ? maskNumber(v) : "[masked]";
        continue;
      }
      out[k] = maskDeep(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return null;
}

export interface PublicAttempt {
  index: number;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  failure_code: string | null;
  /** How many turns, never what was said. */
  transcript_turns: number | null;
}

export interface PublicCallView {
  id: string | null;
  status: string | null;
  task_completed: boolean | null;
  completion_confidence: { score: number | null; label: string | null } | null;
  failure_code: string | null;
  /** Present or not, and the masked content. Never the raw object. */
  structured_result: unknown;
  recipients: Array<{
    status: string | null;
    structured_result: unknown;
    attempts: PublicAttempt[];
  }>;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * Build the only shape of a call this app will send to a browser.
 *
 * Deliberately lossy. If a page needs a field that is not here, add it by name
 * and think about it once, rather than widening the whole object.
 */
export function publicCallView(payload: unknown): PublicCallView {
  const call = asRecord(payload) ?? {};
  const confidence = asRecord(call["completion_confidence"]);

  const recipients = Array.isArray(call["recipients"]) ? call["recipients"] : [];

  return {
    id: str(call["id"]),
    status: str(call["status"]),
    task_completed: bool(call["task_completed"]),
    completion_confidence: confidence
      ? {
          score: typeof confidence["score"] === "number" ? confidence["score"] : null,
          label: str(confidence["label"]),
        }
      : null,
    failure_code: str(call["failure_code"]),
    structured_result:
      call["structured_result"] === undefined ? null : maskDeep(call["structured_result"]),
    recipients: recipients.slice(0, 10).map((raw) => {
      const recipient = asRecord(raw) ?? {};
      const attempts = Array.isArray(recipient["attempts"]) ? recipient["attempts"] : [];
      return {
        status: str(recipient["status"]),
        structured_result:
          recipient["structured_result"] === undefined
            ? null
            : maskDeep(recipient["structured_result"]),
        attempts: attempts.slice(0, 20).map((rawAttempt, index) => {
          const attempt = asRecord(rawAttempt) ?? {};
          const turns = attempt["transcript_turns"];
          return {
            index,
            status: str(attempt["status"]),
            started_at: str(attempt["started_at"]),
            completed_at: str(attempt["completed_at"]),
            failure_code: str(attempt["failure_code"]),
            transcript_turns: Array.isArray(turns) ? turns.length : null,
          };
        }),
      };
    }),
  };
}
