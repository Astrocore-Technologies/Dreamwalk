# Image generation preparation

## Current boundary

The production service uses **only `FixtureImageProvider`**. Its deterministic 64 × 64 PNG is a synthetic pipeline sample, not AI artwork or a promise of output quality. External generation is hard-disabled. Adding an API key does not enable it.

A concrete fixed-endpoint OpenAI adapter exists for injected-transport verification. It uses one request, no redirects and no retry; generation and owned-reference edits are separate endpoints. No real provider request has been made by this implementation. The candidate model is pinned to `gpt-image-2.5-sunburst-2026-09-08`; no fallback model is selected.

The user's separate $1 text and $1 image allowances are ceilings, not proof of a provider-enforced per-request upper bound. The image endpoint does not currently provide a verified total request ceiling in this integration. Live activation remains blocked until that bound, explicit independent consent, network permission, credentials, pricing and a validated production provider factory are established. This is not an environment toggle awaiting a key. Text allowances cannot be borrowed for images.

## API

All routes are authenticated under `/api/v1/image-generation`:

- `GET /config`: fixture availability and explicit external blocking reasons.
- `POST /quotes`: owned adventure, prompt, title, kind, camera, tags, opaque/transparent background, up to two owned reference revision IDs and generated-rights attestation. Searches the authorized reusable library first. Returns free reuse matches, or an expiring quote after explicit `declineReuse`.
- `POST /jobs`: `quoteId`, stable UUID `operationId`, and literal `consent: true`. One quote can fund only one job; same operation replays the same safe result, conflicting reuse fails.
- `GET /jobs?adventureId=…` and `GET /jobs/:id`: own safe status, cost and admitted revision identifiers. No raw prompt or reference contents.
- `POST /jobs/:id/cancel`: requests cancellation; it is not a promise of a refund after dispatch.

Quotes default to five minutes. The canonical consent hash includes normalized input, reference hashes, policy version, provider identity and upper cost. Queue consumption and dispatch recheck it. Source ownership, active account, source archive state and owned reference availability are rechecked before dispatch and admission. A reusable-asset grant is not derivative permission: reference edits accept only assets owned by the requesting author.

## Durable lifecycle

`queued → dispatched → generated → admitted` is the successful path. `expired`, `cancelled` and `rejected` are terminal game/admission outcomes; `unknown` retains uncertain financial exposure.

The dispatch attempt and deadline are committed before network work. There is one attempt per job. A process crash or timeout after this marker never causes an automatic resend. A trusted receipt can reconcile an uncertain result; there is no public receipt injection route. Conflicting bytes, receipt identity or actual cost fail closed. Known actual cost is recorded even if authorization has since been revoked or the raster is rejected. Unknown usage is never treated as zero.

The shared reservation ledger serializes scope totals and separate text/image ceilings. Held upper bounds count against capacity; settled actual costs replace them. Only proven undispatched work releases a reserve. A late positive liability after release or an overrun blocks the scope while retaining the actual cost. The general text ledger contract exists, but the separate live text test kit and existing NPC payment system are not silently joined to this ledger. No combined live-budget claim is made.

## Raster admission and storage

Generation and ordinary uploads use the same raster normalizer and quota lock. Accepted input is static PNG/JPEG/WebP, at most 5 MiB and 4096 × 4096. Metadata is removed and output normalized to WebP. Sprite/object requests require real alpha with both visible and non-opaque pixels; an opaque checkerboard is not transparency.

Each pending job reserves 5 MiB of upload capacity. Existing uploads and pending reservations share the 200-image / 100-MiB author quota. Admission atomically creates the upload, immutable reusable revision and job mapping using deterministic IDs. The revision is not automatically selected, bound to a map, published or moderated. The author explicitly chooses that next action.

Raw provider output is quarantined under a deterministic UUID filename. Normal success, cancellation and rejection enqueue durable deletion; failed unlink remains queued. Confirmed account erasure also discovers deterministic orphan files left by a crash before a database commit. The operator deletes confined quarantine files inside the confirmed erasure transaction; non-ENOENT failures abort for a safe retry. Financial uncertainty survives content deletion without retaining private prompt text.

## Limits and privacy

The default service permits 30 quotes per author per minute and four active generation jobs. Library search/reuse incurs no provider charge. No automatic regeneration, expansion to other providers, background paid batch, derivative use of foreign references, or automatic public posting exists.

Provider input/output byte counts, image count, MIME, model, timeout and pricing integers are bounded. Missing or malformed usage leaves exposure held. Output token costing uses the configured image-output rate conservatively; live deployment must verify the selected provider's actual usage semantics and worst-case request cost, not infer them from sample receipts.

Public status omits prompts. Account export includes the requesting user's own job and quote input, selected reference IDs and financial metadata, not foreign reference bytes or credentials. Confirmed erasure scrubs all personal job/quote payloads, including admitted jobs, and cancels pending admission. Financial audit records are retained without actor linkage where required by the ledger design.

## Verification and remaining work

Independent tests in `tests/images/` run against disposable PostgreSQL with fixture/injected providers. They exercise authorization, reuse, explicit consent, duplicate operations, caps, concurrent settlement, unknown dispatch recovery, source/reference revocation, raster rejection, admission and real operator erasure cleanup. Browser source separately exercises the Studio fixture flow; its execution status must be reported from CI, not inferred from backend tests.

Before live release: obtain an enforceable cost upper bound and explicit authorization; implement the validated production provider-selection/approval factory and kill switch; supply secrets through an approved secret channel; then run the separately authorized bounded live test. Automatic provider retry remains prohibited for ambiguous attempts. Broader lifecycle retention policy for old financial/prompt records must be agreed separately; this module provides explicit account erasure and durable quarantine cleanup, not an unapproved blanket deletion schedule.
