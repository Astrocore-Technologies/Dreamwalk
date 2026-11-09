# Verified grid admission

A new playable release, story build or campaign must contain positioned maps and actors. A location-only fallback remains readable for historical saves, but is no longer a successful new preparation. An image-backed source cannot silently become a text-only layout when the configured planner lacks vision.

## Server placement

The story planner observes each analyzed image once and returns only the 24x24 grid (`.` floor, `D` door, `#` wall, `~` water, `X` furniture, `?` unknown). The model's self-reported confidence is stored with the evidence but is not an admission gate: an image never silently becomes a location-only map. Spawns, NPC cells and passage anchors are computed by the server (`placeStoryRoom` in `story-plan.ts`) and any coordinates the model supplies are ignored.

Placement treats unknown cells inside the border as open ground, picks the largest connected floor area anchored at the first observed door (else the map centre), reserves passage anchors near the map edge, then the four player spawns nearest the anchor, then each NPC's full footprint. It fails with `MAP_IMAGE_UNSAFE_SPAWN`, `MAP_IMAGE_UNSAFE_NPC` or `MAP_IMAGE_UNSAFE_PASSAGE` only when the grid has no room. Only an image deliberately omitted from analysis stays location-only. Information topology does not add movement collision or restrict ordinary RP movement. Actual authored door state takes precedence over the original door observation.

There is no second provider request or automatic regeneration. The definition version, JSON schema and prompt are part of the existing request estimate and body binding. A known provider result that fails grid admission remains a known billable result under its original settlement policy, not an unknown result or an automatic refund/retry.

## Saved games

An incomplete legacy save retains its original image, public participants, inventory and history. Reads do not resume its clock, acquire a gameplay lease, rewrite actor paths, reconcile pending gameplay or start provider work. Gameplay writes fail with `MAP_GRID_RECOVERY_REQUIRED`. Existing privacy and source access checks still apply. Settings and access revocation remain available.

The projection carries a recovery flag when any map needs repair, including a map other than the viewer's current one. Reload polls are read-only. A separately verified repair can become visible without a new paid request or automatic repositioning by the read path.

This change does not provide a campaign-migration operation. It also does not claim that existing generated travel artwork has been checked against its pixels. Compound image-plus-vision estimation and admission for dynamically generated maps are a separate implementation.

## Focused verification

- Grounding/admission tests cover exact image identity, confidence, footprints, authored presence, hidden token/portrait/topic/contact/acoustic isolation, stale reuse and read-only cached/uncached loads.
- The disposable PostgreSQL legacy integration verifies one provider result and settlement identity, rejected new incomplete preparation, unchanged snapshots/clocks/events/history/jobs/quotes/ledger through read/reload/rejection, and preserved private audience scope.
- Core tests verify movement and existing scene behavior. UI tests cover recovery display, disabled gameplay and intact reads.
- Browser fixture uses only a synthetic historical snapshot and original synthetic image. It must run on an isolated test deployment; it never changes a user's saved campaign.

## Asset-free plan contract

For a source with no attached or explicitly omitted map images, new authoring requests
use a positioned response schema: exactly four player spawns per room, both passage
endpoints, and numeric NPC positions. These are logical coordinates proposed from the
authored text, not claims of observing an absent image. The compiler still checks the
layout and never supplies missing coordinates itself. Image uncertainty keeps its separate
permissive observation contract and strict admission checks.

The response schema is selected in the same request-body builder used for quoting,
restart verification and dispatch. Its definition version changes with this contract.
The saved source context also selects the validator at result receipt and restart; no
second generation or silent paid repair is introduced. Known invalid results retain their
actual-cost receipt. The UI reports the validation failure rather than falsely claiming
that the author edited the story.

Synthetic checks cover missing spawns/endpoints/NPC positions, unchanged image policy,
identical quoted/dispatched bodies, positioned playable state and owner-authoring
prepare/apply/start with disposable database billing. They do not claim a paid provider
always produces semantically correct geometry.
