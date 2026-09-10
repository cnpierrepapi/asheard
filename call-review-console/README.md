# asheard

Read what actually happened to a CALL-E call, and see which field said so.

A finished call hands you a status word, a `task_completed` boolean and a
confidence score. That comes back saying the job is done for a voicemail box:
the recording picks up, the agent asks its question into the tone, and the call
ends `completed` with a schema-valid result and a high score.

Nothing in that payload is wrong. There is just no field in it that says a
person was ever on the line.

This app reads a call as three separate answers instead of one, and puts the
field it read next to every sentence.

## Try it without placing a call

No credentials, no phone, nothing stored.

```bash
npm install
npm run dev
```

Then:

- `/read` takes a payload you paste and reads it. Four sample payloads are
  loaded for you.
- `/briefing` shows a batch of calls in the order somebody should deal with
  them, from fixtures, with the boring ones collapsed into a line.
- `/matrix` prints which endings each surface can actually express, generated
  from the mappers rather than written by hand.

```bash
npm test
```

111 tests, no network and no credentials. The suite runs against the package's
own fixtures and a stubbed `fetch`, so it exercises what the app actually
imports rather than a copy of it.

## The pages that need a key

`/key` reads one call by id. The key travels in a header, is used for one
request, and is written nowhere: no database, no cookie, no log line. It lives
in React state and dies with the tab.

`/hook` receives webhooks. Deliveries are unsigned, which the changelog
documents and tells receivers to expect, so anything arriving that way is
labelled unverified no matter how clean it reads.

`/live` places a real call, and it is the only thing here that can. Three fixed
destinations, none of which belong to a person: the two published speaking
clocks, which answer instantly and hang up on themselves, and a number in the
555-0100 range, which is held back for fiction and assigned to nobody. The list
is not accepted from the request, the check runs on the resolved number rather
than the id it arrived under, and the key is read from the server environment so
the button cannot be pointed at another account. A daily and per-visitor budget
is spent before dialling and fails closed: if the counter cannot be read, no
call goes out.

Set `CALLE_API_KEY` to enable it. Without it `/live` answers 503 and dials
nothing, which is the default.

## Side effects

`/live` places real phone calls to the three destinations above and spends
credit on the configured account. Everything else in this app is read-only.

Nothing here schedules anything or creates a recurring job, so there is nothing
to cancel. Close the tab.

One press of the button is one authorization, and the page names it before it
asks for anything. The server writes that intent down first, derives the
idempotency key from it, and will not dial the same authorization twice. If a
request goes out and the answer never comes back, the record says the call may
have gone out and stops there. It does not try again. Retrying a submission you
cannot see the outcome of is how somebody gets rung twice.

## What it will not do

It does not interpret a transcript, score anything, or ask a model what it
thinks. Every line it produces traces to a field and says the same thing every
time.

It never resolves the business outcome for you. Where a reading rests on
inference it says so and routes to a person, and where no field carries the fact
it says that instead of filling the gap.

## The engine

The reading itself lives in [`asheard`](https://www.npmjs.com/package/asheard) on
npm, published from CI with provenance, and this app is a front end over it.

- `disposition/` maps a payload from any of the three surfaces onto three axes,
  each carrying whether it was quoted from a field, derived from other fields,
  or absent because nothing carries it.
- `reconciler/` builds one evidence document per call, runs four checks over it,
  ranks a batch by what costs you something if ignored, and writes the sentences.
- `ledger/` records what was authorized before a call goes out, with the
  idempotency key derived from the authorization rather than the attempt.

The paired skill is [`skills/call-state-reconciler`](https://github.com/CALLE-AI/awesome-phone-call-agents/pull/337),
and its `references/observed-shapes.md` there shows each platform behaviour the reading
relies on, with invented values, and how to check it yourself.
