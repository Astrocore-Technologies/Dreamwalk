# Image-grounded story maps

## What this changes

Previously, saved location art was bound to a separately generated prose-only sparse
layout. The planner never received image pixels. A logically valid spawn could therefore
be on a painted cliff. Adding a grid or repeating “safe spawn” in the text prompt did
not fix that mismatch.

New uncompiled story preparations read authorized, pinned background revisions. They
verify the source SHA-256, create a deterministic 768×768 contained JPEG matching the
24×24 map framing with an analysis-only coordinate guide, and include it as real Responses `input_image` content in the same
story-planning request. Original revision/hash and derived input hash are immutable
read dependencies. No image URL is fetched from user input. The existing estimate and
consent cover image analysis. Exact mode performs a separate, durable token-count
preflight while preparing the quote; generation still has one acceptance and no
automatic retry. The count is operational work, not a second generation or player charge.

The typed proposal describes 24 rows of floor/door/wall-rock/water/obstacle/unknown
cells and bounded public landmarks. The server validates image identity, safe distinct
spawn cells, connected floor, NPC footprints,
passages and observed doors. Low-confidence or inconsistent proposals cannot start a
campaign. No center-of-image or nearest-random-cell fallback is used. Door and terrain observations stay advisory in RP play, rather than creating
locks, mandatory actions or invisible hard walls. Explicitly authored engine doors
remain unchanged. Image room furniture is not drawn
again as an invented engine layer.

NPC decision/speech and narration contexts receive only perceived spatial observations,
with coordinate convention and uncertainty. A separate perception-only ray test masks
entities, remembered observations and landmarks behind painted walls or closed observed
doors; it never changes engine action eligibility or movement. Partially seen landmarks
do not expose their hidden names or full bounds. A replacement background revision prevents
use of stale landmark context. Existing compiled/live campaigns are not moved or reset.
Old uncompiled sources with pinned images are enriched in memory on the normal launch
path; their derived checksum fences old estimates. Stories without images still use
text planning.

## Production gate and honest limits

`text.storyVision` supports an explicitly reviewed image allowance or
`counting: operational_exact`. When it is absent and the same model already has an
exact `runtimeVision` policy, the authoring adapter derives exact story-image support
in memory (up to the existing four-image source limit). It uses the existing reviewed
model, billing basis, pricing range and expiry; no stored operator setting changes.
An explicit `storyVision: false` opts out. A configured invalid or expired policy
fails rather than silently changing modes.

Exact mode sends the identical authorized image/text/schema input to the provider's
input-token-count endpoint before presenting the ordinary generation quote. It stores
only the actor, model/provider fingerprint, body hash, status and count in the existing
erasable operational receipt table, with no prompt or image content. Source access,
release authorization, live owner and generation-policy fences are checked after
locking, before admission, and again when creating/accepting the quote. Network work
runs outside database locks. Requests are rate-limited; an unknown outcome blocks an
automatic repeat. Fresh successful receipts can be reused for ten minutes. A saved
quote pins the exact count and body across worker restarts without another count.

Generation's existing request-specific reserve uses the exact input count plus its
output allowance and safety margin, with the existing billing rates. This is not a
global spending cap. Count endpoint fees are not asserted to be free: the operational
provider-fee field remains unknown until verified, and is not fabricated as a zero-cost
invoice or charged to the player's wallet. Image bytes still count toward transport
limits. Requests outside the reviewed pricing range are rejected; actual generation
usage outside it remains unpriced/unknown. Explicit legacy allowance policies retain
their conservative accounting. No GPT Image generation price or guessed image-token
multiplier is used for vision input.

Documentation checked 2026-11-03:

- https://developers.openai.com/api/docs/models/gpt-6-luna confirms image input,
  Responses, structured output, and tier changes above 272K input tokens.
- https://developers.openai.com/api/docs/guides/images-vision describes image inputs
  and model-specific image accounting. Its multiplier table does not explicitly list
  GPT-6 Luna, so this implementation does not invent that multiplier.
- https://developers.openai.com/api/docs/guides/token-counting documents image-aware
  token counting. No live counting or generation request was made for this work.

A provider's self-reported confidence is not a guarantee of visual accuracy. Mock
fixtures validate transport, accounting fences and geometry consistency, not the
model's ability to read the user's actual map. A separately authorized real-image
quality evaluation is still required to establish visual quality. Exact counting
replaces the need to guess an image-token multiplier; it does not prove that the
model read the map correctly. Existing campaigns need a separate intentional
migration/re-preparation if their original art and geometry disagree; this patch never
silently repositions them.

## Local verification

`tests/game/map-image-grounding.test.cjs` uses synthetic input only, covering ownership,
integrity, contain framing, quote/body pinning, actual mocked multimodal dispatch,
unsafe cells, disconnected spawns, confidence, doors, visible landmarks and stale art.
`tests/game/story-map-exact-count.test.cjs` additionally covers exact quote/dispatch
identity across restart, safe-spawn validation, explicit opt-out, priced-tier limits,
durable admission/access checks, receipt reuse, uncertain outcome and erasure. These
tests use injected transport only and are included in `npm run test:game`. Paid-start PostgreSQL tests run against a
fresh disposable local cluster and injected providers only.

## Playable fallback when vision is not configured

An image-backed story no longer requires an administrator to enable vision before it
can start. When neither story-image support nor inherited exact runtime-image support is available
(or story vision is explicitly disabled), uncompiled
preparations derive a text-only schematic source. The existing estimate explains that
the illustration is displayed separately from unverified positions and image analysis
is not priced. Original artwork remains saved in the story assets. The
source/checksum and quote distinguish this mode, so an earlier estimate cannot be
silently reused. No second confirmation or hidden image request is introduced.

This fallback is only for an absent capability or explicit opt-out. A configured but expired/invalid vision
policy still fails before dispatch, rather than silently changing an accepted mode.
Saved campaign state is unchanged. The illustration view is a temporary alternative,
not a claim that the original raster was understood or its spawn repaired.

### Displaying preserved location art without invented coordinates

When image analysis is not configured, the gameplay scene displays the saved location
illustration, with separate participant, object, exit and inventory controls. It does
not overlay unverified tokens or expose the schematic tile renderer as the scene.
This is an illustration view, not completed image-aware placement. The existing
estimate and scene explain that distinction without adding a consent step.

Previously created schematic campaigns recover only the current map's exact immutable
playable background pin. The manifest returns it separately as `sceneIllustration`;
the ordinary projected art allowlist is unchanged. Both manifest and file access
recompute current-map eligibility, require source access and a live owner, and honor
takedowns. Missing or ambiguous pins fail closed. No author draft, campaign rewrite,
provider call, regeneration or new charge is involved in this recovery.
