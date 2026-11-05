# Location maps and failed authoring receipts

A selected location image is the location’s game map, including before playable geometry exists. Its immutable location, image revision and source hash identify it. The optional database map link is not an illustration-only preference.

The planner must inspect the complete image and keep spatial certainty distinct from appearance. Unknown positions must not be converted to invented safe floor, token placement, collision or proximity. The image must not be silently replaced with a schematic just because the map link has not been created yet.

## Spatial certainty and ordinary roleplay

High-confidence, revision-matched map analysis still validates safe floor, NPC footprints and passages. Invalid or duplicate player slots can be repaired deterministically only within an already established safe connected component. An absent safe anchor, uncertain cells, unsafe NPC placement or disconnected valid anchors are not repaired by guessing.

A valid semantic plan with uncertain or unavailable image analysis can instead retain the original map in `location_only` mode. Its entities have no numeric positions, and the runtime does not invent collision, paths, range or a field of view. Explicit scene participants can converse and form memories; ordinary player text still goes to the director. The map remains visible without arbitrary tokens or coordinate overlays. No second provider call or geometry confirmation is added by this fallback.

An author's scene participant selection is encounter authority. A matching name in prose is not. Other authored scenes, whispers and author-only knowledge remain isolated. Existing positioned campaigns are not migrated automatically, and a discarded historical failed proposal cannot be reconstructed by this feature.

The Studio Preview step now exposes preparation directly. It flushes edits before preparation and keeps quote, generation consent, review, apply and publication separate. Opening Preview only reads the current build.

## Known authoring failure cost

An unusable result can still have a verified provider bill. The owner may review and explicitly settle that addressed receipt through `/generation/authoring-text/jobs/:id/settlement`.

The recovery proves the original job, authoring quote, release authorization, provider reservation and currency hold belong together. It recomputes usage using the admitted tariff, refuses unknown or mismatched costs and amounts above the reserve, and atomically captures the known cost while releasing the remainder. Split currency funding must match its original linked hold and quote. The same operation can be recovered after a lost response or restart without another charge.

Recovery does not retry generation, apply a plan, edit a story, or change the provider bill. Ordinary status reads do not settle currency. A pending currency hold keeps new preparation unavailable until the addressed cost is resolved; the UI refreshes status after settlement without starting another request.

Tests use synthetic inputs and disposable databases. Passing those checks is not a claim that paid end-to-end gameplay has been verified.
