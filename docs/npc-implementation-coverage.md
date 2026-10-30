# Living NPC implementation coverage

The owner approved the complete living-NPC architecture, then clarified that development
must continue through the full implementation rather than stop after the first vertical
slice. This tracker distinguishes implemented behavior, planned work and externally gated
verification. Baseline: merged PR #5, main `a015bbc1576d08352a4744d2600b2bde6843c42a`.
The source was checked against all 166 verified PR #5 file hashes before this work.

## Current scope and gates

- Implement the domain, deterministic mock behavior, persistence, author/player UI and
  configurable provider/budget boundary with automated failure tests.
- Do not make paid provider calls, real purchases, deployment or merge. A configured real
  adapter is not evidence that a real model or payment service has been verified.
- Drawn 2D is the sole approved visual direction. Existing bundled placeholder sprites
  remain temporary; final artwork production is not part of this NPC implementation.
- Preserve old campaign rulesets, source/campaign access, automatic saves and true offline
  pause. No silent upgrade of an existing save or author-approved published package.
- Cloud native desktop is currently unavailable. Shell/filesystem work; supported local
  integration tests remain available. Browser source is not a passed browser check.

## Architecture coverage matrix

| Document section                  | Implementation responsibility                             | Required evidence                                               | Status                                  |
| --------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| 1 Baseline and gaps               | Versioned opt-in and old-save compatibility               | v1/v2 regression plus new ruleset tests                         | Implemented; local checks passed        |
| 2 Living-character criteria       | Causal behavior fixtures and continuity rubric            | Reproducible scenario outcomes, no unsupported quality claim    | Implemented; local checks passed        |
| 3 Modular architecture            | Core, writer, context, director and provider separation   | No model/SQL in pure core; one authoritative commit path        | Implemented; local checks passed        |
| 4 Knowledge layers                | Direct/heard observations, evidence, beliefs              | Hidden actor, false rumor, provenance and dedup tests           | Implemented; local checks passed        |
| 5 Perception and privacy          | LOS, bounded hearing, audiences and private channels      | No knowledge/identity leak through prompt, projection or cache  | Implemented; local checks passed        |
| 6 Personality and relations       | Versioned definitions, state and per-actor relations      | Different players and evidence-backed changes                   | Implemented; local checks passed        |
| 7 Memory and continuity           | Durable episodes, bounded retrieval, derived summaries    | Active obligations survive truncation; invalid summary rejected | Implemented; local checks passed        |
| 8 Goals and initiative            | Routine, event/time triggers, fair bounded queues         | Autonomous response without npc.request; no gossip loop         | Implemented; local checks passed        |
| 9 Actions and promises            | Typed action validation, disclosure policy, obligations   | Actual item ownership, fulfillment by committed event           | Implemented; local checks passed        |
| 10 Two-player scenario            | Guard/helper investigation and warning                    | Two real sessions; observed versus unobserved consequences      | Implemented; local checks passed        |
| 11 Durability and concurrency     | Writer/CAS, cause/step/job identity and versioning        | Crash/retry/revocation/late result tests                        | Implemented; local checks passed        |
| 12 Co-op rounds and pause         | NPC intent boundaries and preserved remaining clocks      | No future-intent reading, no offline consequences               | Implemented; local checks passed        |
| 13 AI boundary                    | Filtered context, adapters, cache, limits and kill switch | Mock/adversarial provider tests; real invocation gated          | Implemented; local checks passed        |
| 14 Financial boundary             | Quote/consent/reserve/capture/release and service cap     | Concurrent reserve, duplicate/unknown/late result tests         | Implemented; local checks passed        |
| 15 Studio and presentation        | Bounded authoring, immutable moderation, locales          | Autosave/validation/ACL/mobile/UK-EN-RU browser scenarios       | Implemented; local checks passed        |
| 16 Reliability and data lifecycle | Erasure, logging, metrics and safe fallbacks              | No retained personal evidence or revived plans after purge      | Implemented; local checks passed        |
| 17 Acceptance stages              | Unit, real PG/WS, browser and fault suite                 | Actual commands and exact counts recorded below                 | Local checks passed; browser CI pending |
| 18 Decisions and limits           | Explicit defaults, drawn-only, no paid authorization      | UI/docs never imply unsupported features are complete           | Implemented; local checks passed        |
| 19 Sources and claims             | Traceable design and current implementation status        | Documentation reconciled with tested code                       | Implemented; local checks passed        |

## Integration order

1. Settle typed private/public contracts, new immutable policy and compatibility.
2. Integrate deterministic perception, relationships, promises and autonomous plans.
3. Persist and test the shared scenario, then author/player UI and privacy erasure.
4. Integrate durable orchestration and separate mock-tested financial/provider budgets.
5. Run complete regression, supported browser verification and failure cases; fix defects.
6. Freeze source and provide publication handoff. Live-provider measurements, external
   payment behavior, production capacity and deployment remain explicit authorization gates.

## Concrete implementation and bounded defaults

- `hybrid-v3` is explicit authored opt-in. Older campaign rulesets remain unchanged.
- Perception: 360-degree LOS, Manhattan sight range 9, bounded BFS hearing range 6;
  walls/closed doors block hearing and maps are isolated. Distraction lasts 40 game ticks.
- Per-NPC cause queue 32, decision cooldown 20 ticks, routine every 100 ticks after its
  initial wake. Age promotion every 40 ticks and overdue routine scheduling prevent
  chatter from starving older causes. All promise deadlines are checked independently.
- Plans have at most 3 legal steps. Gossip depth is at most 3 with causal-root deduplication.
  No arbitrary code, HTTP, new mechanics, invented inventory or wallet writes are actions.
- Context selects 16 observations, 8 beliefs and 3 active promises. The complete registry
  retains up to 128 active promises with explicit refusal at the bound, not silent loss.
  Authored initial knowledge and active dependencies remain protected from hot pruning.
- Immutable semantic episodes are stored in `game_npc_episodes` in the checkpoint
  transaction. Private retrieval adds at most 16 old personal episodes from bounded
  indexed candidate windows. Public speech does not receive this private archive.
- Summary is grounded structured continuity, not unverified freeform autobiography.
  Sources, fingerprint, model/policy metadata and next-revision CAS are checked.
- Personalities include role, operational values/habits/taboos, links, private biography
  and descriptive decision examples. Only the separately public style enum enters the
  speech renderer. Allowed utterance text stays explicitly untrusted, never a fact.
- Deterministic routines run automatically. Provider jobs are explicit quote/consent
  operations; there is no secretly enabled paid autonomous sponsor loop. The provider
  boundary supports plan/summary/speech and conservative service-cost reconciliation.
- NPC actions are intentionally finite: investigate, assist with an owned item, warn,
  patrol and secure an accessible door. Containers, arbitrary professions, death and
  universal fail-forward are not implemented by pretending text creates a new mechanic.

## Final local verification — 2026-10-30

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

## External and product gates

N4 live-model quality, real provider protocol/usage/cost measurements, production
capacity, paid autonomous budgets, real purchases, automatic translations, generated
artwork, Discord embedding and deployment remain unverified/disabled as applicable.
These require their own authorization or product work. The configurable generic JSON
adapter is not advertised as an already verified vendor integration. Drawn 2D assets
remain placeholders; no pixel-art option is planned.
