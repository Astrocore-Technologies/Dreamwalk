# Living NPC: requirement-level implementation and evidence

The owner authorized the complete architecture, not merely a first mock slice. Baseline:
merged PR #5, main `a015bbc1576d08352a4744d2600b2bde6843c42a`. The original 166-file
baseline was verified before editing. PR #6 is an integration checkpoint, not a claim
that every requirement is accepted. This replaces the earlier overbroad section-level
“implemented” labels.

**Status convention:** `source` means implemented and awaiting final integrated acceptance;
`tested` means the named bounded test ran, not that production or real-model quality is
proven. Browser acceptance is CI-only while native cloud desktop is unavailable. The
current completion source must pass its own complete suite after the earlier tranche.
No paid calls, real purchases, deployment or merge are authorized. Drawn 2D only; temporary
sprites are not final artwork. Existing v1/v2 saves and immutable published versions are
not silently upgraded to v3.

## Requirement matrix

| Section / requirement      | Concrete implementation / evidence                                                                                | Current acceptance                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1 Compatibility            | Explicit authored hybrid-v3; v1/v2 rules preserved; existing runtime regression                                   | 115/115 final runtime checks passed                              |
| 2 Continuous conversation  | Ordinary npc.speech atomically queues a grounded reply; no separate diagnostic button required                    | 14 targeted scenarios and 115/115 final runtime passed           |
| 2 Character-quality rubric | Deterministic continuity/knowledge/obligation evaluation plus separate live-model rubric                          | 7/7 deterministic rubric passed; live-model quality gated        |
| 2 Fail-forward             | Authored return-item/negotiate conditions and bounded goal alternatives; no invented universal mechanics          | core and final runtime checks passed                             |
| 3 Separation               | Pure contracts/core, campaign writer, private context builder, durable job engine and renderer                    | whole-workspace types passed; final runtime passed               |
| 4 World vs personal truth  | Append-only personal episodes; evidence-backed beliefs never overwrite world facts                                | core and final runtime checks passed                             |
| 4 Belief revision          | Typed evidence/CAS belief updates with visible causal explanation; false hearsay stays belief                     | core completion tests passed                                     |
| 5 Sight/hearing            | LOS and blocked bounded hearing, map isolation, recognized vs anonymous speaker                                   | core movement entry/exit and final runtime passed                |
| 5 Audience privacy         | Filter before provider; full-audience disclosure check; whisper and public topic IDs exclude secret IDs           | core and final real-PG passed; browser CI pending                |
| 5 OOC separation           | Persistent party chat with membership/idempotency; absent from NPC knowledge/context                              | 14 targeted scenarios and 115/115 final runtime passed           |
| 6 Stable personality       | Versioned values, biography, links, habits, examples and private/public style separation                          | core and UI checks passed                                        |
| 6 Operational taboos       | Runtime admission rejects forbidden rumor, valuables and door actions                                             | core completion tests passed                                     |
| 6 Temporary state          | Bounded mood/fatigue/attention game-tick decay; no offline wallclock mutation                                     | core and final runtime checks passed                             |
| 6 Relations/profiles       | Evidence-backed per-player relations; operational Green Apple/Cookie profiles                                     | core completion tests passed                                     |
| 7 Episode archive          | Immutable private PG episodes saved with checkpoint; indexed bounded recall                                       | final 115/115 runtime passed                                     |
| 7 Retrieval                | Importance/emotional/current-goal relevance; bounded whole-record context packing                                 | core and final runtime checks passed                             |
| 7 Personal continuity      | Grounded narrative summary with exact source selection/fingerprint and next revision CAS                          | core and final injected-provider fixtures passed                 |
| 7 Promise registry         | Complete obligations independent of three-item context selection; bound rejects not discards                      | core tests passed                                                |
| 7 Retention                | Protect live/job evidence; bounded cold window; compact old cognition and redact cached speech atomically         | 5/5 real-PG retention checks passed                              |
| 8 Goals                    | Authored motivation, success/cancel/hold/risk, schedules and bounded alternatives                                 | core tests passed; author UI checks passed                       |
| 8 Initiative               | Observed event/time triggers; fair bounded causes, routines and persisted multi-step plan                         | existing and completion core tests passed                        |
| 8 Replanning               | Preconditions checked at acceptance and each step; bounded obstacle replan                                        | core completion tests passed                                     |
| 9 Typed actions            | Only supported movement/owned-object/door/communication actions mutate via server                                 | core tests passed                                                |
| 9 Natural language intent  | Player-safe context yields inert proposal; human confirmation validates fresh readset                             | 14 targeted scenarios and 115/115 final runtime passed           |
| 9 Disclosure               | Named authored facts, public questions, audience-safe communicate action; never disclosure remains secret         | core, UI units and final runtime passed; browser pending         |
| 9 Promises                 | Proposed/accepted/conditional obligation, original utterance, deadlines and alternatives; fulfillment by event    | core and final runtime passed; browser CI pending                |
| 10 Cooperative consequence | Shared authoritative guard/helper response; only perceived theft affects knowledge; return/negotiate alternatives | existing and final completion runtime checks passed              |
| 11 Persistence             | Checkpoint/event/episode/job atomicity, semantic projection revision, operation and cause dedup                   | intermediate fix CI passed; final runtime115 passed              |
| 11 Concurrency/failures    | Single authoritative writer; revision/readset validation, crash/replay/revoke/late-result tests                   | final 115/115 runtime passed                                     |
| 12 Local rounds            | NPC acts within local round boundary; no future intent reading; other map continues                               | final 115/115 runtime passed                                     |
| 12 Offline pause           | Preserved remaining encounter/job clocks; new needs/goals use game ticks only                                     | offline tests passed in final runtime suite                      |
| 13 Ordinary orchestration  | Durable normal-dialogue and significant-event decision requests with safe local fallback                          | 14 targeted scenarios and 115/115 final runtime passed           |
| 13 Concrete provider       | OpenAI Responses adapter plus generic JSON boundary; strict schemas, usage/refusal/error fixtures                 | injected adapter tests passed; live calls disabled               |
| 13 Context/models          | Configured model/policy versions; bounded context packing, current-question protection, profile binding           | source and injected fixtures passed; no measured live quality    |
| 13 Retries/cache           | Campaign-scoped safe cache, expiry/readsets; no automatic paid repair or retry                                    | provider tests passed in final runtime suite                     |
| 14 Accounting              | Quote/consent/reserve/capture/release, service-cost cap and unknown-cost reconciliation                           | final 115/115 runtime passed                                     |
| 14 Shared sponsorship      | Owner-only explicit grant with purpose/operation/credit/provider caps and expiry; requester != payer              | injected adapter and sponsorship tests passed in final runtime   |
| 14 Estimates vs bills      | Configured-rate provider cost evidence distinct from reported actual usage/invoice; no guessed tariffs            | adapter tests; real invoice verification gated                   |
| 15 Authoring               | Bounded forms for facts/goals/promises/personality, CAS autosave, same typed admission                            | UI36 bounded command passed; actual completion browser pending   |
| 15 Moderation              | Exact pending immutable version behavior sandbox, not owner draft; invalidation after edit                        | 14 targeted scenarios and 115/115 final runtime passed           |
| 15 Presentation/locales    | UK/EN/RU strings and locale/name policy; private details not public relation meters                               | UI types/locales passed; browser pending                         |
| 15 Art boundary            | Drawn 2D visual profile independent of portrait/gameplay sprite; engine owns topology                             | contract boundary only; final art outside NPC scope              |
| 16 Erasure/export          | Transitive evidence/source-utterance redaction; anonymous cached replies; own OOC/sponsor metadata only           | retention5/privacy8 and final 115/115 runtime passed             |
| 16 Diagnostics             | Safe counters for knowledge/summary rejection, causal delay, retrieval efficiency and retention                   | safe aggregate metrics wired; unit/PG checks passed              |
| 16 Bounded operations      | Retention and reproducible local load harness; no production-capacity claim                                       | 7/7 rubric and bounded 1200-tick local benchmark recorded        |
| 17 Acceptance              | Unit + real PG/WS/restart + separate-context browser + adversarial provider suites                                | final runtime115 passed; production/platform/browser gates below |
| 18 Defaults                | Finite legal actions, explicit relations/names/disclosure/goal/promise limits; no permanent death by default      | documented below; UI units/runtime passed; browser pending       |
| 19 Traceability            | Requirement-level evidence and explicit remaining gates, no blanket completion labels                             | this tracker; reconcile again at final freeze                    |

## Defaults and deliberate limits

- Sight is 360-degree LOS range 9; hearing is bounded BFS range 6, blocked by closed doors
  and walls. Separate maps do not share observations. Names/identities require recognition.
- Cause queues are bounded at 32, plan length at 3, gossip depth at 3; event-root dedup,
  cooldown and age promotion prevent loops/starvation. Routine/obligation clocks are
  game time, not paid calls per NPC per tick.
- Context selects at most 16 observations, 8 beliefs and 3 active promises. The durable
  registry keeps up to 128 active promises; reaching the bound explicitly refuses a new
  obligation rather than silently deleting another one.
- Relationships are personal and evidence-backed, not a single global reputation score.
  Private numeric relations, biography and internal fact titles are not player HUD data.
- Public dialogue is checked for every recipient. An authored disclosure topic is not
  permission by itself. Provider-generated text is untrusted and never executable code.
- Consequences persist. Supported authored alternatives permit recovery; arbitrary
  professions, death/rollback systems and unlimited new mechanics are not implied.
- New graphics require separate explicit budget; existing assets are reused. Automatic
  translation and final drawn artwork are separate integrations, not mocked as complete.
- Single process campaign ownership is the supported topology. Distributed leases and
  production autoscaling are not claimed. Embeddings are optional, not required for the
  bounded indexed personal-memory implementation.

## Earlier tranche verification — not the completion-source result

| Check                                                                             | Actual result                                                     |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Whole-workspace production build, typecheck, ESLint                               | Passed                                                            |
| Whole-workspace Prettier check                                                    | Passed; three baseline files received formatting-only corrections |
| Contracts                                                                         | 9/9                                                               |
| Core rules, including living NPC invariants                                       | 65/65                                                             |
| Platform configuration and locales                                                | 18/18                                                             |
| Game UI, autosave and privacy helpers                                             | 31/31                                                             |
| Complete isolated game PostgreSQL/API/WebSocket/restart suite, migrations 001–017 | 79/79 Node tests, 190.4 seconds                                   |
| Existing platform integration                                                     | 62/62                                                             |
| Local SMTP capture                                                                | 1/1                                                               |
| New two-independent-browser scenario                                              | Source and types checked; actual browser CI pending               |

These counts name separate commands; overlapping suites are not added into a misleading
unique-test total. The full game runtime pass includes the final personal-data replay
fix, not only its pure helper tests. Source was not tested with a real paid provider.

Independent review found and prompted fixes for summary revision bypass, absent safe
speech content/style, and erased speech retained in other users' idempotent responses.
Summary commits now use canonical next-revision CAS. Audience-filtered words remain
untrusted; public style is an explicit enum rather than private biography. Erasure
follows generated-reply provenance and anonymous heard-speech IDs through private
history, cold archive and retained replay projections. The real database/API replay
acceptance passed, as did immediate fresh-snapshot cache invalidation.

The actual browser scenario remains an acceptance gate until the authorized PR's CI
runs it. It registers independent contexts, confirms shared NPC consequences, checks
recipient-only inventory/promises, whisper privacy, reconnect, author autosave, explicit
mock consent, topic-change invalidation and 390px layout. No cloud browser pass is
invented while native desktop access is unavailable.

## External gates, separate from local implementation work

Live-model conversational quality, actual OpenAI protocol/model availability and billed
cost measurements require user-supplied approved provider configuration and explicit
budget. Until then injected HTTP fixtures and deterministic mock behavior are the evidence,
not a live-model pass. Real purchases, deployment, Discord embedding, generated art and
automatic translation are not secretly activated. Configured rates are estimates, not
provider invoices. Production load capacity must be measured in its actual environment.

Unfinished local requirements above remain work, not external authorization blockers.

## Completion-source evidence

- Core: 91/91, including movement perception, conditional and non-item action promises,
  reference-only communication with late-audience revalidation and no admission-side effect.
- Runtime completion: 14 scenarios / 15 Node tests passed. Includes normal conversation,
  OOC, confirmed intents, item/action promises, moderator immutable sandbox, owner sponsor,
  significant-event scheduling, crash/revocation and terminal failed-intent recovery.
- Retention: 5 Node tests passed, including separate compacted original/reply histories,
  causal erasure after original evidence left the live/archive window, transactional
  rollback and anonymous cached-speech redaction. Privacy helpers: 8/8.
- Game UI/autosave/privacy/context unit command: 38/38. Contracts9 and config/locales18
  passed in their own commands. Whole workspace types, ESLint and formatting passed again after the final
  terminal-intent and UI adjustments.
- Independent re-review ran 34 checks (26 completion-core +8 privacy), found no additional
  concrete local architecture gap after the communication/routing fixes. This does not
  replace final runtime or actual browser acceptance.
- First aggregate completion run had 112/114 Node tests pass: one obsolete 140-message
  burst fixture exceeded the newly bounded reply queue, and its parent wrapper failed.
  The test now drains batches of eight while retaining all 140 persistence/privacy
  assertions. Limits and expected outcomes were not weakened. A subsequent final aggregate passed **115/115** in 252.45 seconds on the
  corrected source. The earlier failed run is retained here rather than relabeled green.

Final runtime log: `/tmp/dreamwalk-npc-full-completion-final.log` (disposable local
PostgreSQL, no preview reset). Tests also migrated the separately staged asset-library
schema, which is not used by NPC scenarios and will not be included in the NPC PR snapshot.
The final PR CI must therefore verify the standalone NPC snapshot and expanded browser
scenario. The new asset module has its own service tests and separate integration work;
its existence is not counted as completed NPC architecture or a completed image feature.

### Final local aggregate outcome

The final production build, full-workspace typecheck, ESLint, Prettier, platform62 and
SMTP1 all passed after the integration fixes. Game runtime115 passed on the final runtime
source; core91 and the additional UI/privacy/context38 checks passed. The exact completion
browser scenario remains pending the updated PR's CI, and live-model quality remains an
explicit external gate. No local unfinished requirement is being relabeled as a paid-API
blocker. The separate new image-library task is outside this NPC acceptance snapshot.
