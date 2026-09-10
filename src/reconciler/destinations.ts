/**
 * The only numbers a demo is allowed to dial.
 *
 * A page that can dial an arbitrary number is a page that will eventually dial
 * somebody's grandmother, so the list is fixed here rather than accepted from a
 * form. Nothing in the app can add to it, and the check runs server side where a
 * browser cannot reach it.
 *
 * Every entry has to clear the same bar: it exists to be called, it answers or
 * refuses without a person being involved, and what it does is knowable before
 * you dial. That last part is what makes the demo worth watching, because the
 * expected ending is printed on screen before the call goes out and then the
 * platform is measured against it.
 */

/**
 * Real numbers do not live in this file.
 *
 * The two published speaking clocks are genuinely dialable, and a repository
 * that ships a dialable number is shipping something a reviewer has to take on
 * trust. So the built-in list is fiction only, and an operator who wants the
 * clocks supplies them through the environment on their own deployment.
 *
 * Set ASHEARD_EXTRA_DESTINATIONS to a JSON array of
 * { id, label, e164, expectation, why, task } to add your own. They still have
 * to clear the same bar: the line exists to be called, nothing human answers
 * it, and what it does is knowable before you dial.
 */

/** What the destination is expected to do, in words, before the call is placed. */
export interface Destination {
  id: string;
  label: string;
  /** E.164. Public, published, and safe to print. */
  e164: string;
  /** What happens when you ring it, known in advance. */
  expectation: string;
  /**
   * Why nobody is bothered by this ringing.
   *
   * Printed in the UI. A demo that dials a phone should say out loud whose
   * phone it is, and none of these belong to a person.
   */
  why: string;
  /** The question the agent asks. Kept short: a recording will not wait. */
  task: string;
}

const BUILT_IN: readonly Destination[] = [
  {
    id: "reserved-fiction",
    label: "A number that belongs to nobody",
    e164: "+13035550100",
    expectation: "It cannot be reached. Nothing rings, because nothing is there.",
    why: "555-0100 through 555-0199 are held back for fiction in every North American area code and are assigned to no subscriber, so this is a controlled failure with the answer known in advance. It is a US area code because Canadian destinations are refused outright.",
    task: "Ask whether the line is open on Saturday.",
  },
];

function fromEnvironment(): Destination[] {
  const raw = process.env.ASHEARD_EXTRA_DESTINATIONS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const d = entry as Record<string, unknown>;
    const text = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
    const e164 = text("e164");
    // E.164, and never a Canadian destination, which CALL-E refuses at creation.
    if (!/^\+[1-9]\d{7,14}$/.test(e164)) return [];
    if (text("id") === "" || text("task") === "") return [];
    return [
      {
        id: text("id"),
        label: text("label") || text("id"),
        e164,
        expectation: text("expectation"),
        why: text("why"),
        task: text("task"),
      },
    ];
  });
}

export const DESTINATIONS: readonly Destination[] = [...BUILT_IN, ...fromEnvironment()];

/** Look one up. Returns null rather than throwing, so a bad id is a 400 not a 500. */
export function destinationById(id: string): Destination | null {
  return DESTINATIONS.find((d) => d.id === id) ?? null;
}

/**
 * The guard.
 *
 * Takes whatever arrived from the browser and answers one question: is this
 * exactly one of ours. It compares the resolved number rather than trusting the
 * id, so a request that carries a real id and a substituted number is refused.
 */
export function isAllowedDestination(e164: string): boolean {
  return DESTINATIONS.some((d) => d.e164 === e164);
}
