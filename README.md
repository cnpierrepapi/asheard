# asheard

Read how a phone call ended, and know which field said so.

CALL-E reports the end of a call through three entry points, and they do not agree with each other. MCP has a status for `VOICEMAIL` and one for `BUSY`. Goal Runs has neither. The Calls API has a `failure_code` with no published enum, and their own errors guide tells you not to branch on it. Same call, three vocabularies, and code that treats one as the other is where the bugs live.

This maps all three onto three separate answers:

- **endstate**, how the call ended
- **taskOutcome**, whether the job got done
- **resultState**, whether usable data came back

They are independent on purpose. A call can end perfectly and fail its task. A task can be met while the result comes back empty. Collapse them into one status field and you lose the ability to say which of the three went wrong.

Every reading carries where it came from and how sure that is:

- `quoted`, the source stated it outright
- `derived`, we worked it out from other fields, and the note says how
- `absent`, the source cannot express this fact at all

`absent` is the load-bearing one. A mapping that cannot say "this surface does not carry that fact" will invent the fact.

## What testing turned up

These came from placing calls and reading what came back. The fixtures reproduce the shapes and nothing else, and every value in them is made up. No real call, number, time, score or transcript is in this repo.

**A call reached an answering machine and came back `task_completed: true`.** High score. The evidence it quoted was the voicemail greeting. In the same object, the declared result said the question was never answered.

**A call that rang out unanswered came back with a filled-in `structured_result`.** Right shape, both required fields present, the `evidence` field an empty string because there was no speech to quote. Any integration checking whether a result arrived gets a yes.

**`failure_message` says NO ANSWER for a busy line.** A call that rang out and one refused on the spot got the same sentence. The only field that tells them apart is a second `failure_code`, nested on the attempt, in a different vocabulary from the top-level one.

**`completion_confidence` came back high on calls that never reached a person.** It is confidence in CALL-E's own verdict, not in the task succeeding, so gating on `score >= 0.7` lets through the calls that never happened.

**A terminal status does not mean the result is attached.** Usually it is. Sometimes it comes back null and fills in later.

**Attempt timestamps change after the call ends.** Read a call twice and the offset can be gone the second time, with the value shifted and the fraction of a second dropped. The event stream holds still, so that is the clock to use.

## Using it

```ts
import { normalize, say } from "asheard/disposition";

const reading = normalize(payload);

reading.endstate.value; // "no_answer"
reading.endstate.basis; // "derived"
reading.endstate.from; // ["recipients[0].attempts[0].failure_code"]
reading.needsHuman; // true
reading.reasons; // one plain sentence per reason

say(reading).headline; // "The line was busy. A result came back from it anyway."
```

`normalize` works out which surface a payload came from and throws if it cannot tell. Guessing the closest-looking mapping table does not fail loudly. It produces a confident answer that happens to be false.

## The coverage table

`npm run matrix` prints which surface can express which ending, and it runs on the mapping code rather than on prose, so it cannot drift away from what the library actually does.

```
ending            calls-api    goal-runs           mcp
answered_human    app          derived             yes
answered_machine  app          -> no_answer        yes
no_answer         derived      yes                 yes
busy              derived      -> provider_failed  yes
declined          no           yes                 yes
provider_failed   no           yes                 yes
canceled          yes          yes                 yes
expired           no           no                  yes
```

`derived` means the library can only get there by inference. `app` means it works only if your result schema declared the field yourself. `-> x` means the surface collapses that ending onto a different one.

## The console

`call-review-console/` is a web page for people who are not going to install this. Three ways in, and you pick whichever matches what you already have.

**Paste a payload.** No key, no account, nothing stored. The reading appears with the field it came from lit up next to it.

**Paste a key** and it fetches the call itself. The key is used for one request and written nowhere. It can check a key and read a call, and that is all it can do: nothing in the app can reach the endpoint that dials a phone.

**Copy a webhook URL** into anything that already sends webhooks. Nothing to install. Everything arriving that way is marked unsigned, because CALL-E webhooks carry no signature and anybody who learns the URL can post something that looks identical to the real thing.

The webhook door needs a Redis behind it. One inbox is one list, fifty events, expiring after a day. `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or the `UPSTASH_REDIS_REST_` equivalents. Without them the endpoint says so rather than dropping events quietly.

## Running it

```
npm install
npm test      # 60 tests, no network, no credentials
npm run matrix
```

Placing real calls needs a CALL-E key in `CALLE_API_KEY`. `scripts/confidence-probe.ts` will not dial without `--to` and `--confirm`, and it has no default number.

MIT.
