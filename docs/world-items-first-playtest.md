# Generic item/map playtest — local handoff

The local branch adds generic NPC item provisioning, map interaction, an author-reviewed story-plan bridge and static character packages. It does not activate providers, reconcile financial holds, publish a story, convert an existing campaign or change the user's running preview.

## Item and map path

An authored playable draft may contain worldItemDefinitions, worldItemRules and finite per-NPC itemStock. The NPC speech adapter can propose at most two place_stock/give_stock/place_existing/give_existing intents. The server validates approved definitions, finite stock or owned IDs, addressee, distance, surface footprint/capacity, NPC taboos and existing obligations. Speech and item mutations commit together or neither commits. One bounded atomic provisioning decision uses one NPC/world action.

Consume changes the actual item's quantity/vitality or removes it. Pickup moves the same stable ID to inventory. Both use the existing server turn controller, durable command receipts and transaction path. Witness memories record placement, transfer and consumption; private stock is excluded from player projections.

Right-click the drawn NPC/item to open its name and actions. On touch screens, tap the drawn target. Shared-table items have separate stable hit boxes. The inventory button opens a compact panel on the left over part of the map. The former nearby-objects list and out-of-character chat tab are removed from the game UI; saved chat data is retained.

Text consume is supported by the intent/story/narrative provider schemas, the server allowlist and the shared action reducer. Deterministic ru/en/uk phrases and inventory consumption use the same main-action budget as map interaction. Stale/duplicate attempts do not consume another item. Confirmed text consumption also enters witness memory. Price-presentation changes remain with the separate cloud UI tranche.

## Story description to playable draft

Owner-only endpoints:

- POST /api/v1/story-builds/adventures/:adventureId/prepare with operationId.
- GET /api/v1/story-builds/:buildId.
- POST :buildId/quote with operationId and existing generation sessionId.
- POST :buildId/dispatch with operationId, quoteId, consent:true.
- POST :buildId/apply with operationId, sourceHash, reviewed:true, imageReuseConsent:true.

Preparation makes no provider call. Quote/dispatch reuse AuthoringTextEngine with existing authorization, accounting, request snapshots and stale-policy guards. They create no new allowance and clear no stop. The AI proposes geometry and finite item capabilities for exactly the author's source location/NPC IDs. Compilation checks connected maps, entrances/spawns, collision, positions and stock references. Explicit source-fenced apply atomically updates playable/art drafts and binds saved authorized location illustrations.

The supported opening is 1–4 locations and at most 8 NPCs. Larger sources fail explicitly. This is an opening plan, not a fixed script or exhaustive future-world catalogue. Images remain illustrations; their pixels never define collision or authority. The bridge does not segment furniture from a flattened image.

UI mount: StoryPlayableBuilder({adventureId}); standalone route /studio/gameplay/:adventureId. Applying does not publish a story or start a campaign. The existing private compile/test launch remains separate; private publication is a separate cloud tranche. Migration 040_story_playable_builds.sql adds private author-build records included in export/erasure.

## Character appearance

CharacterSpriteControl({target:{kind:'npc'|'hero',id},onSaved?}) is independent of the shared Studio/NPC editor. Standalone route: /library/character-sprite/:kind/:id. Cloud forms can mount the control later.

POST /api/v1/visual-authoring/character-sprite/prepare accepts operationId, target, optional appearance, sourcePhotoPermission and allowOutputReuse. Only visual source fields enter the brief. Biography, backstory, private notes and NPC secrets are excluded. An existing portrait is used only with explicit source permission; text-only generation remains available. Output sharing defaults false, separate from portrait permission.

Static mode follows existing manual concept quote/dispatch/review/approval. Completion creates an immutable normalized transparent static sprite package without requiring an animation atlas. Equip validates the original target fingerprint. Failed/stale regeneration leaves the previous bound appearance intact. NPC compilation and hero selection pin the sprite revision; rendering preserves aspect ratio and anchors feet consistently. Existing animated packages retain their original flow.

A source NPC remains an owner-scoped shared definition. Equip changes it for future playable versions, while existing campaign pins remain unchanged. Inline author forms must not imply story-local editing of that shared definition.

## Verification and live prerequisites

Targeted tests cover innkeeper food/cup and unrelated technician/battery; atomic speech/item admission; surfaces, stock, capacity, range and taboos; witness memory; duplicate commands; actual disposable PostgreSQL save/restart; two-location source-ID bridge apply; approved static NPC/hero packages and pins; desktop right-click and mobile touch; left inventory and page reload.

The browser/database fixtures are isolated. Character drawings are synthetic rasterized test art; model transport/proposals are fake. No real text or image dispatch occurred. These checks do not establish real-model plan/visual quality or provider billing.

Coordinate a pause before installing this checkout into the running user preview. Apply migration normally without seed/reset and preserve existing data. Real acceptance additionally needs valid owner-configured text/image authorization in the existing financial scope. Unknown liabilities and provider stops remain enforced; this branch does not unblock them. The owner can then explicitly generate a plan/image and launch the resulting private test version. Existing campaigns are not silently upgraded with new item stock.

Targeted commands:

- npm run build -w @dreamwalk/contracts
- npm run build -w @dreamwalk/game-core
- npm run build -w @dreamwalk/api
- node --test tests/game/core-world-items.test.cjs tests/game/core-turns.test.cjs tests/game/world-items-provider.test.cjs
- node --import tsx --test tests/game/world-items-ui.test.mjs
- npm run local -- node scripts/test-world-items.mjs
