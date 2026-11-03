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
consent cover image analysis; there is no hidden second request or automatic retry.

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

`text.storyVision` is an optional, explicit operator-reviewed policy, not enabled by
this change. It requires the exact model, `detail: high`, `maxImages` (1–4), a reviewed
`inputTokensPerImage` allowance for the normalized image, `billing: text_input_rate`,
`maxPricedInputTokens`, and official pricing evidence with review/expiry dates. The
configured image billing basis must be supported for that exact model. This is not a
wallet/global spending cap: the existing request-specific reserve still applies.

Image bytes count toward transport limits, not text token estimates. The estimate
uses the image allowance plus conservative text-envelope accounting, and the body hash
pins the exact raster bytes. A model/policy/image change invalidates the snapshot.
Requests outside the reviewed pricing range are rejected before dispatch. Actual usage
outside that range remains unpriced/unknown rather than incorrectly charging a lower
tier. Never reuse GPT Image generation prices for vision inputs.

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
quality evaluation and verified model-specific image allowance/billing are still
required before enabling the policy. Existing campaigns need a separate intentional
migration/re-preparation if their original art and geometry disagree; this patch never
silently repositions them.

## Local verification

`tests/game/map-image-grounding.test.cjs` uses synthetic input only, covering ownership,
integrity, contain framing, quote/body pinning, actual mocked multimodal dispatch,
unsafe cells, disconnected spawns, confidence, doors, visible landmarks and stale art.
The test is included in `npm run test:game`. Paid-start PostgreSQL tests run against a
fresh disposable local cluster and injected providers only.

## Playable fallback when vision is not configured

An image-backed story no longer requires an administrator to enable vision before it
can start. When the configured text profile has no `storyVision` policy, uncompiled
preparations derive a text-only schematic source. The existing estimate explains that
the illustration is not analyzed, is not used as the schematic background, and image
analysis is not priced. Original artwork remains saved in the story assets. The
source/checksum and quote distinguish this mode, so an earlier estimate cannot be
silently reused. No second confirmation or hidden image request is introduced.

This fallback is only for an absent policy. A configured but expired/invalid vision
policy still fails before dispatch, rather than silently changing an accepted mode.
Already compiled/live campaigns are unchanged. The schematic is a playable temporary
alternative, not a claim that the original raster was understood or its spawn repaired.
