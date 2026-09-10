/**
 * Find out what completion_confidence actually responds to.
 *
 * The OpenAPI says `score` is a number from 0 to 1 for CALL-E's task completion
 * judgment, and describes `label` only as "for example low, medium, high" with
 * no enum behind it. Nothing published says what either field moves with. Until
 * somebody measures it, code that branches on either one is guessing.
 *
 * The probe places the same call task under conditions where the answer given
 * back is known in advance, and records what came out. One row per call.
 *
 * Nothing runs without --to and --confirm. There is no default number and no
 * dry run that secretly dials.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { CalleApiError, CalleClient, readKeyFromEnvFile } from "../src/calle/client.js";
import { MemoryIntentStore, isDialBlocked, maskDestination } from "../src/ledger/index.js";
import { normalizeCallsApi } from "../src/disposition/surfaces/calls-api.js";

interface Condition {
  id: string;
  /** What the person on the other end has agreed to say. */
  expectedAnswer: string;
  /** What we would call the truth if we were scoring the call ourselves. */
  groundTruth: "yes" | "no" | "unknown";
  task: (phone: string) => string;
  /** Overrides the default schema when the condition asks a different question. */
  resultSchema?: Record<string, unknown>;
}

/**
 * The conditions only mean anything when the answer is known in advance. That
 * is the reason this probe wants a briefed respondent rather than whoever
 * happens to pick up: a confidence reading you cannot score against a known
 * answer is just a number.
 */
const CONDITIONS: Condition[] = [
  {
    id: "clear-yes",
    expectedAnswer: "Yes, we are open on Saturday.",
    groundTruth: "yes",
    task: (phone) =>
      `Call ${phone}. Say immediately that you are an automated assistant and that the call may be recorded, and that you are calling to check one published detail. Then ask whether they are open on Saturday. Thank them and end the call.`,
  },
  {
    id: "hedged",
    expectedAnswer: "I think so, probably, you would have to check.",
    groundTruth: "unknown",
    task: (phone) =>
      `Call ${phone}. Say immediately that you are an automated assistant and that the call may be recorded, and that you are calling to check one published detail. Then ask whether they are open on Saturday. Thank them and end the call.`,
  },
  {
    id: "non-answer",
    expectedAnswer: "Talks about something else and never answers the question.",
    groundTruth: "unknown",
    task: (phone) =>
      `Call ${phone}. Say immediately that you are an automated assistant and that the call may be recorded, and that you are calling to check one published detail. Then ask whether they are open on Saturday. Thank them and end the call.`,
  },
  {
    // The one condition that can succeed without involving a person. The NIST
    // speaking clock is a recorded announcement that exists to be dialled, it
    // hangs up on its own after two minutes, and what it says is knowable in
    // advance to the second. So this is the only place in the set where a task
    // genuinely being met can be checked rather than taken on trust.
    id: "recorded-line",
    expectedAnswer: "A recorded voice announcing the current UTC time.",
    groundTruth: "unknown",
    task: (phone) =>
      `Call ${phone}. Say immediately that you are an automated assistant and that the call may be recorded. Listen to the recorded announcement and report the time it states. Then end the call.`,
    resultSchema: {
      type: "object",
      required: ["announced_time", "evidence"],
      properties: {
        announced_time: {
          type: "string",
          description:
            "The time the recording announced, as close to how it said it as possible. Use unknown if no time was announced.",
        },
        evidence: {
          type: "string",
          description: "The words the recording actually used, quoted.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    // Fills the cells no cooperating human can fill. 555-0100 through 555-0199
    // in any North American area code are reserved for fiction and are not
    // assigned to anybody, so this rings nobody's phone by construction.
    id: "unassigned-number",
    expectedAnswer: "Nobody. The number is reserved for fiction and is not assigned.",
    groundTruth: "unknown",
    task: (phone) =>
      `Call ${phone}. Say immediately that you are an automated assistant and that the call may be recorded, and that you are calling to check one published detail. Then ask whether they are open on Saturday. Thank them and end the call.`,
  },
  {
    id: "refusal",
    expectedAnswer: "Declines to speak to an automated caller.",
    groundTruth: "unknown",
    task: (phone) =>
      `Call ${phone}. Say immediately that you are an automated assistant and that the call may be recorded, and that you are calling to check one published detail. Then ask whether they are open on Saturday. If they object to speaking with an automated caller, thank them and end the call at once.`,
  },
];

const RESULT_SCHEMA = {
  type: "object",
  required: ["open_saturday", "evidence"],
  properties: {
    open_saturday: {
      type: "string",
      enum: ["yes", "no", "unknown"],
      description:
        "Whether they said they are open on Saturday. Use unknown if they hedged, did not answer, or declined.",
    },
    evidence: {
      type: "string",
      description: "The words they actually used that support the answer, quoted.",
    },
  },
  additionalProperties: false,
};

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const to = arg("to");
  const conditionId = arg("condition") ?? "clear-yes";
  // Each measurement is its own authorization, so it needs its own label. The
  // key is derived from the authorization and nothing else, which means running
  // the same condition twice under the same label is a duplicate call and gets
  // refused. That refusal is the ledger working. Bump --run to authorize a new
  // one. There is deliberately no timestamp default: a nonce that moves on its
  // own would quietly turn every re-run into a fresh authorization, which is
  // the exact behaviour the key derivation exists to prevent.
  const run = arg("run") ?? "1";
  const outPath = arg("out") ?? "artifacts/confidence-probe.jsonl";
  // Where CALL-E should post the terminal event. Optional, and when it is set
  // the call is the only way to see what a real delivery looks like, since
  // there is no way to ask for one after the fact.
  const webhookUrl = arg("webhook");
  const envPath = arg("env");

  if (!to) {
    console.error("Refusing to run. Pass --to +15551234567 with a number you are authorized to call.");
    process.exit(2);
  }
  if (!/^\+[1-9]\d{6,14}$/.test(to)) {
    console.error(`Refusing to run. "${to}" is not E.164. No repairing, no guessing a country code.`);
    process.exit(2);
  }

  const condition = CONDITIONS.find((c) => c.id === conditionId);
  if (!condition) {
    console.error(`Unknown condition "${conditionId}". Try one of: ${CONDITIONS.map((c) => c.id).join(", ")}`);
    process.exit(2);
  }

  // CALLE_API_KEY first. --env is an escape hatch for a key file that lives
  // outside the repo, and there is deliberately no default path for it: a
  // hardcoded one would put somebody's machine layout in a public repo.
  const apiKey = envPath
    ? readKeyFromEnvFile(envPath, "iams_live")
    : (process.env.CALLE_API_KEY ?? "");

  if (!apiKey) {
    console.error(
      "No API key. Set CALLE_API_KEY, or pass --env <path> to a file with an iams_live line.",
    );
    process.exit(2);
  }

  const client = new CalleClient({ apiKey });

  const credentials = await client.verifyCredentials();
  if (!credentials.ok) {
    console.error(`Credential check failed. ${credentials.detail}`);
    process.exit(1);
  }
  console.log(`Credentials: ${credentials.detail}`);

  const store = new MemoryIntentStore();
  const intent = await store.reserve(
    {
      workflowId: `confidence-probe-${condition.id}-run${run}`,
      purpose: "measure what completion_confidence responds to",
      destination: to,
      contractVersion: "probe-v1",
    },
    "calls-api",
  );

  console.log(`\nCondition:   ${condition.id}`);
  console.log(`Destination: ${maskDestination(to)}`);
  console.log(`Expecting:   ${condition.expectedAnswer}`);
  console.log(`Run:         ${run}`);
  console.log(`Intent:      ${intent.id}`);
  console.log(`Key:         ${intent.idempotencyKey}`);
  if (webhookUrl) console.log(`Webhook:     ${webhookUrl}`);

  if (!has("confirm")) {
    console.log("\nNothing dialled. Add --confirm to place this call for real.");
    return;
  }
  if (isDialBlocked(intent)) {
    console.error("\nThis intent is not in a state that may dial.");
    process.exit(1);
  }

  console.log("\nPlacing the call.");
  let created;
  try {
    created = await client.createCall(
      {
        task: condition.task(to),
        result_schema: condition.resultSchema ?? RESULT_SCHEMA,
        metadata: { probe: "confidence", condition: condition.id, intent_id: intent.id },
      ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
      },
      intent.idempotencyKey,
    );
  } catch (error) {
    if (error instanceof CalleApiError && error.code === "idempotency_conflict") {
      console.error(
        `\nRefused as a duplicate. This authorization has already placed a call:` +
          `\n  ${intent.idempotencyKey}` +
          `\n\nNo call was placed and nothing was charged. Run ${run} of "${condition.id}"` +
          `\nis spent. To measure this condition again, authorize a new run:` +
          `\n  --condition ${condition.id} --run ${Number(run) + 1 || `${run}b`}`,
      );
      process.exit(3);
    }
    throw error;
  }

  await store.advance(intent.id, "accepted", { boundId: created.id });
  console.log(`Call ${created.id} accepted, status ${created.status}.`);

  // settleForResult because this probe always sends a result schema, and a
  // terminal status has been observed arriving before the result does.
  const { call: terminal, settledAfterMs } = await client.waitForResult(created.id, {
    onPoll: (call) => console.log(`  ...${call.status}`),
    settleForResult: true,
  });
  if (settledAfterMs > 0) {
    console.log(`  ...result appeared ${(settledAfterMs / 1000).toFixed(0)}s after the status went terminal`);
  }

  const disposition = normalizeCallsApi({ ...terminal, result_schema_requested: true });

  const row = {
    at: new Date().toISOString(),
    condition: condition.id,
    ground_truth: condition.groundTruth,
    expected_answer: condition.expectedAnswer,
    call_id: terminal.id,
    result_settled_after_ms: settledAfterMs,
    status: terminal.status,
    task_completed: terminal.task_completed ?? null,
    completion_confidence: terminal.completion_confidence ?? null,
    evidence: terminal.evidence ?? null,
    structured_result: terminal.structured_result ?? null,
    summary: terminal.summary ?? null,
    failure_code: terminal.failure_code ?? null,
    normalized: {
      endstate: disposition.endstate.value,
      endstate_basis: disposition.endstate.basis,
      task_outcome: disposition.taskOutcome.value,
      result_state: disposition.resultState.value,
      needs_human: disposition.needsHuman,
    },
  };

  mkdirSync(dirname(outPath), { recursive: true });
  appendFileSync(outPath, `${JSON.stringify(row)}\n`, "utf8");

  console.log("\n--- what came back ---");
  console.log(`status:      ${row.status}`);
  console.log(`completed:   ${row.task_completed}`);
  console.log(`confidence:  ${JSON.stringify(row.completion_confidence)}`);
  console.log(`result:      ${JSON.stringify(row.structured_result)}`);
  console.log(`evidence:    ${JSON.stringify(row.evidence)}`);
  console.log(`normalized:  ${JSON.stringify(row.normalized)}`);
  console.log(`\nAppended to ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
