import { NextResponse } from "next/server";

import { fromWebhookEvent, normalize, say, unsigned } from "asheard/disposition";

import { isInboxId, isWired, push, read, type Arrival } from "@/lib/inbox";

/**
 * Door two. Copy this URL into anything that already sends webhooks.
 *
 * Nothing to install and no key to hand over, which is the whole point. It also
 * means anybody who learns the URL can post to it, so everything that arrives
 * here is marked unsigned before it is shown to anybody.
 *
 * The endpoint answers 202 for anything it can store, including payloads it
 * cannot read. A sender that gets a 400 back will usually retry, and a retry
 * loop over a payload that will never parse helps nobody. More to the point, an
 * event that arrived and could not be read is exactly the sort of thing an
 * operator needs to see, so it is kept and shown with the reason.
 */

export const dynamic = "force-dynamic";

function readIt(payload: unknown): Pick<Arrival, "reading" | "unreadable"> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { reading: null, unreadable: "Not a JSON object." };
  }

  const record = payload as Record<string, unknown>;

  try {
    // A CALL-E webhook wraps the call in an envelope with its own event type,
    // and the type carries a fact the call task does not: a validation failure
    // is only ever visible there.
    const envelope =
      typeof record.type === "string" && typeof record.data === "object" && record.data !== null;

    const disposition = envelope
      ? fromWebhookEvent(record as { id?: string; type?: string; data?: Record<string, unknown> })
      : normalize(record);

    const marked = unsigned(disposition);
    return { reading: { disposition: marked, spoken: say(marked) }, unreadable: null };
  } catch (error) {
    return {
      reading: null,
      unreadable:
        error instanceof Error
          ? error.message
          : "Could not tell which CALL-E surface this came from.",
    };
  }
}

/**
 * Keep only the headers worth showing, by name.
 *
 * This was a denylist for about ten minutes and that was the wrong shape. The
 * platform in front of this route injects several headers that carry
 * credentials, including one whose value is a JSON object with an
 * Authorization bearer inside it, and a denylist only ever knows about the
 * secrets somebody already thought of.
 *
 * An allowlist fails the other way. A header nobody anticipated gets dropped
 * rather than stored, and the worst case is a missing line in a debug view
 * rather than a token sitting in a store that anyone with the URL can read.
 */
const HEADER_ALLOWLIST = [
  "call-e-event-id",
  "content-type",
  "content-length",
  "user-agent",
  "accept",
  "date",
];

function safeHeaders(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {};
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    // Any call-e header is ours to show. Everything else has to be named.
    if (name.startsWith("call-e-") || HEADER_ALLOWLIST.includes(name)) {
      kept[key] = value.slice(0, 200);
    }
  });
  return kept;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ inbox: string }> },
): Promise<NextResponse> {
  const { inbox } = await params;

  if (!isInboxId(inbox)) {
    return NextResponse.json({ error: "Not an inbox." }, { status: 404 });
  }
  if (!isWired()) {
    return NextResponse.json(
      { error: "This deployment has no store behind it, so there is nowhere to put the event." },
      { status: 503 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    payload = null;
  }

  const arrival: Arrival = {
    at: new Date().toISOString(),
    headers: safeHeaders(request.headers),
    payload,
    ...readIt(payload),
  };

  await push(inbox, arrival);

  return NextResponse.json({ accepted: true, at: arrival.at }, { status: 202 });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ inbox: string }> },
): Promise<NextResponse> {
  const { inbox } = await params;

  if (!isInboxId(inbox)) {
    return NextResponse.json({ error: "Not an inbox." }, { status: 404 });
  }
  if (!isWired()) {
    return NextResponse.json({ wired: false, arrivals: [] });
  }

  return NextResponse.json({ wired: true, arrivals: await read(inbox) });
}
