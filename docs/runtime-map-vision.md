# Runtime map vision (KAN-5)

The runtime can now send actual current-location pixels with authoritative player/NPC
positions to the same Responses request that produces the story beat or NPC response.
This is separate from the initial story-planning analysis in #52. It does not add
collision, move characters, repair old spawns or regenerate art.

## Input and privacy

- The source is the current map's exact immutable playable/campaign background pin.
  A schematic legacy map may use the same preserved playable illustration as the
  canvas. There is no author-draft, generation-prompt, URL or other-map lookup.
- Source access, accepted player membership, live campaign/asset owners and takedowns
  are checked. Normal background revisions must match their frozen source hash.
- Server perception is intersected across the player/NPC/listeners of a shared reply.
  Only the common visible cells and fully visible entity footprints enter the input.
  Unknown raster pixels are removed before sampling/compression, not just described
  as hidden in a prompt. Source pixels outside that mask cannot affect output pixels.
- A deterministic 768-square JPEG contains the image at the same contain transform
  as the canvas, a coordinate guide and numbered markers. The JSON legend carries
  public IDs, labels, kinds and exact committed positions/footprints. Raw observer
  IDs are internal fences and are omitted from provider prose.
- Painted figures are scenery, never automatically materialized NPCs. Water,
  buildings and other terrain can be interpreted as uncertain visual observations.
  They grant no movement/action rights. An old token on painted water remains at its
  confirmed position; the model is told not to invent a safe location or relocate it.
- Before cache reuse and external dispatch, the current view, positions, map,
  background revision/hash and access/takedown status are rechecked. A mismatch
  invalidates the quoted request instead of silently replacing or repricing it.

## Enabled release path: one quote and one generation

At the owner's explicit request, release profiles using `gpt-6-luna`, per-request
`contextBudgetTokens` and `estimation` now default to `text.runtimeVision` with
`counting: "operational_exact"`. `text.runtimeVision: false` opts out. Other models,
owner/manual modes and profiles without per-request planning are unchanged. An
explicit reviewed allowance policy remains compatible. No image multiplier or
`inputTokensPerImage` is invented, and there is no fixed 20-Spark reserve or new
cumulative spending cap.

The default uses the existing profile's tariff and pricing validity, one high-detail
image, and a 272,000-input-token pricing boundary. This is the documented Luna
long-context tariff threshold, not a guessed image-token count. The ordinary
configuration fingerprint and release deployment revision include the policy.

Only a player's explicit gameplay quote POST can initiate an operational count.
The UI discloses image/token counting before that action. The first local pass
prepares the exact audience-authorized request; all campaign serialization and SQL
transactions unwind before `/v1/responses/input_tokens` is called. Access, source
pins and source takedowns are checked again immediately before that call. The local
quote is then rebuilt, with stable turn IDs and the same frozen body, after which
the existing single player confirmation authorizes generation. GETs, typing,
startup and worker ticks never initiate counting or silently retry it.

Migration 057 records only operation metadata, body hash, model/provider identity,
status and exact input tokens. It does not store images, labels, prompts or keys.
Successful evidence is reused for ten minutes for the same immutable body and
model/policy; an explicit later quote refreshes it, avoiding an indefinite count
cache for a mutable model alias. Queue
admission reloads it after restart; a dispatched generation also carries its durable
quote snapshot. Changed images/positions/settings invalidate that evidence rather
than silently repricing the accepted request. An uncertain or interrupted count is
not replayed automatically, including after restart. A changed state during counting
requires a fresh quote. Missing count access and over-window/tariff inputs produce
specific errors before generation.

The exact input count is combined with the existing output reservation and margin.
Final generation settlement still uses actual reported input/output/cache usage.
The count response does not prove an invoice amount: `provider_fee_micros` stays
NULL and `cost_basis` is `unverified_operational`. This operational fee is not claimed
to be free, is not fabricated into the player's Spark/Dream ledger, and remains
available for operator reconciliation. One successful count is not a second story
or analysis generation. The older explicitly priced manual text-count workflow is
unchanged. Account erasure removes the operational count's actor/campaign links and
body hash while preserving unresolved cost metadata.

## Deployment and verification boundary

No production variable, restart or deployment was changed by this implementation.
The owner deploys manually. A read-only Railway check on 2026-11-03 confirmed the
Dreamwalk API service and that its configuration variable exists, but OAuth hides
its values, so the current live text model and profile were not verified. After a
manual deployment, a matching release profile activates the exact path automatically;
provider access is still checked by the actual count response, never assumed.

No live paid count or model-quality evaluation was run. Injected transport and real
PostgreSQL tests establish transport, accounting boundaries, privacy and restart
behavior, not Luna's visual accuracy on the owner's actual art. Collision, obstacle
inference, spawn repair and movement based on painted terrain remain out of scope.

Official documentation checked on 2026-11-03:

- https://developers.openai.com/api/docs/models/gpt-6-luna confirms image inputs and
  the higher tariff for prompts above 272K input tokens.
- https://developers.openai.com/api/docs/guides/token-counting and
  https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count
  document exact counting with image input. They do not establish a free count fee.
- https://developers.openai.com/api/docs/guides/images-vision describes billable image
  input tokens; no unpublished Luna image multiplier is assumed.

## Offline tests

`runtime-map-raster.test.cjs` covers visibility masking, unseen identities,
immutable inputs, contain framing, markers, footprints and invalid rasters.
`runtime-map-vision.test.cjs` covers quote-body pinning, count/dispatch parity,
no-network packing, restart restoration, model default/opt-out, tier/window fences,
errors and release of the quote scope before counting. Both run in `test:game`.

The disposable PostgreSQL paid-start suite also runs
`runtime-map-preflight.fixture.cjs`: real authorization and quote tables, SQL-lock
release before the injected transport, exact count reuse after engine restart,
no player wallet mutation, NULL operational fees, unknown-outcome replay prevention,
and revoked access. The separate runtime-map ACL fixture covers private source
revocation, map pins and takedowns.
