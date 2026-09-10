# Phase 2, the console

Written 3 Sep 2026, before any of it exists.

## What it is

A web page that reads how a phone call ended and tells you whether you can act on it.

You give it a call. It gives you back three separate answers: how the call ended, whether the job got done, and whether usable data came back. Next to each one it says where that answer came from, and whether anybody actually stated it or we worked it out. Calls it cannot vouch for go in a queue for a person to look at.

The engine for that is done and it is what the last five phone calls were spent testing. Phase 2 is the part you can see.

## The rule that shapes everything

No developer required to adopt it. That means no npm install, no code sample, no terminal on screen at any point, including the demo.

Three ways in, and a person picks whichever one matches what they already have:

1. **Paste an API key.** The page pulls the call itself. This is the only door MCP can come through, because MCP has no webhook.
2. **Copy a webhook URL** into whatever already sends webhooks. Zapier, n8n, Make, a plain CALL-E webhook. Nothing to install.
3. **Drop a raw payload in.** Paste the JSON, get the reading. No account, no key, nothing stored.

Door three is the one that gets somebody to try it in ten seconds, so it gets built first. Door one is the demo. Door two is the one that makes it a product.

CALL-E webhooks are unauthenticated, which is their open issue #91. Anything arriving through door two is labelled unverified on the page, in plain words, because a webhook nobody signed is a claim rather than a fact.

## Screens

**The reading.** One call, three axes stacked, each with its value, its provenance, and the sentence saying why. Underneath, the reasons it needs a person, if it does. This is the whole product in one screen and everything else is a way of getting here.

**The queue.** Calls that need a person, newest first, with the reason on the row so nobody has to open it to triage. The interesting column is the reason, not the status.

It lives in local storage. The landing page promises nothing is stored, and that promise is worth more than a convenient server table. The ceiling is obvious: one browser, one profile, gone when somebody clears their site data. A queue several people work together needs a real store, and that arrives with the webhook door, because a webhook has nowhere else to land.

**The matrix.** The coverage table, rendered. Which surface can express which ending, and which cells are inference rather than fact. It prints from the mappers today and it will render from the same call, so the page cannot claim coverage the code does not have.

## Layout

The library stays where it is, at the root, MIT, no framework, no dependencies. The console is a Next app in `call-review-console/` that depends on it as a package, named for the slot it is going into so lifting it out is a copy.

Two reasons. The submission slot upstream is `apps/web/call-review-console`, so the console has to be liftable out on its own. And a library that pulls React in is not a library.

## Order of work

1. ~~Scaffold the console, wire the library in, prove the import works in a page~~
2. ~~Door three, paste a payload, get a reading. The reading screen exists at the end of this step~~
3. ~~The queue~~
4. Door one, paste a key, pull a call
5. Door two, the webhook endpoint, with the unverified labelling
6. The matrix page
7. ~~Deploy~~, ~~the README~~, then the upstream PR

Deploy and README came early. A public repo with nothing in it is a bad look, and the console
needed somewhere to be seen.

The queue turned out smaller than planned and it is worth saying why. It does not touch the ledger.
The ledger remembers what was *authorized* before a call goes out, which is a different job from
remembering what came *back*, and nothing has been authorized through the console yet. That
changes at step 4.

Design gets proposed before step 2 draws anything, because that step is where the product starts looking like something.

## Not in Phase 2

No accounts. No database beyond what the ledger needs. No provider adapters other than CALL-E, though the axes were built provider-agnostic on purpose and Vapi, Retell and Bland disagree with each other in exactly the same way.
