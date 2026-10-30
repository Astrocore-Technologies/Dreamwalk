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
| Two independent browser contexts                                | `tests/e2e/game-cooperation.spec.ts`              | Passed in GitHub CI for PR #4, head 9843ca7, including 390px overflow assertion                          |
| Existing platform behavior                                      | `npm run test:integration`                        | 62 checks passed in final rerun                                                                          |
| Contracts/core/config/locales/UI                                | Root scripts                                      | 9 contracts +24 core +18 config/locales +4 UI checks passed                                              |
| Full build, lint and types                                      | Root scripts                                      | Final production build, types and lint passed                                                            |
| SMTP regression                                                 | Local capture only                                | 1 integration scenario passed, no external email                                                         |

## Current scope versus the full architecture

The initial fixture proved a G0–G3 vertical slice. The follow-on implements bounded
Studio grid authoring, immutable private/public playable packages and source access,
multiple local coordination rounds and persistent mock NPC action sequences. It is
still not every future-system feature in the architecture.

Two independent browser-context acceptance passed in PR #4 CI on head 9843ca7. The
new authored Studio and round browser sources must run in a newly authorized CI run;
existing test source alone is not evidence. Managed CUA has independently verified
actual Studio customization, private launch, NPC item transfer/patrol, round advancement,
reload and completion. Independent real-session PG/WS tests cover cooperative access,
restart and private projections, not just two tabs sharing one cookie.

The editor uses bounded editable grid templates and bundled sprites, not a professional
map editor or arbitrary uploaded/generated sprite pipeline. The package pins asset ID
and checksum. Source prose/location/NPC definitions are preserved in private version
snapshots; prose is not automatically compiled into new mechanics. Automatic content
translation and real AI remain disabled; original author text is the fallback.

Encounters implement repeated coordination, not a complete combat system or character
initiative statistics. NPCs safely wait inside encounters. Outside them, explicitly
requested mock plans can execute up to three validated steps and retain up to 16
observed-event facts. No unbounded autonomous schedules or learned LLM memory are claimed.

Movement uses bounded orthogonal target paths rather than analog continuous input;
diagonal/virtual-stick mechanics and a final directional animation pipeline remain
out of scope. Logical positions are interpolated by Pixi. Static current-map geometry
and exits are known; FOV hides dynamic entities, not undiscovered floor plans. Four
simultaneous browser clients and production load capacity have not been measured.

Network messages contain complete permitted projections rather than compact patches.
Recovery loads full checksum-verified checkpoints; there is no incremental replay
worker. Full private state events are retained, and restoration never invokes real AI.

## Explicit limits

One process is the campaign writer; multiple runtime workers need fencing before
deployment. Each committed event currently contains a full private state checkpoint
and the latest snapshot is refreshed each commit. This simplifies prototype recovery
at higher storage cost; it is not a measured production event-compaction strategy.
Intermediate positions are not durable until the next checkpoint (target one second).
Confirmed item/door/round results commit before acknowledgement. Offline pause preserves
remaining round/job time; crash recovery conservatively restores the last checkpoint
remainder rather than consuming elapsed wall time.

Both compatibility fixtures and authored packages are immutable. Existing campaigns
never silently upgrade when an author edits or republishes. Explicit migration of a
running campaign to another playable package is not implemented.

No load-capacity claim, public launch, Discord embedded verification, real provider
cost estimate or payment guarantee follows from local tests. G4 requires separately
approved provider, data policy and spend cap. The initial slice was merged in PR #4; subsequent additions require their own
verified handoff and publication authorization.

## Authored-content / multiple-round / persistent-mock extension

The extension is tested separately from the PR #4 baseline. The final combined runtime
run passed **35/35** after migrations 011–014, submitted-review binding, autosave CAS
and heartbeat recovery. The clarified true-pause contract adds migration 015 and a
**4/4** targeted regression for preserved remaining time across offline periods, crash,
reconnect and queued NPC work. The combined run passed **39/39**; the final affected offline suite passed **5/5**,
including the added legacy-clock compatibility case (**40 distinct runtime checks**). It covers actual restart, source revoke,
private/public moderation, stale reviewed-version rejection, immutable package guards,
queued NPC decision recovery, bounded memory and account export/erasure.

Core rules pass **38/38**; UI/autosave controller checks pass **18/18**. The final
aggregate build/typecheck/lint and existing-platform regression are recorded in progress.md. New game browser
sources are not yet executed remotely. These distinctions are intentional: test code,
focused checks, actual managed-browser observations and full CI are different evidence.
