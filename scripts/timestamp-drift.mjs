/**
 * Does a finished call keep the same attempt timestamps when you read it again?
 *
 * Often not: the first read after the call finished can carry zoned
 * sub-second timestamps, and a later read of the same call id naive
 * whole-second ones, shifted by the offset. This script
 * exists so that observation can be repeated on demand instead of asserted.
 *
 * It places one call to the US speaking clock, which answers immediately, hangs
 * up on itself, and involves no person. Then it reads the same call back on a
 * schedule and writes every raw response to disk, so what a maintainer sees is
 * the API's own bytes rather than a summary of them.
 *
 *   node scripts/timestamp-drift.mjs --out artifacts/drift
 *
 * Nothing here interprets anything. It records, and the diff is the finding.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://api.heycall-e.com";
/**
 * Default is the US speaking clock. Pass --to to use another of the safe
 * numbers, for instance the reserved-for-fiction range, which refuses in well
 * under a second and is the case that matters for the zero-duration reports.
 */
const DEFAULT_DESTINATION = "+13035550100";

/** Read-after-terminal offsets, in seconds. */
const READS_AT = [0, 60, 180, 420];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

function keyFromEnvFile(path) {
  const line = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("CALLE_API_KEY="));
  if (!line) throw new Error(`No CALLE_API_KEY in ${path}`);
  return line.slice("CALLE_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

const key = process.env.CALLE_API_KEY ?? keyFromEnvFile(arg("env", ".env"));
const DESTINATION = arg("to", DEFAULT_DESTINATION);
const outDir = arg("out", "artifacts/drift");
mkdirSync(outDir, { recursive: true });

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function attempts(call) {
  return (call.recipients ?? []).flatMap((r) => r.attempts ?? []);
}

/** A timestamp states its offset, or it does not. Nothing in between. */
function zoned(ts) {
  return typeof ts === "string" && /(?:Z|[+-]\d{2}:?\d{2})$/.test(ts.trim());
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

console.log(`Placing one call to ${DESTINATION}.`);
const created = await api("/v1/calls", {
  method: "POST",
  headers: { "Idempotency-Key": `drift_${Date.now()}` },
  body: JSON.stringify({
    task: "Listen for the spoken time and write down the hour and minute exactly as announced.",
    recipients: [{ phones: [DESTINATION], region: "US", locale: "en-US" }],
    result_schema: {
      type: "object",
      properties: { answer: { type: "string" }, evidence: { type: "string" } },
      required: ["answer", "evidence"],
    },
  }),
});

const callId = created.id;
console.log(`  ${callId}`);

console.log("Waiting for it to go terminal.");
let call = created;
for (let i = 0; i < 60; i += 1) {
  await sleep(10_000);
  call = await api(`/v1/calls/${encodeURIComponent(callId)}`);
  process.stdout.write(`  ${call.status}\n`);
  if (["completed", "failed", "canceled"].includes(call.status)) break;
}

const rows = [];
let previous = 0;

for (const offset of READS_AT) {
  if (offset > previous) await sleep((offset - previous) * 1000);
  previous = offset;

  const fresh = await api(`/v1/calls/${encodeURIComponent(callId)}`);
  const events = await api(`/v1/calls/${encodeURIComponent(callId)}/events?limit=100`);

  const file = join(outDir, `${stamp}_${callId}_t+${offset}s.json`);
  writeFileSync(file, JSON.stringify({ readAt: new Date().toISOString(), call: fresh, events }, null, 2));

  const a = attempts(fresh)[0] ?? {};
  const eventStatuses = [...new Set((events.data ?? []).map((e) => e.status))];
  rows.push({
    offset,
    started_at: a.started_at ?? null,
    completed_at: a.completed_at ?? null,
    zoned: zoned(a.started_at),
    eventCount: (events.data ?? []).length,
    eventStatuses,
    firstEventCreatedAt: events.data?.[0]?.created_at ?? null,
  });
  const seconds =
    a.started_at && a.completed_at
      ? (Date.parse(a.completed_at.replace(/(?<!Z)$/, "Z")) -
          Date.parse(a.started_at.replace(/(?<!Z)$/, "Z"))) /
        1000
      : null;
  rows[rows.length - 1].seconds = seconds;
  console.log(
    `  t+${offset}s  started_at=${a.started_at}  zoned=${zoned(a.started_at)}  duration=${seconds}s`,
  );
}

const summaryFile = join(outDir, `${stamp}_${callId}_summary.json`);
writeFileSync(summaryFile, JSON.stringify({ callId, rows }, null, 2));

const first = rows[0];
const drifted = rows.some(
  (r) => r.started_at !== first.started_at || r.zoned !== first.zoned,
);
const eventStatusMoved = rows.some(
  (r) => JSON.stringify(r.eventStatuses) !== JSON.stringify(first.eventStatuses),
);
const eventCreatedMoved = rows.some((r) => r.firstEventCreatedAt !== first.firstEventCreatedAt);

console.log("");
console.log(`attempt timestamps changed after the call finished : ${drifted}`);
console.log(`event status values changed on re-read             : ${eventStatusMoved}`);
console.log(`event created_at changed on re-read                : ${eventCreatedMoved}`);
console.log(`raw responses in ${outDir}`);
