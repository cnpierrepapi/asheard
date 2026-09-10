import { NextResponse } from "next/server";

import { CalleApiError, CalleClient } from "asheard/calle";
import { normalizeCallsApi } from "asheard/disposition";
import {
  buildEvidence,
  withFlags,
  classify,
  phrase,
  destinationById,
  isAllowedDestination,
  publicCallView,
  type EventPage,
} from "asheard/reconciler";

import { spendOne } from "@/lib/budget";
import { RedisIntents, haltReason, validIntentKey } from "@/lib/intents";
import { issueReadToken, readTokenValid } from "@/lib/readtoken";
import { pipeline } from "@/lib/redis";

/**
 * The one route in this app that can ring a phone.
 *
 * Everything about it is written on the assumption that it will be found and
 * poked at by somebody who is not the intended user, because it is a public
 * page with a button that costs money.
 *
 * Three gates, in order, before anything is dialled:
 *
 *   1. the destination has to be one of ours, checked on the resolved number
 *      rather than the id, so a real id with a swapped number is refused
 *   2. the daily and per-visitor budget has to have room, checked first and
 *      failing closed
 *   3. the key comes from the server environment and is never accepted from
 *      the browser, so nobody can dial on somebody else's account through it
 *   4. the intent is written down before the request leaves, keyed on what was
 *      authorized rather than on the clock, and nothing outside `reserved` is
 *      ever dialled again
 *
 * POST places the call and returns immediately with an id and a read token. It
 * does not wait, because the interesting part of this demo is watching the two
 * sides disagree while it runs.
 *
 * GET will only read a call whose token it issued, and answers with an
 * allowlisted projection rather than the payload. An earlier version took any
 * call id and returned the raw object, which made this an unauthenticated
 * window onto every call on the account.
 */

export const dynamic = "force-dynamic";

/**
 * The question, in CALL-E's own words.
 *
 * Copied from the calls guide, which says the API returns no built-in AMD
 * disposition and no answered-by field, and that you define the classification
 * yourself. Sending this is the only difference between the two calls the demo
 * places, and it is the difference between a reading that can name who picked
 * up and one that honestly cannot.
 */
const ANSWERED_BY_SCHEMA = {
  type: "object",
  required: ["answered_by"],
  properties: {
    answered_by: {
      type: "string",
      enum: ["human", "ivr", "voicemail", "unknown"],
      description:
        "Classify the final endpoint. If an IVR transfers the call to a person, use human.",
    },
  },
  additionalProperties: false,
} as const;

interface CreateBody {
  destinationId?: unknown;
  /**
   * One press of the button, named by the browser.
   *
   * This is the authorization, and it is the caller's to mint because the
   * caller is the one who decided to dial. Everything derived from it is
   * stable, so a retry after a lost response resolves to the call that already
   * exists rather than a second one.
   */
  intentKey?: unknown;
  /**
   * Whether to send the per-recipient schema that asks who picked up.
   *
   * This is the whole comparison. The same number, dialled twice, with the
   * question and without it. Everything else about the two requests is
   * identical, so any difference in what comes back is down to asking.
   */
  askWhoAnswered?: unknown;
}

/**
 * A stable-enough id for one browser, for rate limiting only.
 *
 * Deliberately coarse and deliberately not stored anywhere. It exists to stop
 * one person spending the day's budget, not to identify anybody.
 */
function visitorId(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0]?.trim() ?? "";
  return ip !== "" ? ip : "unknown";
}

function client(): CalleClient | null {
  const apiKey = process.env.CALLE_API_KEY?.trim() ?? "";
  return apiKey === "" ? null : new CalleClient({ apiKey });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "That was not JSON." }, { status: 400 });
  }

  const id = typeof body.destinationId === "string" ? body.destinationId : "";
  const destination = destinationById(id);
  if (destination === null) {
    return NextResponse.json(
      { error: "That is not one of the numbers this demo can call." },
      { status: 400 },
    );
  }

  // Belt and braces. The id resolved, but the guard runs on the number itself.
  if (!isAllowedDestination(destination.e164)) {
    return NextResponse.json({ error: "Refused." }, { status: 400 });
  }

  const ask = body.askWhoAnswered === true;

  if (!validIntentKey(body.intentKey)) {
    return NextResponse.json(
      { error: "That request carried no usable intent key, so nothing was dialled." },
      { status: 400 },
    );
  }
  const intentKey = body.intentKey;

  const calle = client();
  if (calle === null) {
    return NextResponse.json(
      { error: "The demo has no key configured, so it cannot place a call." },
      { status: 503 },
    );
  }

  /**
   * What was authorized, in the package's own shape.
   *
   * The two lanes differ only by `purpose`, so one press produces two intents
   * and two keys, and pressing again produces two more. Nothing here is the
   * clock: the same press retried is the same authorization, forever.
   */
  const authorization = {
    workflowId: `live_${intentKey}`,
    purpose: ask ? "who-answered-probe" : "baseline-probe",
    destination: destination.e164,
    contractVersion: "live-v1",
  };

  const intents = new RedisIntents(pipeline);

  let reservation;
  try {
    reservation = await intents.reserve(authorization, "calls-api");
  } catch {
    // Fail closed, same as the budget. If the intent cannot be written down,
    // there is nothing to stop a retry ringing the phone twice, so do not dial.
    return NextResponse.json(
      { error: "The demo could not record what it was about to do, so it did not place a call." },
      { status: 503 },
    );
  }

  let intent = reservation.intent;

  // Already dialled under this authorization. Hand back the call that exists.
  if (intent.boundId !== null) {
    return NextResponse.json({
      callId: intent.boundId,
      readToken: issueReadToken(intent.boundId),
      requestedAt: intent.createdAt,
      destination: publicDestination(destination),
      askedWhoAnswered: ask,
      replayed: true,
    });
  }

  // Anything that is not `reserved` may already be in flight. There is no
  // honest retry from here, so the demo stops and says so.
  if (intent.state !== "reserved") {
    return NextResponse.json(
      { error: haltReason(intent), intentState: intent.state },
      { status: 409 },
    );
  }

  const budget = await spendOne(visitorId(request));
  if (!budget.allowed) {
    return NextResponse.json({ error: budget.reason }, { status: 429 });
  }

  const requestedAt = new Date().toISOString();

  // Written down as sent *before* it is sent. A crash between these two lines
  // leaves a record that says "this may have gone out", which is the truth.
  try {
    intent = await intents.advance(intent, "submission_unknown");
  } catch {
    return NextResponse.json(
      { error: "The demo could not record what it was about to do, so it did not place a call." },
      { status: 503 },
    );
  }

  try {
    const call = await calle.createCall(
      {
        task: destination.task,
        recipients: [{ phones: [destination.e164], region: "US", locale: "en-US" }],
        result_schema: {
          type: "object",
          properties: {
            answer: { type: "string" },
            evidence: { type: "string" },
          },
          required: ["answer", "evidence"],
        },
        ...(ask ? { recipient_result_schema: ANSWERED_BY_SCHEMA } : {}),
      },
      intent.idempotencyKey,
    );

    await intents.advance(intent, "accepted", { boundId: call.id });

    return NextResponse.json({
      callId: call.id,
      // Only a holder of this can read the call back. See lib/readtoken.
      readToken: issueReadToken(call.id),
      requestedAt,
      destination: publicDestination(destination),
      askedWhoAnswered: ask,
      remainingToday: budget.remainingToday,
    });
  } catch (error) {
    if (error instanceof CalleApiError && refusedOutright(error.status)) {
      // The API says it created nothing, so the record can say so too and the
      // intent stops here rather than sitting as a maybe forever.
      await intents
        .advance(intent, "needs_human", { reasons: [`CALL-E refused the request: ${error.message}`] })
        .catch(() => undefined);
      return NextResponse.json(
        { error: `CALL-E refused the call: ${error.message}` },
        { status: 502 },
      );
    }

    // Everything else is ambiguous: a timeout, a 5xx, a socket that closed. The
    // request may have been accepted. The intent stays at submission_unknown,
    // which has no way back, so this authorization will never be dialled again.
    return NextResponse.json(
      {
        error:
          "The request went out and CALL-E did not say whether it landed. Nothing will be sent again under this press, because that is how a person gets rung twice.",
        intentState: "submission_unknown",
      },
      { status: 409 },
    );
  }
}

/**
 * Statuses that mean nothing was created.
 *
 * Anything not on this list is treated as ambiguous, including 409 and 5xx. The
 * cost of guessing wrong in that direction is a demo that says less than it
 * could; the cost of guessing wrong in the other direction is a second call.
 */
function refusedOutright(status: number): boolean {
  return [400, 401, 403, 404, 422].includes(status);
}

/** The fields of a destination that are safe to hand back. */
function publicDestination(destination: {
  id: string;
  label: string;
  e164: string;
  expectation: string;
  why: string;
}) {
  return {
    id: destination.id,
    label: destination.label,
    e164: destination.e164,
    expectation: destination.expectation,
    why: destination.why,
  };
}

/**
 * Read the call back, both ways.
 *
 * `platform` is exactly what the API returned, untouched, so the left-hand side
 * of the screen cannot be accused of being dressed up. `reading` is what this
 * library makes of it. The point of the page is that they are different.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const callId = url.searchParams.get("callId")?.trim() ?? "";
  const requestedAt = url.searchParams.get("requestedAt")?.trim() ?? "";
  const token = url.searchParams.get("token")?.trim() ?? "";

  if (callId === "") {
    return NextResponse.json({ error: "No call id." }, { status: 400 });
  }

  // A call id is not a capability. Without the token this route issued when it
  // placed the call, there is nothing here to read.
  if (!readTokenValid(callId, token)) {
    return NextResponse.json(
      { error: "This call was not placed by this demo, or the read token is missing." },
      { status: 403 },
    );
  }

  const calle = client();
  if (calle === null) {
    return NextResponse.json({ error: "No key configured." }, { status: 503 });
  }

  try {
    const call = await calle.getCall(callId);

    // Events are best effort. A call with no readable event stream is still
    // worth showing, it just cannot be timed.
    let events: EventPage[] = [];
    try {
      const page = (await calle.listEvents(callId)) as EventPage;
      events = [page];
    } catch {
      events = [];
    }

    const read = normalizeCallsApi(call as never);
    const evidence = withFlags(
      buildEvidence({ payload: call, events, read }),
      requestedAt !== "" ? { requestedAt } : {},
    );
    const ranked = classify(evidence);
    const spoken = phrase(ranked);

    return NextResponse.json({
      // An allowlisted projection, never the payload. The raw object carries
      // destinations and full transcripts.
      platform: publicCallView(call),
      evidence,
      band: ranked.band,
      because: ranked.because,
      spoken,
    });
  } catch (error) {
    if (error instanceof CalleApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Could not read that call." }, { status: 502 });
  }
}
