/**
 * The words.
 *
 * Every sentence in here is a function of a reading. Nothing is generated,
 * nothing is scored, and no model is asked what it thinks. That is not a
 * performance choice, it is what makes the output testable: a clause can be
 * pointed at in code, it says the same thing every time, and it cannot wander
 * halfway through a demo.
 *
 * Four slots, and a line uses only the ones that apply:
 *
 *   ending   how the call finished
 *   outcome  whether the job got done
 *   doubt    what nobody can vouch for
 *   action   the one clause allowed to tell you to do something
 *
 * Two rules hold the register together. At most two clauses in a briefing line,
 * because a third one turns a sentence into a paragraph and people stop reading
 * paragraphs. And never stack doubts: pick the most serious and drop the rest,
 * since three hedges in a row reads as a system that is unsure of itself rather
 * than one being careful.
 */

import type { Endstate, TaskOutcome } from "../disposition/axes.js";
import type { EvidencePackage } from "./evidence.js";
import type { BandCode, Ranked } from "./rank.js";

/** How the call finished, in the words somebody would actually use. */
export const ENDING_CLAUSES: Record<Endstate, string> = {
  answered_human: "A person picked up.",
  answered_machine: "A recording picked up.",
  answered_unspecified: "Something picked up.",
  no_answer: "Nobody picked up.",
  busy: "The line was busy.",
  declined: "The call was refused.",
  unreachable: "The number could not be reached.",
  provider_failed: "The call never made it out.",
  canceled: "The call was stopped before it finished.",
  expired: "The call ran out of time before it finished.",
  unknown: "How this call ended is not recorded.",
};

/** Whether the thing the call was for actually happened. */
export const OUTCOME_CLAUSES: Record<TaskOutcome, string> = {
  met: "The job was reported done.",
  not_met: "The job was not done.",
  unverified: "Nothing here says whether the job got done.",
};

/**
 * Doubts, most serious first.
 *
 * Order matters because only one is ever used. The first entry whose test
 * passes wins, so the list is the priority, and moving a line up or down here
 * changes what an operator reads first.
 */
const DOUBTS: { test: (pkg: EvidencePackage) => boolean; clause: string }[] = [
  {
    // The pairing that costs money. It goes first for that reason alone.
    test: (p) =>
      p.read.taskOutcome.value === "met" &&
      p.read.endstate.value !== "answered_human",
    clause: "Nobody can say a person was on the line.",
  },
  {
    test: (p) => p.read.resultState.value === "unsourced",
    clause: "Nothing anybody said produced that answer.",
  },
  {
    test: (p) => p.read.resultState.value === "schema_invalid",
    clause: "The answer that came back was the wrong shape.",
  },
  {
    test: (p) => p.read.resultState.value === "null",
    clause: "An answer was asked for and none came back.",
  },
  {
    test: (p) => p.read.endstate.basis === "derived",
    clause: "That was worked out rather than stated.",
  },
];

/** The one clause allowed to be an instruction. */
export const ACTION_CLAUSES: Record<BandCode, string | null> = {
  unwatched: "Nobody is watching this one.",
  maybe_twice: "Check before calling again.",
  false_done: "Check this before you act on it.",
  unsourced_result: "Check this before you act on it.",
  clock_disagrees: null,
  ending_unclear: null,
  as_expected: "Safe to act on.",
};

export interface Clauses {
  ending: string;
  outcome: string;
  doubt: string | null;
  action: string | null;
}

/** Build all four slots. Selection happens later, so nothing is lost here. */
export function clausesFor(ranked: Ranked): Clauses {
  const { pkg, band } = ranked;
  const doubt = DOUBTS.find((d) => d.test(pkg))?.clause ?? null;

  return {
    ending: ENDING_CLAUSES[pkg.read.endstate.value],
    outcome: OUTCOME_CLAUSES[pkg.read.taskOutcome.value],
    doubt,
    action: ACTION_CLAUSES[band],
  };
}

/**
 * Which two clauses a briefing line gets.
 *
 * Picked per band rather than by a general rule, because the interesting half
 * of a line is different for each one. A stuck call has no ending worth
 * printing, since it has not ended. A falsely completed call has an ending that
 * matters enormously, because the ending is the thing contradicting the claim.
 */
function pickTwo(band: BandCode, c: Clauses): string[] {
  switch (band) {
    case "unwatched":
      // It has not ended, so the ending clause would be noise.
      return keep([c.action]);
    case "maybe_twice":
      return keep([c.action]);
    case "false_done":
      // The contradiction is the whole point: claim next to ending.
      return keep([c.outcome, c.doubt ?? c.ending]);
    case "unsourced_result":
      return keep([c.ending, c.doubt]);
    case "clock_disagrees":
      return keep([c.ending, c.outcome]);
    case "ending_unclear":
      return keep([c.ending, c.doubt]);
    case "as_expected":
      return keep([c.ending, c.outcome]);
  }
}

function keep(parts: (string | null)[]): string[] {
  return parts.filter((p): p is string => p !== null && p.length > 0).slice(0, 2);
}

export interface Phrased {
  /** One line, ready to render. Never more than two clauses. */
  line: string;
  /** Every slot, for a detail view that has room for more. */
  clauses: Clauses;
  /** The flag summaries, already plain English, for the expanded view. */
  notes: string[];
}

/** Phrase one ranked call. */
export function phrase(ranked: Ranked): Phrased {
  const clauses = clausesFor(ranked);
  return {
    line: pickTwo(ranked.band, clauses).join(" "),
    clauses,
    notes: ranked.pkg.flags.map((f) => f.summary),
  };
}

/**
 * The top line of a briefing.
 *
 * Written to a decision, not to a statistic. "Three of these need you today" is
 * something somebody can act on. "25% require review" is a number they have to
 * translate first, and translating is work nobody does at eight in the morning.
 *
 * Counts are spelled in words up to twelve, and there are no percentages
 * anywhere in this file on purpose.
 */
export function headline(needing: number, total: number): string {
  if (total === 0) return "No calls to go through.";
  if (needing === 0) {
    return total === 1
      ? "One call, and it looks fine."
      : `All ${word(total)} look fine.`;
  }
  if (needing === total) {
    return needing === 1
      ? "One call, and it needs you."
      : `All ${word(total)} need you.`;
  }
  const verb = needing === 1 ? "needs" : "need";
  return `${cap(word(needing))} of ${word(total)} ${verb} you today.`;
}

/** The quiet second line. Says what was left out, so nothing is hidden. */
export function subline(routineCount: number): string | null {
  if (routineCount === 0) return null;
  return routineCount === 1
    ? "One behaved as expected."
    : `${cap(word(routineCount))} behaved as expected.`;
}

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

function word(n: number): string {
  return n >= 0 && n < WORDS.length ? WORDS[n]! : String(n);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
