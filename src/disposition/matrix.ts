/**
 * What each surface can and cannot say about how a call ended.
 *
 * The table is computed by running the mappers, never by writing down what
 * they are believed to do. Every cell below is the answer a mapper actually
 * gave to a probe payload a moment ago, along with the sentence it gave for
 * why. A mapping that stops being able to express an ending changes this table
 * without anybody remembering to come and edit it.
 *
 * That matters more here than in most places. The whole argument of this
 * library is that surfaces claim coverage they do not have. A hand written
 * coverage table would be the same mistake, one level up.
 */

import { ENDSTATES, type AxisReading, type Endstate, type Surface } from "./axes.js";
import { normalizeCallsApi } from "./surfaces/calls-api.js";
import { normalizeGoalRun } from "./surfaces/goal-runs.js";
import { normalizeMcpRun } from "./surfaces/mcp.js";

export type CellKind =
  /** The surface states this ending outright. */
  | "yes"
  /** Only reachable because the application declared its own field. */
  | "app"
  /** Only reachable by inference, never stated. */
  | "derived"
  /** The surface cannot express it, so the reading stays unknown. */
  | "no"
  /** The surface reports this ending as a different one. */
  | "collapsed"
  /** Nothing probes this cell. */
  | "none";

export interface Cell {
  surface: Surface;
  ending: Endstate;
  kind: CellKind;
  /** For a collapsed cell, the ending the surface reports instead. */
  collapsedOnto: Endstate | null;
  /** The mapper's own sentence for why it answered that way. */
  note: string;
  /** The fields the mapper read to get there. */
  from: readonly string[];
}

interface Probe {
  run: () => AxisReading<Endstate>;
  /** True when the reading depends on a field the application had to declare itself. */
  viaApp?: boolean;
}

const PROBES: Record<Surface, Partial<Record<Endstate, Probe>>> = {
  "calls-api": {
    answered_human: {
      run: () =>
        normalizeCallsApi({ status: "completed", structured_result: { answered_by: "human" } })
          .endstate,
      viaApp: true,
    },
    answered_machine: {
      run: () =>
        normalizeCallsApi({ status: "completed", structured_result: { answered_by: "voicemail" } })
          .endstate,
      viaApp: true,
    },
    // The observed shapes, not the shapes the docs imply. Both endings come
    // back with top-level failure_code "call_failed" and the same NO ANSWER
    // message. Only the attempt code told them apart.
    no_answer: {
      run: () =>
        normalizeCallsApi({
          status: "failed",
          failure_code: "call_failed",
          failure_message: "calling task status=NO ANSWER (Hangup by: bot)",
          recipients: [{ attempts: [{ failure_code: "408" }] }],
        }).endstate,
    },
    busy: {
      run: () =>
        normalizeCallsApi({
          status: "failed",
          failure_code: "call_failed",
          failure_message: "calling task status=NO ANSWER (Hangup by: bot)",
          recipients: [{ attempts: [{ failure_code: "486" }] }],
        }).endstate,
    },
    unreachable: {
      run: () =>
        normalizeCallsApi({
          status: "failed",
          failure_code: "call_failed",
          failure_message: "calling task status=FAILED",
          recipients: [{ attempts: [{ failure_code: "403" }] }],
        }).endstate,
    },
    declined: { run: () => normalizeCallsApi({ status: "failed", failure_code: "declined" }).endstate },
    provider_failed: { run: () => normalizeCallsApi({ status: "failed" }).endstate },
    canceled: { run: () => normalizeCallsApi({ status: "canceled" }).endstate },
    expired: { run: () => normalizeCallsApi({ status: "failed", failure_code: "expired" }).endstate },
  },
  "goal-runs": {
    answered_human: { run: () => normalizeGoalRun({ result: { ok: true } }).endstate },
    answered_machine: { run: () => normalizeGoalRun({ error: { code: "no_answer" } }).endstate },
    no_answer: { run: () => normalizeGoalRun({ error: { code: "no_answer" } }).endstate },
    busy: { run: () => normalizeGoalRun({ error: { code: "call_failed" } }).endstate },
    declined: { run: () => normalizeGoalRun({ error: { code: "declined" } }).endstate },
    provider_failed: { run: () => normalizeGoalRun({ error: { code: "call_failed" } }).endstate },
    canceled: { run: () => normalizeGoalRun({ error: { code: "canceled" } }).endstate },
    expired: { run: () => normalizeGoalRun({ error: { code: "timed_out" } }).endstate },
  },
  mcp: {
    answered_human: { run: () => normalizeMcpRun({ status: "COMPLETED" }).endstate },
    answered_machine: { run: () => normalizeMcpRun({ status: "VOICEMAIL" }).endstate },
    no_answer: { run: () => normalizeMcpRun({ status: "NO_ANSWER" }).endstate },
    busy: { run: () => normalizeMcpRun({ status: "BUSY" }).endstate },
    declined: { run: () => normalizeMcpRun({ status: "DECLINED" }).endstate },
    provider_failed: { run: () => normalizeMcpRun({ status: "FAILED" }).endstate },
    canceled: { run: () => normalizeMcpRun({ status: "CANCELED" }).endstate },
    expired: { run: () => normalizeMcpRun({ status: "EXPIRED" }).endstate },
  },
};

export const SURFACES_IN_ORDER: readonly Surface[] = ["calls-api", "goal-runs", "mcp"];

/**
 * The endings worth a row.
 *
 * `unknown` and `answered_unspecified` are what a mapper falls back to, so a
 * column asking whether a surface can express them answers itself.
 */
export const INTERESTING_ENDINGS: readonly Endstate[] = ENDSTATES.filter(
  (ending) => ending !== "unknown" && ending !== "answered_unspecified",
);

export function cell(surface: Surface, ending: Endstate): Cell {
  const probe = PROBES[surface][ending];

  if (!probe) {
    return {
      surface,
      ending,
      kind: "none",
      collapsedOnto: null,
      note: "Nothing probes this cell, so nothing is claimed about it.",
      from: [],
    };
  }

  const reading = probe.run();
  const base = { surface, ending, note: reading.note, from: reading.from };

  if (reading.value === ending) {
    if (probe.viaApp) return { ...base, kind: "app", collapsedOnto: null };
    return {
      ...base,
      kind: reading.basis === "derived" ? "derived" : "yes",
      collapsedOnto: null,
    };
  }

  if (reading.value === "unknown") {
    return { ...base, kind: "no", collapsedOnto: null };
  }

  return { ...base, kind: "collapsed", collapsedOnto: reading.value };
}

export interface CoverageRow {
  ending: Endstate;
  cells: Cell[];
}

/** Run every probe and hand back the whole table. */
export function coverage(): CoverageRow[] {
  return INTERESTING_ENDINGS.map((ending) => ({
    ending,
    cells: SURFACES_IN_ORDER.map((surface) => cell(surface, ending)),
  }));
}

export const CELL_MEANING: Record<CellKind, string> = {
  yes: "The surface states it outright.",
  app: "Only if the application declared its own field and extraction worked.",
  derived: "Only by inference, never stated.",
  no: "The surface cannot express it, so the reading stays unknown.",
  collapsed: "The surface reports this ending as a different one.",
  none: "Nothing probes this cell.",
};
