# Architecture

## The problem this solves

CALL-E can be driven three ways: the Calls API, Goal Runs, and MCP. Same platform, same phone network, same call. But the three report how a call ended in three different vocabularies, and they do not agree.

MCP will tell you a voicemail box picked up. Goal Runs has no word for voicemail at all. The Calls API has no word for anything: its `failure_code` is a free-text string with no published enum, and CALL-E's own error guide tells you not to branch on it.

So the same real event, nobody home, arrives as `NO_ANSWER` on one surface, `no_answer` on another, and on the third as `status: "failed"` plus a string you were told to ignore.

Anything that acts on a call outcome has to bridge that gap. Most code bridges it by guessing.

## The three axes

The core idea is that a finished call is not one fact. It is three, and they are independent.

**Endstate** is how the phone call ended. Somebody answered, a machine answered, it rang out, the line was busy, they hung up on the robot, the carrier fell over.

**Task outcome** is whether the thing you called to do got done. A call can end perfectly and fail its job. You reached a human, had a lovely chat, and never got the answer.

**Result state** is whether usable structured data came back. You can meet the task and still get `null`, because extraction is a separate step that can fail on its own.

Collapse these into one status field and you get the bug every integration has: ambiguity lands in the success branch, and a human is told a job is done when nobody knows if it is.

Each axis is read as an `AxisReading`, which carries the value plus how it was arrived at:

- `quoted` means the source said it outright
- `derived` means we inferred it, and the note says from what
- `absent` means the source cannot express this at all, so the value is `unknown`

That third state is the whole design. A mapping that cannot say "this surface does not carry that fact" will invent the fact instead.

## Layout

```
src/disposition/
  axes.ts               the three enums, the reading type, the fail-closed review rule
  normalize.ts          one entry point, plus surface detection that refuses to guess
  surfaces/
    calls-api.ts        the surface that says the least
    goal-runs.ts        real error enum, no voicemail, no busy
    mcp.ts              richest on endings, cannot ask for a result at all
fixtures/               documented payload shapes, one per interesting cell
scripts/print-matrix.ts prints the coverage table from the mappers themselves
test/                   twenty tests, no credentials, no network
```

## Why detection refuses

`detectSurface` returns null on anything ambiguous and `normalize` throws. Picking the closest-looking surface would mean picking the wrong mapping table, and a wrong table does not fail loudly. It produces a confident answer that happens to be false. Better to make the caller say which surface it is.

## Why `needsHuman` is computed, not passed in

`reviewFlags` decides it from the three readings, and it errs toward the human every time. An unknown endstate routes to review. A derived endstate routes to review, even when the inference is a good one. A null result where a schema was requested routes to review.

The rule is that doubt is a state to reconcile, not an error to swallow. Uncertainty gets to survive all the way to the person looking at the queue, with the sentence explaining where it came from.

## What is not here yet

No console. No ledger. No adapters for anyone but CALL-E. Phase 0 is the engine and the evidence that the engine is telling the truth.

## The fourth result state

`ResultState` was three values through Phase 0: `valid`, `null`, `schema_invalid`, plus `not_requested` for calls that never asked. Live traffic added a fourth.

`unsourced` means a result object is sitting there in the right shape, on a call that never reached a conversation. The Calls API produces these. A call that rang out unanswered still came back carrying a schema-shaped result whose required evidence field was an empty string.

Think of it as a form that came back filled in from a meeting that never happened. Every box has something in it. None of it came from anybody.

`mapResultState` in `surfaces/calls-api.ts` now checks `status` before it credits a result. Anything other than `completed` with a result present reads `unsourced`, basis `derived`, and `reviewFlags` routes it to a person.

The other two surfaces are untouched. Goal Runs and MCP may well do the same thing, but no call has been placed through either yet, and a mapping written from a hunch is the failure mode this project is about.

## The reconciler

`src/reconciler/` answers a different question from `src/disposition/`. The disposition engine reads
one payload and says what it means. The reconciler takes every signal about a call at once and says
whether the platform's own account of it holds together.

The pipeline is five steps and each one is a separate file so the boundaries stay honest.

`evidence.ts` arranges what you already fetched into one document. Nothing downstream is allowed to
read past it into a raw payload, because a renderer with access to the payload starts forming its
own opinions and then two parts of the system disagree while both look right. Every item carries the
field it came from and `sourced()` throws on an empty source list, so a fact with no provenance
cannot enter the document at all. It never touches the network, so the whole thing runs off fixtures.

`flags.ts` runs four detectors over the finished document. Each one is an open issue written as code
that executes: a call nobody is watching, a call that may have gone out twice, a key that is not safe
to send again, and a clock that does not add up. They read fields and nothing else. No transcript is
interpreted, no confidence score is consulted, and no model is asked.

`rank.ts` puts the calls in order. The order is a declared table of seven bands rather than a
comparator, because the order is the product and it should be arguable in review. First match wins
going down, so a call that is both stuck and badly timed is reported as stuck. The last band
collapses to a single line, which is the point: a briefing that lists forty fine calls has buried
the three that are not.

`phrase.ts` turns a band and a reading into words. Four slots, at most two used per line, and the
doubts are ordered so only the most serious is ever spoken. Every sentence is a function of a
reading, which means it can be pointed at in code, it says the same thing every time, and it cannot
drift during a demo.

`destinations.ts` holds the only numbers the live page may dial.

The console's `/live` route is the one place that calls `createCall`. Everything else in that app
remains read-only by construction.
