# Decisions

One entry per call that could have gone another way. Newest last.

## Three axes instead of one status

Date: 31 Aug 2026

Every existing treatment of this problem in the CALL-E ecosystem classifies a call into a single disposition. The Zapier plugin's fail-closed guide does it well, and it still ends with one branch value.

One value cannot hold three independent facts. So we split them: how the call ended, whether the job got done, whether data came back. A call that reached a human and failed its task is a different thing from a call that never connected, and both are different from a call that went perfectly and returned `null`.

The cost is that consumers have to read three fields instead of one. Worth it. The single field was lying.

## `unknown` is a real value, not a fallback

Date: 31 Aug 2026

The tempting move on a Calls API `failed` is to sniff the `failure_code` string for "busy" or "no answer" and map accordingly. Plenty of code out there does this.

We do not. CALL-E's errors guide says the field has no published enum, says to treat it as diagnostic context, and says the API does not guarantee a distinct no-answer or decline value. Reading it anyway means shipping a mapping that breaks silently the day the string changes.

So `failed` maps to `unknown` with a note saying why. It is a worse-looking answer and a truer one.

## Provenance travels with every reading

Date: 31 Aug 2026

Each axis carries `basis`, `from`, and a plain sentence. It roughly doubles the size of the output object.

The reason is the review queue. When somebody opens a call marked `needs human` at 9am, "endstate: unknown" tells them nothing. "The call failed with failure_code carrier_rejected_17, but that field has no published enum" tells them what happened and what to do about it. Provenance is the product, not decoration on it.

## A derived endstate never auto-closes

Date: 31 Aug 2026

Goal Runs has no answered-by field, so when a parsed result comes back we infer that a person answered. You cannot get a parsed result out of a dial tone.

It is a sound inference. It is still an inference, so it is marked `derived` and it sets `needsHuman`. Good inferences are exactly the ones that get promoted to facts by accident.

## Both cancel spellings stay

Date: 31 Aug 2026

The MCP terminal set lists `CANCELED` and `CANCELLED`. `NO_ANSWER` also turns up as `NO ANSWER` with a space.

First instinct was to file that as a bug and normalize to one. Second instinct won: both are documented as valid today, so both are handled, and the tidying-up is a separate conversation to have upstream. Code that only accepts the spelling you prefer breaks on live data.

## Node's built-in test runner, no framework

Date: 31 Aug 2026

`node --test` with `node:assert`. No vitest, no jest, no config file.

The repo this lands in wants apps that run with no credentials, no network, and as few moving parts as a reviewer can be asked to trust. Zero test dependencies is easier to review than a fast test runner.

## Name

Date: 31 Aug 2026

`asheard`. As heard is the line the whole library draws: what a source actually said, against what you would be inferring on its behalf. The name is the rule.

`endstate` stays as the name of the first axis, because that is the plain word for how a call ended and renaming it to match the project would only produce `asheard.asheard`.

## needs_human means unclear, not unsuccessful

Date: 31 Aug 2026

First version of the ledger test expected a voicemail with the task undone to land in the review queue. It does not, and after tracing it the code was right and the test was wrong.

A quoted voicemail is a complete fact. We know exactly what happened. What to do about it is a retry policy, and policy is the application's job.

If `needs_human` fired on every unsuccessful outcome, every no-answer on every campaign would land in front of a person, and the queue would be noise inside a week. The flag is for "we cannot tell", and only that.

## An ambiguous submission can never go back to reserved

Date: 31 Aug 2026

The state machine has no edge from `submission_unknown` to `reserved`. Once a request has left and the response was lost, there is no honest way to say the call did not happen.

Every duplicate-call bug in this shape starts with code deciding a timeout means nothing happened. A timeout tells you what the client saw. It says nothing about what CALL-E did.

## The ledger stores the recovery pair but never replays it

Date: 31 Aug 2026

On MCP, `run_call` can come back without a `run_id`, and CALL-E's own MCP guide says direct clients have no documented lookup or recovery for that. Their CLI keeps the `plan_id` and `confirm_token` in a 0600 file and hands out an opaque recovery id instead.

We keep the same pair, in a store method separate from the ordinary read so a routine fetch cannot leak a confirm token into a log. But nothing here replays it automatically. The MCP guide says not to call `run_call` again for the same plan unless the server explicitly asks for it, so the ledger makes the ambiguity durable and recoverable by a person, and stops.

## A check that could not be run is not a check that passed

Date: 31 Aug 2026

Goal Runs deliberately never echoes the phone or the variables back, so there is nothing to compare an approved destination against. The destination check records exactly that, in words, rather than quietly returning true.

Same shape everywhere else: where a surface cannot confirm something, the reconciliation says so instead of treating silence as agreement.

## A refusal explains itself

Date: 31 Aug 2026

When a binding check fails we stop before parsing, so the record comes back with no disposition on it. Read from a review queue, an absent disposition looks like the system having nothing to say.

It has plenty to say. It refused, and it knows exactly why.

So a refusal carries its own object: a machine code a UI can filter on, the failed checks with their own details, and a summary sentence written to be rendered straight into the queue with no further wording. Exactly one of `disposition` and `notRead` is set on any reconciliation, and there is a test holding that line.

The summary also says the call is still unaccounted for, because that is the part an operator will otherwise get wrong. A refused payload does not mean nothing happened on the phone. It means we could not tie what happened to anything we authorized.

## A result from a call nobody answered is not a result

Date: 3 Sep 2026

First real call placed. It rang out. Nobody picked up.

The API came back `status: failed`, and `structured_result` was filled in anyway:

```json
{ "open_saturday": "unknown", "evidence": "" }
```

That object matches the schema we sent. It has both required properties. Any code checking "did I get a structured result back" gets a yes, on a call where the phone was never answered.

The `evidence` field is the tell. We asked for the words the person actually used. There were no words. So it came back as an empty string rather than the request failing, which means required-ness here is about shape, not about whether anything filled it.

Our own mapper read that as `resultState: valid`. It was wrong, and it was wrong for exactly the reason this project exists: shape got mistaken for substance.

So `ResultState` has a fourth value now, `unsourced`. A result present on a call whose status is not `completed` reads `unsourced`, basis `derived`, and routes to review. Not `valid`, because nothing sourced it. Not `null`, because something is genuinely there and a person may still want to look at it.

The basis is `derived` and not `quoted` on purpose. We are combining two quoted fields to say something neither of them says on its own.

## completion_confidence is confidence in the judgment, not in the outcome

Date: 3 Sep 2026

The same unanswered call came back with `completion_confidence` labelled `high`.

Nobody spoke. No transcript. `task_completed` was false. And confidence was high.

That reads like a bug until you see what it is measuring. CALL-E was not confident the task got done. It was confident about its own verdict, and its verdict was "not done". On a call with no audio at all, that verdict is easy, so the number goes up.

Which means the obvious integration is backwards. Gate on `score >= 0.7` to decide whether to trust a result and you will let through the calls that never happened, because those are the ones the model is surest about.

Nothing published says this. The OpenAPI describes `score` as a number from 0 to 1 and gives `label` no enum, only "for example low, medium, high". One call was enough to show that reading it as a success signal is a mistake.

So nothing in this codebase branches on either field. They are recorded and passed through. `task_completed` carries the outcome, and it carried it correctly here.

## The Calls API can say no_answer. Just never in failure_code

Date: 3 Sep 2026

Phase 0 had this surface marked as unable to express a no-answer at all, on the strength of CALL-E's own errors guide saying `failure_code` has no published enum and should not be branched on. That guide is right about `failure_code`. It is wrong about the payload.

A call that rang out and went unanswered came back like this:

```
failure_code                                  "call_failed"
failure_message                               "calling task status=NO ANSWER (Hangup by: bot)"
recipients[0].attempts[0].failure_code        "408"
```

Three fields. The one designed to carry the reason repeats the status and nothing else. The reason is in the message, in English. And there is a second `failure_code` one level down on the attempt, in an entirely different vocabulary from the first.

So the fact is in the response. It is just not in a field, and where it is in a field, it is a different field with a different alphabet.

`mapEndstate` now reads both. Basis `derived`, never `quoted`, because parsing a sentence is not the same as reading a value, and the sentence is not a contract. Derived routes to review, which is the correct amount of trust to place in a regex over somebody's log line.

Only the no-answer shape is read. Busy, declined and a carrier fault will have their own strings and their own attempt codes. None have been seen. Writing the rest of that table from a guess about SIP numbering would be the exact mistake this project exists to complain about, so those cells stay `no` until a real call fills them in.

## The coverage table reads the basis instead of a flag

Date: 3 Sep 2026

`print-matrix.ts` had a `viaApp` flag on each probe, hand-set, saying whether a cell depended on the application declaring its own field. Adding the no-answer path meant adding a second flag, and a second flag is a second thing to forget.

It reads `AxisReading.basis` now. Quoted prints `yes`, derived prints `derived`, and the app-declared cells keep their flag because that distinction is about where the field came from, not how the value was reached.

Doing that immediately caught something. Goal Runs was printing `yes` for `answered_human`, and it should never have been. That reading has always been derived, inferred from a result existing rather than from anything Goal Runs states, and a test has asserted `basis: derived` on it since Phase 0. The table just was not asking.

One overstated cell, sitting in the artifact whose entire job is to not overstate. Worth the rewrite on its own.

## A probe run is an authorization, so it needs its own label

Date: 3 Sep 2026

Second call of the day got refused with a 409 before it reached the phone. `idempotency_conflict`, key reused with a different request.

The key is derived from the authorization and nothing else, on purpose, so a retry after a lost response cannot ring somebody twice. Running the same condition again produced the same key. CALL-E declined to place the call.

That is the design working, and it cost nothing, and it is the first time it has fired against a real server rather than a test.

The probe was what needed changing. Each measurement is a new authorization, not a retry of the old one, so `--run` is now part of the workflow id. It defaults to `1` and an operator bumps it by hand.

No timestamp default. A nonce that moves on its own would quietly turn every re-run into a fresh authorization, and then the key would be derived from the attempt again, which is the thing the derivation exists to prevent. Making the operator type a number is the point.

## task_completed says true for an answering machine

Date: 3 Sep 2026

The call connected. Here is the whole conversation:

```
bot   I'm an automated assistant... are you open on Saturday?
user  <a voicemail greeting>
bot   (asks again, and checks it can be heard)
bot   Thank you, bye.
```

One user turn in the entire call and it is the machine reading its greeting. The bot asked its question three times into a tone and hung up.

CALL-E returned:

```json
{ "status": "completed",
  "task_completed": true,
  "completion_confidence": { "label": "high" },
  "structured_result": {
    "open_saturday": "unknown",
    "evidence": "<the voicemail greeting, quoted back>"
  } }
```

`task_completed` is the field every integration branches on. It says true here. Confidence labelled high. And the quoted evidence is the answering machine greeting.

The result even contradicts the verdict inside the same object. `open_saturday` is `unknown`, which is the schema's way of saying the question was not answered, sitting next to a claim that the task was completed.

Nothing in the mapping changed for this, and that is the part worth writing down. Every axis read correctly on its own. `taskOutcome` is `met`, quoted, because the payload does say that and inventing a different answer would be its own bug. `endstate` is `answered_unspecified` on an `absent` basis, because the Calls API has no answered-by field and this call did not declare one. Both correct. Both useless on their own.

What was missing was a rule about the pair. `met` on an ending that is not `answered_human` now raises its own line in the review reasons: the payload says the task was completed, but nothing in it establishes that a person was ever on the line.

That rule is not a voicemail detector. It does not read the transcript and it does not guess. It notices that a success is being claimed on a call where nobody can say who picked up, and it hands that to a person. `CONVERSATIONAL_ENDSTATES` has been sitting in `axes.ts` since Phase 0 with nothing reading it. Now something does.

The three-axis split was an argument until today. This call is the proof, and it took one call.

## Two timestamp formats, picked by outcome

Date: 3 Sep 2026

The unanswered call reported its attempt `started_at` with no zone, hours off the event stream, which was stamping proper UTC at the same moment. Start and end were the same second, so the duration was gone.

The voicemail call reported a zoned `started_at` with a fraction of a second on it, and a real span.

Same field, same API, two formats, and which one you get depends on how the call ended. Nothing reads attempt timestamps here yet. When something does, it parses defensively, and this is why.

## failure_message says NO ANSWER for a busy line, so it is not an ending

Date: 3 Sep 2026

Yesterday's entry, written this morning, said the ending was readable out of `failure_message`. A third call took that back.

Two calls. Same sentence on both:

```
calling task status=NO ANSWER (Hangup by: bot)
```

The first rang out and carried attempt code `408`. The second was refused almost at once and carried attempt code `486`. One is nobody picking up. The other is a line that rejected the call on the spot. `failure_message` calls them the same thing.

So the message is not low resolution. It is wrong, on at least one of those two calls, and there is no way from inside the message to tell which. It is not read as an ending here any more, and the entry above is superseded.

The attempt code is the field that works. `408` and `486` are the only values in the table, because they are the only two that have been watched happen. A third code returns `unknown` and says in its note that nobody has seen it before, rather than being decoded from what the number looks like it should mean in SIP.

That restraint cost something real. The obvious move was to write the whole SIP table in one go and have busy, declined and unreachable all light up at once. Had I done that this morning, `486` would have been in it and would have looked like a win, and the same guess would have quietly put `603` and `480` in as declined and unreachable on no evidence at all. The table would have been right by luck in one cell and unfalsifiable everywhere else.

One more thing worth saying plainly. The mapper shipped the wrong answer for about twenty minutes, between the second call and the third. It read `no_answer` off the message, confidently, with `derived` on it. The basis flag is what makes that survivable: every reading it produced said out loud that it was inferred and needed a person. A `quoted` on that reading would have been a lie with a straight face.

The coverage table now shows the Calls API expressing `busy` where Goal Runs collapses it onto `provider_failed`. The surface CALL-E documents as the least informative is, on that one ending, the only one that gets it right.

## Terminal is not finished

Date: 3 Sep 2026

Calls read the instant their status went terminal mostly had `structured_result` on them. One came back null, and the same call read again a little later had the result sitting there.

Same endpoint, same shape of call, different answer. The status goes terminal before the result is necessarily attached.

Mostly there is the worst possible hit rate for something like this. It is high enough to look solid in a day of testing and low enough to drop a result in production every so often, and the report that comes back will say "the API returned nothing" with a call id that, by the time anybody looks, has a result on it.

The damage lands on the reading, not just the client. That fifth call and the one before it ended identically, both busy, both 486. One read `resultState: unsourced` and the other read `resultState: null`, purely because of when the read happened. A disposition that changes depending on how fast you looked is not a disposition.

So `waitForResult` takes `settleForResult`. Terminal status, no result, a schema was sent: keep reading for up to a minute. It returns how long the wait took rather than hiding it, because a settle time that starts creeping up is worth seeing.

It stays opt-in. A call that never asked for a result would otherwise sit out the whole window waiting for something that was never coming, and the client has no way to know which kind of call it is holding.

## An unsigned webhook is a claim, not a reading

Date: 3 Sep 2026

CALL-E webhooks carry no signature and no shared secret. Their issue #91 is open on exactly that, and it is not a thing a consumer can work around. Anybody who learns the URL can post to it, and what they post is indistinguishable from the real thing.

So an event that arrives at a webhook endpoint has a property nothing inside the payload can fix.

That is a fact about the channel and not about the call, which is why it is a reason rather than a fourth axis. The three axes say what happened on the phone. This says whether to believe the account of it. Keeping them apart matters: a signed webhook carrying a voicemail and an unsigned one carrying the same voicemail describe the same call, and you should act on them differently.

It goes first in the reasons and stays out of the headline. Every event through an unsigned webhook carries the same sentence, and a headline that is identical on every row stops being read by the second day. Reasons are where somebody deciding whether to act will actually meet it.

`unsigned()` is applied at the call site rather than inside `fromWebhookEvent`, because whether a channel can be trusted is something only the caller knows. The same unwrapping runs on payloads pulled from the API, and those are not unsigned.

It also forces review on a reading that was otherwise clean. A call where every axis is quoted and they all agree still wants a person if the only evidence it happened is an anonymous POST.

## An inbox is a list that expires

Date: 3 Sep 2026

A webhook arrives at a server with no browser attached, so the local storage the rest of the console runs on cannot catch it. Door two is the first thing here that needs a real store.

Redis, one list per inbox. Push the event, trim to fifty, set the whole list to expire in a day.

The expiry is why that shape won. Any store would hold the events. This one forgets them without being asked, so there is no cleanup job to write, schedule, and then discover has not run since March. The cap does the same thing from the other end: an inbox somebody points a busy production webhook at cannot quietly turn into a bill.

It talks to Upstash over the REST API with plain fetch. Four commands is less code than the client library that would wrap them.

The inbox id is thirty two hex characters from `crypto.getRandomValues`, and anything that is not that shape is refused before it reaches Redis. That is not really about Redis. The id is the only thing standing between an inbox and the internet, which the page says out loud rather than leaving somebody to work out.

## A payload that cannot be read is still an event that happened

Date: 3 Sep 2026

The webhook endpoint answers 202 to anything it can store, including payloads it could not make sense of.

Returning 400 was the first instinct and it is wrong twice. Senders retry a 400, so a payload that will never parse becomes a loop that helps nobody. And the event is evidence: something posted to your URL, and either a surface changed shape or somebody is pointing the wrong thing at you. Both of those are worth seeing.

So it is kept, shown in the list, and labelled with the reason it could not be read. The alternative is a webhook endpoint that silently drops the one class of event you most need to know about.

## A completed call where nobody spoke

Date: 4 Sep 2026

The call connected, the agent talked, and the whole transcript was bot turns and nothing else. No status was wrong. `status` said `completed`, there was no failure code at any level, and `structured_result` came back filled in.

The mapper read that as `valid`, which is the same mistake it made in the morning wearing different clothes. The earlier version only distrusted a result when the status was not `completed`. This one was completed.

What gives it away is not a status and not a message. It is that nobody said anything. Counting turns where the speaker is the other side is a count, not a guess, and zero of them means whatever is in the result did not come from a person speaking.

So `unsourced` now covers two shapes: a result on a call that never connected, and a result on a call where the other side never spoke. Both are derived, both route to a person.

A payload with no transcript at all is left alone. Absence of a transcript says nothing either way, and reading it as evidence would be the mistake this library exists to complain about.

## Dialling nobody, on purpose

Date: 4 Sep 2026

Every ending in the coverage table had to be watched happen before it went in, which left `unreachable` empty and no honest way to fill it. Waiting for a wrong number is not a plan.

Numbers 555-0100 through 555-0199 in any North American area code are reserved for fiction and assigned to nobody. Dialling one is a controlled test with the answer known in advance: this number cannot be reached, so whatever comes back is what "cannot be reached" looks like here.

Attempt code `403`. No ring, zero turns, and `failure_message` reading `calling task status=FAILED` rather than the `NO ANSWER` that same field carries on calls that did ring. Third distinct value from that field now, across three different endings, and it is still not read as an ending.

`403` maps to `unreachable`. That makes the Calls API the only one of the three surfaces that can express it at all, which nobody would have guessed from the docs.

Worth its own line: this was the first call that did not come back `high`. It came back `medium`, on the one call that never reached the network, while a voicemail box and two busy lines had all come back high. Whatever the number tracks, it is not whether the task succeeded.

## Nothing branches on completion_confidence, and here is the number

Date: 4 Sep 2026

Invented numbers, real shape. Calls sorted by what the platform said about its own certainty:

```
0.94  high     the task really was done, answer extracted and checked
0.93  high     an answering machine, nothing answered, task_completed true
0.9x  high     nobody picked up, busy, connected with nobody speaking
0.61  medium   never reached the network
```

The top two are the whole argument.

One of them is a call that worked. It reached a recorded line, the other side spoke, the agent pulled the announced time out of the audio, and the answer checks out against a clock. `task_completed: true`, and true.

The other is a voicemail box. Nothing was asked and nothing was answered. `task_completed: true`, and false.

Right next to each other. Both labelled high.

There is no threshold that separates those two, because there is nothing in between them to put a threshold in. Anything that gates on `score` accepts the answering machine at exactly the same moment it accepts the real answer, and the label is no better, because `high` covers a genuine success, a voicemail box, busy lines and calls with no audio whatsoever.

The one call that scored differently is the one that never reached the network at all. So the number tracks how cleanly the platform reached a verdict, which is not the same question as whether anything useful happened, and is not the question anybody wants answered.

So nothing here branches on either field. They are recorded, passed through, and shown. `task_completed` carries the outcome and a test holds the line that no axis may read a confidence field.

## The fail-closed rule fires on a call that worked, and that is correct

Date: 4 Sep 2026

The successful call still came back needing a person.

Its ending was `answered_unspecified`, because the Calls API has no answered-by field and this call did not declare one, and its task outcome was `met`. That pair raises the review reason about a completed task on a call where nothing establishes a person was on the line.

Which is exactly right, and worth saying plainly rather than filing as a false positive. A recording answered that call. Not a person. The reason said nothing was establishing a person was on the line, and there was not one.

It does mean a workflow calling recorded lines on purpose will see every one of them queued for review. The fix for that is not to soften the rule. It is to declare an answered-by field in the result schema, which the Calls guide already tells you to do, and which turns the reading from `absent` into `quoted` and closes the reason on its own.

## The reconciler reads the event stream, not the attempt clock

6 September 2026.

A call carries two clocks and they disagree. The attempt has `started_at` and `completed_at`, and
on a failed call those come back with no timezone and often with the same value in both, so the
duration is either unusable or zero. The event stream carries `created_at` on every event, declared
`format: date-time` in the spec, and every one we have read had a zone on it.

So the event stream is the clock, and the attempt fields are evidence about the attempt rather than
a source of timing. When the two disagree by more than a minute the reconciler says so, names both
numbers, and says which one it trusts. It does not silently pick the better one, because a caller
comparing this against their billing needs to see the gap rather than a corrected figure.

## One definition of terminal, and it lives on the client

6 September 2026.

The first draft of the flag detectors carried their own list of terminal statuses that included
`expired`, and treated `preparing` and `pending` as ordinary non-terminal states. None of those
three appear in CALL-E's `CallStatus` enum, which is exactly `queued`, `in_progress`, `completed`,
`failed`, `canceled`.

That was a status table written from a guess, which is the thing this library exists to complain
about, one level up. It is now a single definition on the client, and the reconciler asks it.

The replacement rule is better than the one it removed. `isOpen()` returns true for anything that
is not documented as terminal, so a status nobody has published counts as a call that has not
finished. `integrations#90` is a run that sat in `PREPARING` without dispatching, and a check that
only knew the documented non-terminal values would have read it as over. Not recognising a status
is not the same as the call being finished, and only one of those two mistakes rings a phone.

## The demo dials, and the guard is the number rather than the id

6 September 2026.

The live page places real calls, which makes it the one thing in this project that can ring a
phone by accident. Three rules hold it.

The destination list is fixed in the library, not accepted from the request. The check runs on the
resolved E.164 rather than the id it arrived under, so a request carrying a valid id and a
substituted number is refused. And the key is read from the server environment, never from the
browser, so the button cannot be pointed at somebody else's account.

The budget is spent before the call is placed and is not refunded when a call fails, because a
failed attempt still costs the account and a limiter that refunds errors is one you can beat by
causing them. If the counter cannot be read at all the answer is no. A demo that keeps dialling
while its own limiter is broken is worse than a demo that is briefly down.

The built-in numbers all come from the 555-01xx range, reserved for fiction and assigned to nobody.
Anything else, a published time service say, comes in through the environment on the deployment
that wants it. None of them belongs to a person, and what each should do is printed on the page
before the call goes out.
