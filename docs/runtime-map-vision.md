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

## One request and one quote

`text.runtimeVision` is an explicit operator-reviewed policy, independent of
`text.storyVision`. It uses the same model, one image, high detail, a reviewed image
input-token allowance, text-input billing and a maximum admitted input-token tier.
It requires the existing per-request estimate and context-window policy. No default
allowance, model multiplier or production activation is supplied by this change.

The normal local quote contains the final multimodal body, its SHA-256, the text and
image input allowance, reserved output and the existing margin. Image base64 bytes
are transport bytes, not text tokens. The existing quote confirmation explicitly
says the map image/visible characters are sent and analysis is included. There is no
second analysis generation, automatic token-count request or hidden retry.

When the existing explicitly authorized token-count preflight supplies matching
exact evidence, that count takes precedence over the allowance. It is pinned to the
complete same body/model/provider/policy and cannot survive changed pixels or
positions. Receipt settlement uses actual provider input/output/cache usage. Usage
outside the reviewed input tier remains unknown rather than being charged at an
incorrect lower rate. Vision does not change wallet, consent or system-work gates.

## Activation decision still required

The feature is implemented and tested through injected transport, not activated on
production. A valid reviewed runtime policy and separately authorized real-image
quality check are still required. Do not fill `inputTokensPerImage` with a guessed
GPT-6 Luna multiplier simply to make the configuration pass.

Official documentation checked on 2026-11-03:

- https://developers.openai.com/api/docs/models/gpt-6-luna confirms image inputs.
- https://developers.openai.com/api/docs/guides/images-vision says image inputs are
  converted to billable input tokens. Its multiplier table omits GPT-6 Luna.
- https://developers.openai.com/api/docs/guides/token-counting and
  https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count
  document exact image-aware input counting, but do not establish that the counting
  endpoint is free. Existing separate counting-cost authorization remains intact.
- https://developers.openai.com/api/docs/pricing lists Luna Standard rates per
  million: $0.10 ordinary input, $0.01 cache reads, $0.125 30-minute writes,
  $0.25 12-hour writes, $0.50 output for up to 272,000 input tokens. Above that
  threshold, input/cache rates double and output is multiplied by 1.5 for the
  whole request. These are documentation findings, not automatic configuration.

A defensible activation of this implementation still needs a verified model-specific
image allowance. Existing exact evidence can refine the estimate, but does not remove
that configuration requirement. An allowance-free activation would require a separate
explicitly authorized exact-count workflow and verified counting-cost accounting; it
is not implemented here and must not be disguised as an unpriced background request. Mock
success establishes protocol, privacy and budget fencing, not real map-reading
quality, provider access, or safe placement on the user's actual art.

## Verification

`runtime-map-raster.test.cjs` covers intersection masking, unseen identities, immutable
inputs, contain framing, numeric labels, footprints, deterministic output and invalid
raster inputs. `runtime-map-vision.test.cjs` covers current-map rights/pins, revocation,
changed positions, actual mocked `input_image` dispatch, byte/body pinning, exact-count
precedence, tier fences and zero extra calls. Both are included in `npm run test:game`.
