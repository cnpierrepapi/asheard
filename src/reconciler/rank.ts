/**
 * What goes first, and what gets collapsed.
 *
 * Wording is the easy half of a briefing. Get the order wrong and no amount of
 * good prose saves it, because the thing that costs money is sitting under a
 * fold. So the order is a declared table rather than a sort comparator nobody
 * can argue with.
 *
 * The rule behind the table: rank by what it costs you to ignore it, not by how
 * broken it looks. A call nobody is watching outranks a call that ended in a way
 * we cannot name, because the first one is still happening and the second one is
 * over.
 *
 * The last band is the point of the whole file. Most calls are fine. A briefing
 * that lists forty fine calls has buried the three that are not, so the fine
 * ones collapse into a single line and stop competing for attention.
 */

import type { EvidencePackage } from "./evidence.js";
import { CONVERSATIONAL_ENDSTATES } from "../disposition/axes.js";

/** The bands, most urgent first. Index is the rank. */
export const BANDS = [
  {
    code: "unwatched",
    /** Shown as a group heading when a band has more than one call in it. */
    heading: "Nobody is watching these",
  },
  {
    code: "maybe_twice",
    heading: "These may have gone out twice",
  },
  {
    code: "false_done",
    heading: "These say the job is done",
  },
  {
    code: "unsourced_result",
    heading: "These returned an answer nobody gave",
  },
  {
    code: "clock_disagrees",
    heading: "The timings on these do not add up",
  },
  {
    code: "ending_unclear",
    heading: "How these ended is not recorded",
  },
  {
    code: "as_expected",
    heading: "Behaved as expected",
  },
] as const;

export type BandCode = (typeof BANDS)[number]["code"];

export interface Ranked {
  pkg: EvidencePackage;
  band: BandCode;
  /** Position in BANDS. Lower is more urgent. */
  rank: number;
  /** The single fact that put it in this band, sourced. */
  because: { summary: string; from: string[] };
}

function bandIndex(code: BandCode): number {
  return BANDS.findIndex((b) => b.code === code);
}

/**
 * Decide one call's band.
 *
 * First match wins, top down, which is what makes this readable. A call can be
 * stuck and have a bad clock at the same time; it is reported as stuck, because
 * that is the one that needs somebody today. The rest is still in the package
 * for anybody who opens it.
 */
export function classify(pkg: EvidencePackage): Ranked {
  if (!pkg.flagsComputed) {
    throw new Error(
      "This evidence package has not been through the detectors, so an empty flag list would be read as nothing wrong. Call withFlags() first.",
    );
  }
  const flag = (code: string) => pkg.flags.find((f) => f.code === code);

  const stuck = flag("stuck");
  if (stuck) {
    return mk(pkg, "unwatched", stuck.summary, stuck.from);
  }

  const replayed = flag("replayed") ?? flag("retry_unsafe");
  if (replayed) {
    return mk(pkg, "maybe_twice", replayed.summary, replayed.from);
  }

  // The pairing that costs money: the payload claims the job is done on a call
  // where nothing establishes a person was ever on the line.
  const { endstate, taskOutcome, resultState } = pkg.read;
  if (
    taskOutcome.value === "met" &&
    !CONVERSATIONAL_ENDSTATES.includes(endstate.value)
  ) {
    return mk(
      pkg,
      "false_done",
      "The job is reported done, and nothing here says a person was on the line.",
      [...taskOutcome.from, ...endstate.from],
    );
  }

  if (resultState.value === "unsourced") {
    return mk(
      pkg,
      "unsourced_result",
      "An answer came back from a call where nobody spoke.",
      [...resultState.from],
    );
  }

  const clock = flag("duration_unreliable");
  if (clock) {
    return mk(pkg, "clock_disagrees", clock.summary, clock.from);
  }

  if (endstate.value === "unknown" || endstate.basis === "derived") {
    const summary =
      endstate.value === "unknown"
        ? "Nothing in this call says how it ended."
        : "How this ended was worked out rather than stated.";
    return mk(pkg, "ending_unclear", summary, [...endstate.from]);
  }

  return mk(pkg, "as_expected", "Nothing here needs anybody.", [
    ...endstate.from,
  ]);
}

function mk(
  pkg: EvidencePackage,
  band: BandCode,
  summary: string,
  from: string[],
): Ranked {
  return {
    pkg,
    band,
    rank: bandIndex(band),
    because: { summary, from: from.length > 0 ? from : ["read"] },
  };
}

export interface Group {
  band: BandCode;
  heading: string;
  items: Ranked[];
}

export interface Briefing {
  total: number;
  /** Calls somebody has to look at. Everything outside `as_expected`. */
  needing: number;
  /** Groups in band order. Empty bands are dropped. */
  groups: Group[];
  /** The `as_expected` group, kept separate because it renders as one line. */
  routine: Ranked[];
}

/**
 * Rank a batch and collapse the boring majority.
 *
 * Order inside a band is the order you handed them over. Nothing here invents a
 * secondary sort, because a stable order lets somebody work down a list across
 * two sittings without it reshuffling under them.
 */
export function rankBatch(packages: EvidencePackage[]): Briefing {
  const ranked = packages.map(classify);
  const groups: Group[] = [];

  for (const band of BANDS) {
    if (band.code === "as_expected") continue;
    const items = ranked.filter((r) => r.band === band.code);
    if (items.length > 0) {
      groups.push({ band: band.code, heading: band.heading, items });
    }
  }

  const routine = ranked.filter((r) => r.band === "as_expected");

  return {
    total: ranked.length,
    needing: ranked.length - routine.length,
    groups,
    routine,
  };
}
