/**
 * Say what a reading means, in words a person who has never read the docs can
 * act on.
 *
 * This lives in the library rather than in the console on purpose. The sentence
 * is the product. A queue row, a Slack message, an email digest and a webhook
 * consumer all need the same words, and none of them should be reimplementing
 * the priority order below and getting it subtly different.
 *
 * The order matters more than the wording. Whatever is most likely to get
 * somebody hurt goes first, and everything else is context underneath it.
 */

import {
  CONVERSATIONAL_ENDSTATES,
  type Disposition,
  type Endstate,
  type ResultState,
  type TaskOutcome,
} from "./axes.js";

export interface Spoken {
  /** The one thing to read if you read nothing else. */
  headline: string;
  /** The next most useful sentence, or null when the headline says it all. */
  subline: string | null;
  /**
   * `act` means every axis is a stated fact and they agree. Anything else is
   * `review`, and the reasons on the disposition say why.
   */
  verdict: "act" | "review";
}

const ENDING_WORDS: Record<Endstate, string> = {
  answered_human: "A person picked up.",
  answered_machine: "An answering machine took the call.",
  answered_unspecified: "Something picked up.",
  no_answer: "Nobody picked up.",
  busy: "The line was busy.",
  declined: "Somebody picked up and refused the call.",
  unreachable: "The number could not be reached.",
  provider_failed: "The call broke before it reached anybody.",
  canceled: "The call was stopped before it ended on its own.",
  expired: "The call ran out of time before it ended on its own.",
  unknown: "How this call ended is not in the payload.",
};

const OUTCOME_WORDS: Record<TaskOutcome, string> = {
  met: "The job was reported done.",
  not_met: "The job was reported not done.",
  unverified: "Nothing here says whether the job got done.",
};

const RESULT_WORDS: Record<ResultState, string> = {
  valid: "A result came back.",
  null: "A result was asked for and none came back.",
  schema_invalid: "A result came back and failed its own schema.",
  unsourced: "A result came back from a call that never reached a conversation.",
  not_requested: "No result was asked for.",
};

/**
 * Turn a reading into the two sentences worth putting in front of a person.
 *
 * Nothing here invents a fact. Every sentence is a rendering of an axis that
 * was already decided in the mapping, and the priority order is the only
 * judgment being made.
 */
export function say(disposition: Disposition): Spoken {
  const { endstate, taskOutcome, resultState, needsHuman } = disposition;

  const ending = ENDING_WORDS[endstate.value];
  const outcome = OUTCOME_WORDS[taskOutcome.value];
  const result = RESULT_WORDS[resultState.value];

  if (!needsHuman) {
    return { headline: `${ending} ${outcome}`, subline: result, verdict: "act" };
  }

  // A success claimed on a call nobody can vouch for. This is the one that
  // costs money, so it goes first and it says the quiet part.
  if (taskOutcome.value === "met" && !CONVERSATIONAL_ENDSTATES.includes(endstate.value)) {
    return {
      headline: "The job was reported done. Nobody can say a person was on the line.",
      subline: `${ending} ${result}`,
      verdict: "review",
    };
  }

  // A result that nothing sourced. Shaped right, filled from nowhere.
  if (resultState.value === "unsourced") {
    // Lead with the ending when there is one. "The line was busy" is more use
    // to a person than a sentence about provenance, and the provenance still
    // gets said, one line down.
    return {
      headline:
        endstate.value === "unknown"
          ? "A result came back from a call that never connected."
          : `${ending} A result came back from it anyway.`,
      subline:
        "It matches the shape that was asked for, so code checking whether a result arrived will be satisfied by it.",
      verdict: "review",
    };
  }

  if (resultState.value === "schema_invalid") {
    return {
      headline: "A result came back and failed its own schema.",
      subline: `${ending} ${outcome}`,
      verdict: "review",
    };
  }

  if (endstate.value === "unknown") {
    return {
      headline: "How this call ended is not in the payload.",
      subline: `${outcome} ${result}`,
      verdict: "review",
    };
  }

  if (endstate.value === "answered_unspecified") {
    return {
      headline: "Something picked up, and nothing here says whether it was a person.",
      subline: `${outcome} ${result}`,
      verdict: "review",
    };
  }

  if (endstate.basis === "derived") {
    return {
      headline: `${ending} That was worked out, not stated.`,
      subline: `${outcome} ${result}`,
      verdict: "review",
    };
  }

  if (taskOutcome.value === "unverified") {
    return {
      headline: "Nothing here says whether the job got done.",
      subline: `${ending} ${result}`,
      verdict: "review",
    };
  }

  if (resultState.value === "null") {
    return {
      headline: "A result was asked for and none came back.",
      subline: `${ending} ${outcome}`,
      verdict: "review",
    };
  }

  return { headline: `${ending} ${outcome}`, subline: result, verdict: "review" };
}
