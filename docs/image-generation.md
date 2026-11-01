# Image generation preparation

## Current boundary

`ImageGenerationService` now constructs a validated server-owned runtime in `image-generation/config.ts`. The default remains a local `FixtureImageProvider`: its deterministic 64 × 64 raster is a pipeline fixture, not generated artwork. The router selects the fixture for every `mock` request even if a real provider is configured. A configured `external` request uses the concrete OpenAI adapter; there is no provider/model fallback and no automatic retry.

The selected request profile is pinned to `gpt-image-2.5-sunburst-2026-09-08`, one 1024 × 1024 PNG, explicit `low` quality, `auto` moderation, at most 8000 UTF-8 prompt bytes and two owned references. Background may be opaque or transparent. The fixed endpoint is `/v1/images/generations` without references and `/v1/images/edits` with references; redirects are rejected. Neither URLs nor provider options can be supplied by the browser.

Official model and image-generation documentation were reviewed on 2026-10-31. Standard direct Images API rates are USD 5 / million text input tokens, USD 8 / million image input tokens and USD 30 / million image output tokens. Batch and cached-input rates are not applicable to this direct transport. These rates are cost components, not a complete price or a hard request ceiling. The guide's output calculator is an estimate and excludes inputs. **A defensible full request ceiling has not been established; real image generation therefore remains unavailable.** Real account/model availability, billing semantics and artwork quality have not been verified by these synthetic tests.

Sources: [pinned model and pricing](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst), [image generation and calculator limitations](https://developers.openai.com/api/docs/guides/image-generation).

## Server configuration and manual activation

Adding a key alone does not enable external generation. The factory requires all non-secret gates before resolving a runtime credential:

- `IMAGE_PROVIDER=openai`, `IMAGE_EXTERNAL_ENABLED=true`, `IMAGE_NETWORK_APPROVED=true` and `IMAGE_SPEND_AUTHORIZED=true`.
- A nonempty operator authorization identifier in `IMAGE_APPROVAL_ID` and explicit integer micro-USD limits in `IMAGE_APPROVAL_TOTAL_MICROS`, `IMAGE_APPROVAL_IMAGE_MICROS`, `IMAGE_APPROVAL_TEXT_MICROS`.
- `IMAGE_PRICING_ID=openai-images-standard-20261031`. This reviewed rate record expires on 2026-11-01; renewal requires reviewing current official pricing and changing the versioned record, not bypassing the check.
- `IMAGE_COST_BOUND_JSON`: a reviewed provider contract or verified token ceiling covering the exact model, dimensions, quality, output count, maximum prompt bytes, reference count/pixels, **all** text/image input and image output token ceilings, a sufficient total `upperMicros`, official evidence URL, verification date and expiry. Calculator estimates and allowances are rejected as evidence kinds. No valid production bound is shipped. Invented proof in tests is explicitly synthetic and must never be used to activate a real account.
- A manual live-test session ID and an installed server authorizer are required at quote, enqueue, dispatch and admission. Its returned policy selects the durable shared text/image authorization scope. A configured manual budget is not automatic permission for this process to run a provider request. Any prior unknown-cost liability must be retained separately and cannot be refunded or reset by a new grant.

The runtime reads no dotenv files. Credentials are resolved server-side only through the authorized runtime loader; capabilities, quotes, job DTOs, fingerprints and logs never include credential values. `OPENAI_API_KEY` is the default runtime variable, not a UI setting. The separately reviewed saved-secret loader owns any local file access. Do not place secrets in tracked examples, browser input, screenshots or PRs.

`GET /config` reports the fixed profile, reviewed rate record, `costStatus`, `verifiedUpperMicros`, credential presence state and canonical blocking codes. `providerEnforcesQuotedCap:false` is explicit: the application ledger prevents new reservations beyond its cap but cannot cap a provider's bill for a request already sent. Changing profile, rates, bound or authorization identity changes the policy/provider fingerprint and invalidates old quotes. Expired proof/rates block dispatch, including after server startup. Disabling external generation needs no key removal.

## API

All routes are authenticated under `/api/v1/image-generation`:

- `GET /config`: fixture availability and explicit external blocking reasons.
- `POST /quotes`: owned adventure or private authoring project context, prompt, title, kind, camera, tags, opaque/transparent background, up to two combined owned reference revision IDs/private source-photo asset IDs and generated-rights attestation. Private photo references require an authoring context and a server canonical validator; they never enter searchable source metadata. Player character projects do not require a fabricated adventure. Searches the authorized reusable library first. Returns free reuse matches, or an expiring quote after explicit `declineReuse`.
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

Before a real image test: establish a defensible complete request upper bound and explicit manual authorization; review current pricing and account/model access; supply credentials through the authorized runtime secret loader; activate the manual shared-budget session; then let the user explicitly consent to one quoted request. The validated factory and kill switch are implemented; the missing request bound still blocks activation. Automatic provider retry remains prohibited for ambiguous attempts. Broader lifecycle retention policy for old financial/prompt records must be agreed separately; this module provides explicit account erasure and durable quarantine cleanup, not an unapproved blanket deletion schedule.

## Private authoring integration

`GenerationRequest.authoringContext` pins project ID, expected stage revision, source hash, concept/parts stage and role. `setAuthoringValidator` must be installed by the authoring service; no hook means fail-closed. The image engine checks project ownership, cancellation/source fences, optional adventure consistency and active account, then calls the canonical validator at quote, enqueue, dispatch and admission. The validator binds exact prompts, role, approved concept, separate photo transmission permission and output rights.

`privateReferenceAssetIds` accepts at most one owner upload and at most two combined references. It is accepted only for authoring projects. Owner and takedown checks repeat before transport and admission; hashes join the consent fingerprint. Only bounded local raster bytes go to the provider. The source photo is never registered as a reusable revision by the image engine. Output reuse remains an explicit independent rights setting.

`tests/images/config.test.mjs` runs directly with `node --import tsx --test` and injected transports. It verifies that defaults, malformed configuration, absent consent, stale pricing/proof and partial estimates read no credential or dispatch; explicit fixture mode never uses the external transport; complete synthetic configuration sends exactly one fixed request; public capabilities contain no secret; and private source references require the correct context. These tests incur zero real provider calls.

## Prepared estimate mode (hard-disabled)

The default strict mode above is unchanged. A separate **offline-prepared** estimate profile exists for an owner who explicitly accepts an estimated budget rather than a guaranteed maximum invoice. This preparation does not authorize a provider call. The UI blocks dispatch of quotes with a null verified ceiling.

The first profile is `openai-no-reference-estimate-20261031`: the same pinned model, one 1024 × 1024 low-quality PNG, no streaming or partial images, at most 8000 UTF-8 prompt bytes, and **zero references**, including source photos. It plans conservatively for 8000 text input tokens (USD 0.040000), no image input, and the guide's estimated196 image output tokens (USD 0.005880): estimated total USD 0.045880. It reserves USD 0.100000 operationally. The token assumptions, estimate and reserve do not establish an invoice ceiling. No reference-image token estimate is supplied, so photo/concept-derived part requests remain blocked in this profile.

In addition to the standard provider/network/spend/pricing gates, preparation requires explicit server settings `IMAGE_COST_MODE=estimate`, `IMAGE_ESTIMATE_PROFILE_ID=openai-no-reference-estimate-20261031`, `IMAGE_ESTIMATE_RISK_APPROVED=true`, a nonempty `IMAGE_ESTIMATE_RISK_APPROVAL_ID` and `IMAGE_ESTIMATE_RISK_EXPIRES_AT` within two hours. The combined text/image approval cap must not exceed USD 1. Environment flags alone cannot release this prepared mode: the factory and OpenAI adapter independently hard-block estimate dispatch with `ESTIMATE_DISPATCH_APPROVAL_PENDING`. Releasing this mode requires a separate reviewed cost policy and explicit informed authorization. The authenticated manual-session authorizer and per-job consent remain necessary in any future released mode.

Public configuration and estimate quotes keep `verifiedUpperMicros:null`. Estimate quotes also keep legacy `upperMicros:null` and expose `costBasis:approved_estimate`, `estimatedTotalMicros:45880`, `reserveMicros:100000`. They never label the reserve as a verified price. Migration033 durably records `cost_basis` and `estimated_total_micros` on quotes and jobs, so later configuration changes cannot relabel a historical estimate as verified. The existing database `upper_micros` reservation column stores the operational reserve in this mode; it does not become a provider-enforced cap. Account exports retain that basis alongside accounting amounts.

The shared authorization scope can enforce `serialize_outstanding`: all text and image reservations use the same locked scope row, and only one held request is permitted across both kinds. Exact idempotent replay returns its original reservation before the exclusivity check. A later known settlement permits the next manual request; unknown outcomes keep the hold and block another request.403, unknown provider outcomes and late costs are never treated as refunds or retry permission. A known cost above the operational reserve is preserved and blocks subsequent spend.

## Studio step3 location image path

The location card's external-only image dialog uses `POST /image-generation/studio-locations/prepare` with `adventureId` and the saved `locationId`. Studio must flush its ordinary draft autosave first. The server extracts only the saved title, synopsis, public world and selected location name/description; it returns a canonical, read-only background request and source hash/edit revision. It does not require a playable map or generate collision geometry. Long public references are excerpted explicitly. A forged prompt/spec or changed source invalidates quote, dispatch and admission.

The dialog uses the existing quote → explicit consent → durable image job → immutable library admission path. `externalOnly` prevents a fixture fallback. Real sending remains blocked by the fail-closed cost-bound requirement; fixture tests are not presented as generated artwork. The manual service resolver accesses the existing authorized `NPC_AI_API_KEY` variable only for `LIVE_TEST_ENABLED`, after non-secret provider/cost gates; the generic runtime uses `OPENAI_API_KEY`. No secret files or new key copies are introduced by this path.

`POST /image-generation/studio-locations/bind` explicitly selects an authorized library revision for the saved location. Migration035 stores this location-to-image binding even before geometry exists. Prepare returns the saved revision ID, stale-source indicator and actual candidate maps linked by `sourceLocationId`. Source, owner, grant/takedown, drawn2D background/top-down camera checks are transactional. Repeated operation IDs replay one receipt.

A later explicit binding with a real `mapId`, expected playable revision and expected art revision updates only `map:<actual-id>:background` in the existing art draft. The map must compile and point to that source location; its geometry is unchanged. The ordinary immutable playable publication/pin path carries that existing art binding into play. Account export includes owner location bindings, and confirmed erasure removes location binding/operation rows.

The focused `integration-studio-location.test.mjs` verifies the exact source → library → location → existing-map path against isolated PostgreSQL using a provider labeled `synthetic-studio-location-NOT-OPENAI`. It also proves the production real-image gate rejects the same prepared request and creates zero attempts. This is wiring evidence, not a successful live image test.
