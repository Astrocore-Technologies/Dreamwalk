# Hybrid game prototype: acceptance evidence

Scope: locally authorized G0–G3, approved 2026-10-30. This is not production
readiness, a deployment or permission to call paid providers.

## Implemented shape

- A separately labelled observatory prototype is pinned to `observatory-v1`.
  Existing authored stories remain platform content until validated playable maps
  are explicitly added; there is no silent conversion or public campaign access.
- The pure rule core owns bounded orthogonal pathfinding, fixed logical movement,
  walls/doors, range, unique item ownership, map transitions and visibility.
- The API owns authenticated campaign invitations, one writer, durable operations,
  ordered movement checkpoints, snapshots/checksums, outbox and WebSocket projections.
- The renderer uses an original temporary layered atlas and HTML alternatives.
  The art is a prototype, not the final character/animation production pipeline.
- Local coordinated encounters resolve **one round** then return to exploration.
  This demonstrates simultaneous intents and deterministic conflicts, not combat.
- The NPC uses a bounded deterministic mock decision. No LLM, translation or
  image generation is invoked; walking and replay do not touch the demo wallet.

## Evidence matrix

| Requirement                                                     | Evidence                                          | Status                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Deterministic rules, walls/range and unique key                 | `tests/game/core.test.cjs`                        | 24 passing tests; includes 2,000 seeded trace steps                                                      |
| Local freeze, competing cell/item claims and input generations  | Core and real runtime suites                      | Passed for one-round coordination                                                                        |
| Projection privacy, NPC context and adversarial proposals       | Strict wire schemas, core/runtime tests           | Passed for the fixture/mock allowlist                                                                    |
| Two distinct users, sockets, reconnect and real process restart | `tests/game/integration-runtime.test.mjs`         | 12 real PostgreSQL/WebSocket tests passed; includes SIGKILL and exact operation replay                   |
| Actual Pixi render and HTML interaction                         | Managed cloud browser, existing synthetic session | Created campaign, took key, unlocked/opened door, crossed to roof, reloaded; map and inventory persisted |
| Actual local encounter                                          | Managed cloud browser                             | Planning boundary/timer displayed; timeout returned to exploration                                       |
| UK interface and narrow layout                                  | Managed cloud browser                             | Observed at approximately 491px; original layered atlas rendered                                         |
| Two independent browser contexts                                | `tests/e2e/game-cooperation.spec.ts`              | Source prepared; not run locally or remotely for this change yet                                         |
| Existing platform behavior                                      | `npm run test:integration`                        | 62 checks passed in final rerun                                                                          |
| Contracts/core/config/locales/UI                                | Root scripts                                      | 9 contracts +24 core +18 config/locales +4 UI checks passed                                              |
| Full build, lint and types                                      | Root scripts                                      | Final production build, types and lint passed                                                            |
| SMTP regression                                                 | Local capture only                                | 1 integration scenario passed, no external email                                                         |

## Acceptance gaps versus the full architecture

The playable fixture proves the G0–G3 vertical slice, not every future-system feature.
Two independent browser-context acceptance remains gated on a permitted CI run.
Author map compilation/publication and arbitrary campaign source ACL are not exposed:
only the immutable built-in fixture can be started. NPC decisions are single-action,
explicitly requested mock jobs; broad autonomous schedules, persistent learned memory
and multi-step planning are not claimed. Encounters demonstrate one-round coordination,
not multi-round combat, initiative character statistics or automatic joining across a
boundary. Movement uses bounded orthogonal target paths rather than analog continuous
input; diagonal/virtual-stick mechanics and final directional animation atlases are
not claimed. Logical server positions are interpolated by Pixi. The current map floor plan and exits are deliberately known; FOV hides dynamic entities, not undiscovered static geometry. Four simultaneous browser clients and load capacity are not measured.

Network messages contain complete permitted projections rather than compact patches;
HTTP and socket cursors share validated viewer-local revisions. Recovery loads a full
checkpoint with checksum and invalidates old paths/leases. Since the latest full snapshot
is updated atomically on every commit, there is no separate incremental replay worker
in this prototype. Full private state events are retained, and no restoration invokes AI.

## Explicit limits

One process is the campaign writer; multiple runtime workers need fencing before
deployment. Each committed event currently contains a full private state checkpoint
and the latest snapshot is refreshed each commit. This simplifies prototype recovery
at higher storage cost; it is not a measured production event-compaction strategy.
Intermediate positions are not durable until the next checkpoint (target one second).
Confirmed item/door/round results commit before acknowledgement.

The fixture is immutable and source-independent. Publication/moderation/asset ACL
of author stories is preserved, but launching arbitrary authored content and its
version upgrade/migration belongs to a later playable-content/editor stage.

No load-capacity claim, public launch, Discord embedded verification, real provider
cost estimate or payment guarantee follows from local tests. G4 requires separately
approved provider, data policy and spend cap. New code publication remains pending
owner permission.
