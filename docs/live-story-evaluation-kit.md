# Bounded ordinary-story evaluation kit

This is preparation, **not authorization to run paid requests** and not a report of
model quality. The exact `gpt-6-luna` model is retained. Images, translation,
Discord, payments, deployment and the managed preview are outside this kit.

## Modes

- `node scripts/evaluate-live-story.mjs`: print the plan only. No environment/key,
  database or network access occurs in this path.
- `node scripts/evaluate-live-story.mjs --rehearse`: separate local PostgreSQL/API,
  two synthetic authenticated players, actual GameService/director/speech/save
  pipeline and an injected fake Responses transport. No external fallback exists.
  This proves harness mechanics, **not natural dialogue quality**.
- `--execute`: additionally requires `LIVE_STORY_APPROVED` to equal
  `text-only-four-requests-carried-10769` and a fresh `NPC_AI_API_KEY` supplied
  through the authorized secure child-process environment. Do not put a key in
  command arguments, a committed file, shell history, this document or a report.
  Never automatically reuse a prior key. The selected runtime must have explicitly
  permitted OpenAI API egress; documentation browsing is not proof of that route.

The execution ledger uses PostgreSQL WAL, not directory `fsync` or POSIX lock
files. Linux zero-network acceptance is verified; Windows must pass the same
zero-network commands on the intended machine before any secure key entry.
Legacy file-ledger unit cases are skipped on Windows; the PostgreSQL durability
and crash tests are not skipped. No Windows execution success is implied here.

Run from the repository root after dependencies and the API/contracts/core build
are prepared. The explicit prerequisites (performed separately, never implicitly by
this kit) are:

```sh
npm ci
npm run build -w @dreamwalk/contracts
npm run build -w @dreamwalk/game-core
npm run build -w @dreamwalk/api
node --test tests/live-story-guard.test.mjs tests/game/npc-semantic-context.test.cjs
node scripts/test-live-story-pg.mjs
node scripts/evaluate-live-story.mjs --rehearse
```

The kit does not install packages, build source, restart the preview
or operate the user's installation. It uses unique local service ports and a
separate `.local/live-story-*` database. Synthetic campaign data stays there for
inspection; the application and database stop at the end.

## Allowance and accounting

The original text allowance remains USD 1, **not a new USD 1 per run**. Carried debit
is a conservative reserve of 10769 micro-USD, leaving 989231 micro-USD before
this kit. Reconciled prior receipts total 769 micro-USD (74 smoke + 695 game);
the additional 10000 micro-USD safety reserve is deliberately retained rather than
automatically increasing the available allowance. This run may reserve at most 200000
micro-USD, with at most four dispatches, 50000 upper micro-USD each. These ceilings
include all requests reaching the transport, not merely manually clicked actions.
The image allowance is not used.

The fixed live database cluster is `.local/live-story-evaluation-20261031`.
Its `live_story_evaluation_ledger` row, ID `approved-text-evaluation-20261031`, is
the financial authority. A dedicated PostgreSQL session advisory lock excludes
concurrent evaluators. Startup verifies `fsync`, `full_page_writes` and
`synchronous_commit` are on; each reservation UPDATE commits before dispatch.
Rehearsals and guard tests use separate unique clusters, never the preview DB.

A missing row in an existing database, a policy mismatch or an old JSON ledger
fails closed for manual reconciliation. Reopening does not clear receipts or
restore the allowance. Never delete or reset the live cluster to retry. A crash
releases the session lock but leaves the committed reservation: another process
cannot dispatch while any exposure remains reserved or unknown. Lost database
connectivity cannot convert an uncommitted success into permission to retry.
An ambiguous network/usage/tier outcome retains the whole upper exposure and
requires human reconciliation. A model refusal, invalid proposal or quality
failure is not permission for automatic regeneration. Private `report.json`
files are reports, not replacement ledgers.

The fresh key is consumed only after explicit execution approval, removed from
the outer process environment before PostgreSQL/bootstrap children start, and
passed only to the API child. Rehearsal strips inherited key variables without
reading them. Neither path writes credentials into configuration or reports.

The adapter explicitly requests `service_tier: default` and rejects an unknown or
different returned tier as financially uncertain. Requests have no tools, response
history, streaming or storage. Serialized input is capped at 64000 UTF-8 bytes;
the accounting input bound adds 4096 for protocol/schema overhead. Output is capped
at 4096 tokens, including reasoning output. The guard uses conservative configured
rates 550000/825000 micro-USD per million input/output tokens and retains both the HTTP `x-request-id` and response body `id` separately
when available. These receipts identify the request and response, not an invoice. These are pessimistic accounting assumptions, **not an OpenAI invoice
hard-limit guarantee**. Unexpected usage/tier blocks continuation. Provider billing
reconciliation remains necessary.

Official documentation checked 2026-10-31:

- [Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Pricing, including cache writes and regional uplift](https://developers.openai.com/api/docs/pricing)
- [Responses processing tier](https://developers.openai.com/api/reference/python/resources/responses/methods/create)

## Actual workflow and evidence

Two independently authenticated synthetic players select owned heroes and start
one published adventure. Ordinary director input requests a grounded connected
room and a fresh supporting NPC. Both enter the real scene. Ordinary NPC speech
uses explicit sponsor consent; a second director turn references confirmed canon,
and a second conversation checks public episodic continuity. The isolated API is restarted against the same database and ledger; both clients
reconnect and compare the saved shared history. No direct SQL creates the expected result.

The report separates mechanical validity from human quality review: player intent,
premise/role consistency, causal continuity, remembered public exchange, helpfulness
and language. A generic safe reply remains a quality failure. Synthetic narration
and safe receipt identifiers can appear in the private report; credentials, cookies,
private user history and raw HTTP headers cannot. A passed rehearsal is not a passed
live evaluation.
