# Manual live test session

This local-only mode requires separately authorized manual testing. Starting the API, opening a page, idling, submitting a local mechanical action, and ending a turn do not authorize paid calls. A queued world decision waits for a separate, explicit consent for that exact request. No live smoke test is part of the implementation checks.

## Fixed request envelope

The model ID is `gpt-6-luna`, the current non-deprecated small model documented by [OpenAI](https://developers.openai.com/api/docs/models/gpt-6-luna). The model page currently lists no dated snapshot. There is no automatic model fallback or retry.

The Responses request uses the official endpoint, Standard (`service_tier: default`), `store: false`, `stream: false`, no tools, `reasoning.effort: none`, at most 64,000 serialized request bytes and `max_output_tokens: 2048`. [OpenAI documents](https://developers.openai.com/api/docs/guides/reasoning) that this output limit includes reasoning and visible output tokens.

The application reserves the entire 1,050,000-token model context, deliberately avoiding a guessed byte-to-token ratio. It uses conservative rates of USD 0.25 per million input tokens (including the documented long-context/cache-write uplift) and USD 0.75 per million output tokens. Therefore each authorization reserves exactly 264,036 USD micro-units, or USD 0.264036. Settlement debits the reported token counts at those conservative configured rates. This debit is a budget safeguard, not an assertion of the provider's invoice charge.

## One combined authorization

`generation_budget_reservations` is the shared text/image ledger. The implementation uses the fixed scope `manual-live-test-20261031`, a combined cap of 1,000,000 USD micro-units, one configured owner and an absolute expiry of at most two hours. When prior reservations or unknown-cost receipts exist, a new session must not erase, unblock, retry or roll them into a fresh operation. A new grant cannot reconcile an unknown liability. Status is limited to the durable records in its configured database.

The session UUID, owner and absolute expiry are immutable after claim. Restarting the process does not renew them. A unique scope prevents a new UUID from silently starting another USD 1 grant in this database. Text and image reservations serialize on the same scope row. Text's existing provider ledger remains an additional restrictive safeguard; it cannot increase the shared allowance.

A dispatched request has one durable claim. Unknown cost, transport uncertainty or HTTP 403 stops further use and retains the whole unknown reserve. Late known usage can settle the hold without resuming the stopped session. A crashed, overdue dispatch also blocks further authorization. There is no automatic retry, model fallback, fanout approval or idle provider work.

Real images remain disabled: the verified hard upper-bound prerequisite has not been met. An estimated image price and a budget cap are not treated as a verified bound. Future image authorization uses `ImageGenerationService.setLiveAuthorizer` and the same session/scope, with current ownership and expiry checks at quote, queue, dispatch and admission.

## Local configuration and secret handling

`scripts/preview-verified.mjs --manual-live --resume-owned` reads immutable, non-secret grant metadata from `.local/verified-preview/manual-session.json`. It requires `LIVE_TEST_ENABLED=true`, `LIVE_TEST_SESSION_ID`, `LIVE_TEST_OWNER_ID` and absolute `LIVE_TEST_EXPIRES_AT` for the API. The server-side loader requires an explicitly supplied absolute `DREAMWALK_LIVE_SECRET_FILE` path, with no default location or automatic credential discovery. It reads only `NPC_AI_API_KEY` from the user-authorized private file, rejects duplicates, command substitution, symlinks and oversized input, and passes that one credential only through the API child process environment. It does not load arbitrary dotenv variables, print the credential, place it in argv, write another copy, or give it to the web process. The provider passes it only as authorization to `https://api.openai.com/v1/responses`; redirects are rejected.

Tests scrub `NPC_AI_*`, `LIVE_TEST_*` and `IMAGE_*` from child environments. The loader tests use synthetic files. Never run the manual launcher as a smoke test or use an endpoint mutation as a readiness check.

## Authenticated endpoints

- `GET /api/v1/live-test/status`: safe effective parameters, conservative budget debit/held/remaining, expiry and stop state; owner only.
- `POST /api/v1/live-test/claim` with `{consent:true}`: explicit immutable session claim; never automatic on page load.
- `GET /api/v1/live-test/campaigns/:id/requests`: safe ordered request IDs, purposes, subjects, permit state, per-request upper bound and the world phase fence. No prompts, secrets or private dialogue are returned.
- `POST /api/v1/live-test/campaigns/:id/requests/:requestId/consent` with `{sessionId,operationId,turnFence,consent:true}`: authorize exactly one queued or reserved, undispatched decision. Membership, source access, owner, context hash, phase, budget and expiry are checked again before dispatch.

The engine's existing durable commit fences still reject late or stale proposals. A consent grants permission to attempt a bounded request; it does not guarantee model availability, output validity or narrative success.

## Workshop and launch coverage

The visual workshop has explicit fixture and external modes. External creation has
no fixture fallback. New locations default to the separately confirmed, validated
[AI spatial planner](ai-spatial-planner.md); a free manual template is an explicit
alternative. The model supplies geometry and public prose, while server-pinned
author rules remain authoritative. Character concept, portrait and transparent directional
sheet are separately admitted; a portrait alone is incomplete. Location background,
furniture, door variants and actors have separate image roles. Structural raster
validation and separate human visual approval precede immutable package assembly.
A one-image allowance does not cover automatic production of a complete package.

The fixed image profile is gpt-image-2.5-sunburst-2026-09-08,1024x1024,low,onePNG.
The current official guide provides an output-token estimate, not a maximum covering
all billed input/output tokens. For a first request without reference images, using
8,000texttokens plus196outputtokens gives a planning estimate of USD0.04588.
USD0.10 is a proposed operational reserve, not a verified invoice maximum. Under
the strict cost-bound policy image dispatch remains disabled; a failed provider call
is never retried automatically. Image reference processing needs its own reviewed
evidence; the vision tile calculator explicitly does not cover GPT Image generation.

Sources:
https://developers.openai.com/api/reference/resources/images/methods/generate
https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency
https://developers.openai.com/api/docs/guides/images-vision#calculating-costs

The isolated local launcher accepts --manual-live only with --resume-owned and an
ignored .local/verified-preview/manual-session.json containing sessionId,ownerId,
expiresAt. The absolute expiry is never renewed at restart. The owned database must
already be running; native PostgreSQL recovery is required if it is stopped. The
launcher refuses duplicate listeners, applies compatible migrations without reseeding,
and records only process identifiers, mode and expiry. All services bind loopback.
The API alone receives the authorized key through the reviewed child-process loader;
Next.js, browser data, logs and process argv never receive it.

After checks and preparation, the entry point is:

    npm run local -- node scripts/preview-verified.mjs --resume-owned --manual-live

Fixture test children remove inherited live/image approvals. Automated checks use
synthetic providers; starting the reviewed launcher performs no paid smoke request.
