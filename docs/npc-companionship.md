# NPC companionship

NPC public replies can carry `companionIntent: { kind: 'follow' | 'stop', actorId,
sourceObservationId }`. This is the NPC's explicit decision, not a player action
and not a phrase detector. A request, vague offer to help or unstructured RP prose
alone does not change mechanics. The model may refuse and keeps ordinary RP freedom.

Both story-turn replies and deferred world-turn speech use the same admission
function. The server requires the addressed player, public `say`, a real original
speech observation, the exact current reply source and the existing context/audience
fences. It commits the NPC reply and agreement atomically. Whisper agreement is not
promoted into shared mechanics. Existing prose-only agreements are not retroactively
converted by keyword matching; a subsequent explicit NPC decision can establish one.

The server stores only actor/evidence references and observed crossings in private
NPC memory. Public projections do not expose that memory. Active agreement evidence
is protected from memory pruning and removed through personal-data erasure.

Following reuses existing movement, pathfinding, action budgets and world execution.
Player reading time remains frozen in turn mode. End turn lets the NPC propose one
bounded ordinary action, without another provider request or timer. Different token
footprints and actor collisions are revalidated at execution. A blocked route waits
and can recover on a later turn. A `stop` decision cancels old patrol plans and paths.

Scene following requires an observed player crossing and the same authored exit.
The NPC walks to that exit and uses normal transition validation: closed doors,
occupied/invalid destinations and encounters remain barriers. There is no teleport
to the player's coordinates, unseen multi-map pursuit or invented exit. If the
player returns before the NPC crosses, the NPC stays with them rather than following
a stale detour.

This adds companionship start/stop, not arbitrary AI control over the engine.
Unsupported mechanics, remote knowledge, speculative player consent, forced movement,
new scene creation by speech and automatic repair of historical dialogue remain
outside this intent. Existing separately typed actions and narrative proposals retain
their own validation boundaries. No paid model quality or deployment is claimed.

Regression commands:

```sh
npm run typecheck
npm run lint
npm run test -w @dreamwalk/game-core
npm run build -w @dreamwalk/api
node --test tests/game/companionship-provider.test.cjs
node --import tsx --test tests/game/privacy-living.test.mjs
npm run test:integration
```

The disposable game runner accepts `GAME_TEST_FILE=integration-companionship.test.mjs`.
Set `COMPANION_BROWSER=1` to additionally exercise the real End turn button and map
surface with Playwright; use `E2E_BROWSER_CHANNEL=chrome` for an installed Chrome.
All fixtures are mock-only and never target the user's running application.
