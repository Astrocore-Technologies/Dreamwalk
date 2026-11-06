# Dreamwalk — local platform release candidate

Updated 2026-10-30. Base repository: `main`, initial commit `391348b`; it contained only README and no application. This document records local verification. Repository publication is tracked separately in the authorized draft pull request. **No hosted deployment, real AI invocation or payment is included.**

## Delivered scope

- Next.js16/React19 + NestJS12 modular monolith, strict TypeScript, npm workspaces/lockfile, real PostgreSQL17.10, migrations001–009 and repeatable original-content seed.
- Original fantasy covers and provenance, self-hosted fonts, owner-approved plum/pearl/gold dark theme and ivory/plum light theme, responsive shell and accessible controls.
- Real signup/signin/session/onboarding/profile/preferences/security workflows, hero preparation, searchable catalog, favorites/library, separate NPC and adventure studio, safe raster media, version previews and moderation.
- Owner's later publication rule implemented: private accepted-invitation-only versus public moderator-approved. No unlisted link mode. Invited readers cannot edit or read NPC secrets. Revocation removes future detail/media/library access. Existing approved public version survives draft edits/re-review; withdrawn private content requires new approval to become public again.
- Demo ledger with idempotency/concurrency safety, guarded admin/model/runtime/taxonomy/report tools and audit.
- **818 keys per locale** in Ukrainian, English and Russian, including errors, notifications, validation, ARIA, admin and static/help pages. Authors write once. Original title/synopsis/source language are retained, valid approved locale variants are displayed per field when available, and missing/stale variants fall back to originals. Full story/NPC text remains unchanged. Curated seed metadata has all three variants; automatic translation is disabled. Intl dates/numbers/plurals respect the saved timezone.

## Executed verification

| Check                                                      | Result                                                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                        | Passed across contracts/API/web                                                                                                    |
| `npm run lint`                                             | Passed repository ESLint                                                                                                           |
| `npm test`                                                 | 7/7 shared-contract tests passed                                                                                                   |
| `node --import tsx --test tests/platform-locales.test.mjs` | 8/8 passed: key/token parity, real translations, Intl, literal/dynamic keys, Latin+Cyrillic UI audit, no obsolete unlisted choices |
| `npm run build`                                            | Production contracts/API/Next build passed; final rebuild performed after UI changes                                               |
| `npm run test:integration`                                 | **49/49 passed** using real PostgreSQL, migrations/seed and live Nest HTTP; includes config/locale tests                           |
| `npm audit`                                                | 0 vulnerabilities, including development dependencies, at verification time                                                        |
| Client credential scan                                     | 12 built client files scanned; no match for private generated database credential                                                  |

Integration evidence includes signup/login, three-locale persistence through relogin, settings/ownership, password/session/deletion boundaries, actual operator grant/audit, valid and malformed raster uploads (including spoofed SVG), private media ACL, immutable public/private NPC snapshots, draft search secrecy, moderated publication/reapproval, explicit invitation acceptance/read-only/revocation/decline/admin-denial, private report-title redaction, per-user media quota under concurrent uploads, ledger replay/conflict/nonnegative concurrency/append-only trigger, runtime restrictions, taxonomy, session activity, metadata-language revision/fallback/stale-redaction/private-access/moderation/version guarantees, and migration/seed rerun idempotency.

Verification logs, credentials, databases, browser sessions and screenshots of synthetic runtime data are excluded from the source repository and delivery archive.

## Actual browser evidence (CUA)

- Registration, onboarding, authenticated home and persistence after reload.
- English and Ukrainian interface; saved language and Europe/Kyiv timezone survive reload. Curated demo title/synopsis variants switch with the preferred language; an unlocalized authored story retains its original text.
- NPC creation and private notes saved/reloaded; complete adventure form with world/rules, location, NPC link and opening scene; preview, save/reload and confirmation cancel.
- **After explicit owner consent**, a synthetic local story submitted once, became pending review, approved by synthetic QA administrator with reason, appeared in local catalog as published version1. Safe NPC greeting visible; private secret absent. This was local test data, not external publication.
- Private test story invitation to synthetic seeded `@dreamwalk`: pending row, revoke cancel retained pending, confirmed revoke persisted after full reload.
- Real desktop and approximately500px narrow-window rendering; narrow content width485px with no horizontal overflow. Mobile home/library and navigation drawer open/close checked.
- Account deletion confirmation cancel preserved account settings; admin overview/audit and operator grant displayed.

Representative desktop, narrow home/library, author studio, administrator overview and published-story screenshots were inspected. They contain synthetic QA runtime data and are not committed.

## Follow-up verification after initial publication

- Initial platform source was published in PR #1 and merged by the owner. A tests-only correction is in draft PR #2. Both PR #2 CI runs passed: typecheck, lint, production build, 7 contract tests, 49 integration/config/locale tests and all 5 Chromium end-to-end tests.
- Those real CI browser runs verified the 390px layout, account persistence, author submission, language persistence and two-account invitation acceptance/revocation. Earlier local-tool restrictions were not bypassed; the CI browser is separate evidence.
- Explicit operator export/purge processing now has 55 passing integration/config/locale tests, including owner-only downloads, expiry, physical media deletion, retry and fixed historical tombstones. The account now exposes archive status and authenticated downloads. No live user queue was processed during testing.
- A real isolated PostgreSQL logical backup/restore drill passed all 11 checks: exact contents of 20 tables, migration checksums, asset hashes, sessions, fresh login, private invitation/asset access and revocation, public versions, ledger balances and immutable triggers. This used synthetic source and fresh restored databases, not the preview database. See the backup runbook.
- Optional SMTP recovery/verification now passes local capture integration with real Nest/PostgreSQL: disabled-mode no writes, uniform anonymous responses, cooldown, expiry, replay, single-use concurrency, safe request/consume locking and session revocation. Additional export/email browser tests are supplied for the next CI run; initial green CI does not claim coverage of new follow-up changes.

## Verification limits and external gates

- Not every admin mutation was clicked in browser: model/runtime/credits/report actions are covered by API tests; actual browser moderation/audit was verified.
- External SMTP delivery is not configured or claimed. Local capture testing is separate from real-provider operation. No external emails were sent.
- Export/purge processing is explicit operator work, not an always-running queue worker. It must be scheduled and operated according to retention policy; backup copies and third-party copies are outside a single live-database erasure operation. Pseudonymous financial/event identifiers remain, while private prose and media are erased.
- Policy/help/legal pages remain closed-test templates, not jurisdiction/age/retention/legal approval. Public launch requires owner decisions, real mail/storage configuration, a production backup schedule and deployment/security review.
- The restore drill proves the local logical restoration path, not an external disaster recovery service or production recovery-time objective.
- Game runtime, PixiJS, AI sessions, multiplayer, Discord Activity, automatic AI translation and real payments remain intentionally unavailable. Platform preparation is not simulated gameplay.

## Latest bundle checks

The complete follow-up bundle includes the approved discovery redesign, operator data processing, optional email, controlled/custom tag localization and revision-bound public NPC translations. No automatic translation provider is active; authors write once and untranslated fields fall back to their original text. Public snapshots retain approved variants, and NPC private notes are never included.

Latest strict typecheck, workspace ESLint, production build, 9 contract tests, 8 locale tests, 62 real PostgreSQL/API/config/locale checks and the SMTP capture integration scenario passed. Dependency audit reports zero vulnerabilities. The interface has 854 keys per language. Final restored-schema/browser checks are recorded in the release handoff and pull request; newly added browser test source is not a claim that the next CI run has passed.

## Bugs found and fixed during verification

- Bodyless DELETE handling, Zod default overwrites on PATCH, private draft metadata/media leakage and mutable NPC previews.
- Developer preview host/port forwarding, hydration origin handling, locale hydration consistency, and credential-bearing form GET fallback. Sensitive submits are disabled until hydration and mutation forms use POST; only disposable synthetic QA values were involved in the initial finding.
- Updated vulnerable sharp to0.35.5. New decoder correctly rejected a corrupt test PNG CRC; fixtures were corrected and malformed-image rejection retained. Raster magic signatures are checked before decoder use.
- Corrected admin bootstrap UUID/text SQL parameter typing; failed transaction rolled back, no data reset. Graceful shutdown waits for PostgreSQL cleanup; no live PID lock is blindly removed.

## Operational state / next step

The local preview uses the preserved development database. Runtime reloads preserve users and stories; the explicit synthetic administrator bootstrap flag is removed after use. No preview session credentials or ephemeral URL are published in this repository.

Next step is owner review of this platform candidate and resolution of explicit operational gates before any public launch. Do not silently start G0, spend money, merge or deploy. The owner separately authorized a draft pull request for source review. See `docs/platform-acceptance.md` for feature-by-feature evidence and `docs/implementation-plan.md` for later phases.

## Hybrid RPG G0–G3 local vertical slice — 2026-10-30

The owner approved the new hybrid architecture and implementation with «приступай».
This supersedes the former no-free-walking gameplay queue, not the platform or its ACL.
PR #3 was observed merged by the owner at 13:58:18 UTC (merge
`e88a9318ce30ae94465c74b58f61ff0c8266e6aa`). Local Git HEAD remains the original
bootstrap commit: current implementation is in the working tree, not falsely described
as a checked-out remote game commit. No new game PR, push, merge or deployment has
been performed as part of this local slice.

Implemented:

- Strict playable-map/action/projection contracts and pure deterministic game-core.
- Explicit pinned observatory campaign, account membership/invitations, server-owned
  movement/pathfinding/range/doors/items and separate map locations.
- PostgreSQL CAS writer, atomic committed state/events/results/outbox, movement
  checkpoints, snapshot checksums, restart-safe idempotency and private WebSockets.
- Per-actor control epochs, input generation/sequence, authoritative stop, live
  session/membership checks and stale-input rejection after reconnect/replacement.
- One-round local coordinated encounters: parallel intent selection, deterministic
  item/cell conflict handling, overlap relocation, deadline/default wait and return.
- Bounded mock NPC decision with perceived context, ownership/allowlist/staleness
  validation, actual path movement and transfer of an existing token.
- Pixi renderer with original temporary atlas, accessible HTML actions, touch/keyboard
  controls, camera, inventory and three complete UI locales. No paid calls.
- Account exports include only own actor/inventory; erasure anonymizes history,
  removes the actor/member, preserves party items and pauses deleted-owner campaigns.

### Actually verified

- **24/24 core tests**, including 2,000 seeded trace steps, wire privacy and hostile
  proposals. **9/9 existing contract tests**; **18/18 config/locale checks**.
- **12/12 real PostgreSQL/WebSocket integration checks**, rerun on frozen backend/core:
  two separate accounts, origin/membership rejection, malformed WS, stop/lease swap,
  simultaneous unique pickup, exact replay/conflict, actual API SIGKILL recovery,
  door/map split, hidden entities, round deadlines across restart, NPC give/move,
  export/purge and online access revocation. Independent isolated test DB only.
- **62/62 platform integration/config/locale checks** rerun after game integration.
- Local SMTP capture regression passed; no external message sent.
- Production build, strict workspace typecheck and repository ESLint passed.
  Game UI/localization/atlas tests pass, including quick-tap regression guard.
- Managed CUA browser: created a real campaign, walked to key, picked it up (removed
  from objects, present once in inventory), unlocked/opened door, walked through,
  changed to roof and reloaded. Roof and key survived. UK and EN UI observed.
- CUA also observed local encounter boundary/deadline and timeout back to exploration,
  mock keeper transferred Moon token, and a short ArrowUp press moved (4,6)→(4,5).
  The initial quick-keyup implementation canceled the step too early; it was fixed
  and the same actual browser action was repeated successfully.
- Three real sanitized screenshots were delivered separately; they are not source
  fixtures. Preview reused the existing development database, recovered by its own
  PostgreSQL WAL process when necessary, then cleanly restarted without a data reset.

### Remaining gates and honest limits

The independent **two-browser-context** Playwright scenario is written but has **not
run** for the new game source. Managed local browser restrictions prohibit a separate
local Playwright runner. A separately authorized draft PR/CI run is the next required
browser gate; two shared-cookie tabs are not reported as two users.

See `docs/game-acceptance.md` for the precise gap map. This is a fixture vertical slice:
known static floor plan, dynamic-entity FOV, single-action requested mock decisions,
one-round coordination, orthogonal goal movement and full checkpoint snapshots. It
is not a complete tactical combat system, autonomous learned NPC society, map editor,
production event-compaction design, proven four-browser/load target or public release.

Next: finish permitted two-context CI and resolve any failures. Stop before G4 until
the owner chooses a provider/data policy and approves a hard spend cap. Automatic
translation, paid images, Discord, purchases and deployment remain separate gates.

## 2026-10-30 — PR #4 verified; next mock-only tranche authorized

Both GitHub CI runs passed on `9843ca7e51eeb892c9227d7dd88304da8cfad773`.
This includes 8 browser scenarios: the game scenario uses two independent browser
contexts and verifies shared pickup, reload, door/map separation, locale independence
and the 390px layout. The initial mobile failure was fixed by removing the responsive
grid's intrinsic minimum width; the strict overflow assertion remains unchanged.
PR #4 is an open draft at this checkpoint, not merged or deployed.

The owner authorized the next local implementation sequence:

1. Studio authored playable maps, immutable versions, private tests and approved public
   launches, with separate source-story and campaign access checks.
2. Multiple local coordination rounds, deterministic joins/leaves and recovery of
   persisted deadlines without blocking players elsewhere.
3. Bounded persistent mock NPC goals, event memory and validated action sequences.

Acceptance evidence for these additions is pending. Existing narrative-only stories
must not be advertised as playable. Author edits must not mutate running campaigns.
No real AI, paid image generation, payments or deployment is authorized by this tranche.

### Authored runtime milestone (before Studio autosave extension)

- Implemented separately stored authored game drafts and immutable compiled packages,
  source-location/NPC references, fixed asset manifest and source-aware campaign ACL.
- Added bounded grid-template editor, private immutable playtest and approved-version
  launch; existing eight narrative authoring steps remain. This is a basic map form,
  not a professional level editor or image generator.
- Added real multiple coordination rounds, boundary join requests, checked flee and
  completion votes, plus persistent bounded NPC mock plans and 16 observed-event facts.
- Isolated runtime run passed 29/29 after migration 013: legacy 12, authored 6, rounds 4,
  NPC plans 7. A later moderator-preview/approval-binding refinement requires the final
  aggregate rerun. An intermediate replay run hit only a 5-second HTTP transport timeout
  during local contention; transport bound increased to 15 seconds, gameplay assertions
  and authoritative round deadlines unchanged.
- Managed CUA created “Сад місячних ліхтарів” through Studio, changed map title, wall and
  starting cell to (4,2), saved and launched immutable version 1. The rendered map used
  those changes. Requested NPC action resulted in its token entering the player's actual
  inventory and the NPC moving to its patrol point (7,4). Round 1 advanced to round 2;
  reload retained round 2 and remaining deadline, and an end vote restored exploration.
- The existing synthetic preview database was retained. UI inspection stopped when the
  user returned to the preview, rather than competing for navigation.
- Full production build, typecheck and lint passed before the final moderator and new
  autosave additions. These are milestone results, not claims about later untested edits.

The owner then explicitly required automatic saves. Game durability is already automatic;
Studio narrative/NPC/playable autosave with revision guards was implemented and verified below.
Publication remains an explicit, moderated action. No real provider has been enabled.

### Studio automatic-save evidence

Narrative/NPC edits now use independent monotonic edit revisions (migration 014).
Real PostgreSQL targeted concurrency checks passed 3/3: simultaneous writers get one
success and one stale conflict; invalid edits do not overwrite; translation edits
invalidate old tokens; map/narrative revision streams do not conflict unnecessarily.
The shared client controller serializes debounced writes and retains edits made during
in-flight requests. Manual lifecycle actions flush the same writer, not a second PATCH.
Client-focused typecheck/lint and 26 autosave/UI/locale checks passed.

In a separate managed QA tab, existing narrative title, playable map title and NPC
public description were edited without pressing Save, acknowledged by the automatic-save
indicator, then verified after reload. An empty narrative title remained local with a
visible invalid-field warning. First creation remained explicit. The QA tab was closed;
the user's existing preview tab was not navigated or altered.

Unacknowledged invalid/offline input is held in browser memory, with leave warnings;
recovery after a browser crash is not promised. Publication is never automatic.

### Transport regression uncovered under contention

A real healthy client's 2.5-second JavaScript stall reproduced a premature WebSocket
1006 close in the previous one-missed-pong policy. The gateway now uses a 2-second
movement-stop threshold sampled every second and a 5-second close grace, while keeping
one-second authorization checks. Targeted real-socket tests proved recovery of the
stalled connection with fresh input and closure of a genuinely silent peer. Movement
and gameplay speed assertions were not relaxed. Final combined evidence follows after
all frozen-source checks complete.

### Final frozen runtime and offline evidence

The complete frozen runtime suite passed **35/35** (92.2 seconds): legacy cooperative
gameplay, authored immutable packages and access, moderation review binding, multiround
lifecycle, persistent NPC jobs, revision-guarded autosave and heartbeat recovery. A new
separate offline-pause acceptance passed **1/1** on the same frozen API/core: **36 distinct
runtime checks**, not a claim that all 36 ran in one combined invocation.

After the last WebSocket disconnects and no HTTP access refreshes the campaign, the
runtime checkpoints and sleeps. SQL-only observations confirmed that tick and NPC state
stay unchanged; reconnect resumes normal ticks without offline catch-up. Round deadlines
remain absolute persisted timestamps rather than being extended; an expired round can
resolve once safely on reconnect. No paid calls or autonomous background simulation run.

PR #4 was merged into main as `32a5f807d124e82bd7ae63ffc343150ae909f3da`. This next tranche
remains local until separately authorized publication. Its new authored browser scenario
has not run in CI yet. The workflow now explicitly runs contract/platform unit checks
and game rules/UI/autosave tests, in addition to runtime and browser checks.

Aggregate checks at 15:58 UTC also passed: full workspace typecheck, ESLint, production
build, 9 contract + 38 core + 18 platform configuration/locale unit checks, 18 additional
UI/autosave checks, 62 existing-platform PostgreSQL checks and the SMTP capture scenario.
Changed-source formatting passed; four pre-existing unrelated files fail whole-repository
formatting and were intentionally left unchanged.

The owner subsequently clarified that offline pause must also freeze the remaining
round duration. The absolute-deadline behavior above is therefore superseded work in
progress, not the final accepted pause contract. Durable clock pause/resume and tests
that stay offline past the old deadline are being completed before the final handoff.

Migration 015 now implements the clarified true-pause contract: remaining round and
queued mock-job durations are saved atomically and restored once on resume. Last-player
disconnect pauses immediately; HTTP-only presence expires after five seconds. A short
paused hot cache supports stalled-socket recovery without advancing simulation. Crash
recovery uses the durable remaining-time checkpoint; final regressions are running.

The full true-pause runtime regression passed **39/39** in 139.9 seconds after migration 015. This includes the beyond-deadline disconnect/crash case, one-time resume, another
player keeping the world active, queued-job time suspension and erasure-clock cleanup.
A final migration-compatibility refinement reconstructs pre-015 queued-job remaining
budgets from their durable campaign checkpoint; its five affected offline tests are
being rerun separately. No remaining-time reset is granted by duplicate reconnects.

### Local handoff status

Final affected offline checks passed **5/5** (45.9 seconds), including pre-015 queued-job
clock reconstruction. Together with the preceding **39/39** complete runtime run this
covers **40 distinct runtime checks**; the compatibility refinement was tested by the
affected suite, not misreported as a later complete 40-check invocation. API/core are
frozen. No outstanding known functional failure remains in the scoped mock tranche.

New authored Studio/autosave/mobile browser acceptance remains unexecuted in remote CI
until the next PR is authorized. Actual managed-browser checks and the earlier merged
PR #4 two-independent-context scenario are separate evidence, not substitutes for that
new CI run. Remaining product work includes professional editor/asset pipeline, richer
combat and autonomous observed-event NPC decisions. Real AI, payments, Discord embedded
verification and deployment remain separate gates; no such operation was enabled.

Final source recheck at 16:14 UTC passed full workspace typecheck, ESLint and production
build after the clock-compatibility refinement. Formatting passed for all changed
supported source files. The earlier 62 platform and SMTP regressions remain valid for
unchanged platform code; the modified game runtime was exercised by the suites above.
Source is frozen for an authorized next PR; preview restart retains the existing database.

### PR #5 browser acceptance corrections

The first remote run passed runtime/platform/build checks but exposed three browser
issues. The strict client envelope omitted the new `paused` boolean and rejected otherwise
valid HTTP/WS projections; the schema now accepts that typed optional field while still
rejecting unknown fields and invalid types. All 162 received envelopes from the failing
CI trace parsed with the corrected schema. A permanent real HTTP/WS schema assertion was
added. Map-editor select labels now have explicit translated accessible names so option
text cannot alter exact label lookup. The older narrative-only platform scenario now
asserts the actual first-save/map prerequisite rather than a removed pre-game placeholder.
No gameplay or autosave assertions were weakened; new browser CI verification follows.

## Living NPC architecture — implementation in progress

The owner approved implementation of the full 19-section living-NPC architecture,
with real provider calls, purchases, deployment and merge remaining separate gates.
Baseline is merged PR #5 / main `a015bbc1576d08352a4744d2600b2bde6843c42a`.
See `docs/npc-implementation-coverage.md`; the historical limitations above are not
claims about the newer work in progress.

New campaigns explicitly opt into `hybrid-v3`; existing v1/v2 saves retain their
semantics. The new core contains private evidence/rumor/belief layers, per-actor
relationships, durable obligations, bounded personality-driven routines, grounded
summary context and audience-filtered speech. The mock repertoire is deliberately
finite: investigate, assist with an already owned item, warn, patrol and secure an
accessible door. It is not an arbitrary profession, combat or container simulator.

Author profiles, knowledge, habits, decision examples and links remain in immutable
playable versions. The owner sandbox inspects a saved authored draft, never a private
live party's brain. Runtime speech and public generation use separate audience-safe
contexts; raw player statements are untrusted data, not authoritative world facts.

A durable AI job/provider boundary and demo-credit reservation accounting are being
integrated and fault-tested with local fakes. The configurable HTTP JSON adapter is a
contract for a trusted adapter endpoint, not a verified integration with a named model.
No external requests or real purchases have been made. Drawn 2D is the only approved
visual direction; existing fixture sprites are temporary.

At 18:35 UTC, focused tests passed: 60 core checks, 12 real-PG runtime cases before the
cold-episode archive addition, 14 real-PG AI cases, 30 UI/autosave/locale checks before
additional authored fields, and 3 pure privacy checks. These are intermediate results,
not a final aggregate regression. Additional archive, authoring and fault checks are
underway. Cloud native browser is unavailable; new browser acceptance source exists
but has not been executed. Final counts and publication status will follow only after
source freeze and actual verification.

### Living NPC integration checkpoint — 18:56 UTC

The complete current game PostgreSQL/API/WebSocket regression passed **79/79 Node tests**
in 190.4 seconds (`npm run test:game:integration`), with migrations 001–017 in a disposable
cluster. This includes the old authored/rounds/clock compatibility scenarios and the new
AI accounting, evidence, archive, speech, promise, crash and privacy cases. No transport
or gameplay timeout was relaxed to obtain the pass.

Independent review findings were fixed before this full run: summary application now
uses next-revision CAS; speech receives allowed words and a separate public style enum;
erasure removes paraphrased replies and other participants' cached command responses,
including speech whose speaker identity was not visible. Runtime caches invalidate on a
newer durable campaign revision. The real cached-response replay case passed in the
complete run, not only in a pure helper test.

Full workspace ESLint and production build passed. Final platform/SMTP/type/unit reruns
are still in progress. New two-independent-browser acceptance is prepared but unexecuted
until authorized CI; it does not inherit a pass from PR #5. Permanent preview has not been
restarted or reset during this tranche, and no external AI request has been made.

### Living NPC local source freeze — 19:13 UTC

All remaining local checks passed: **62/62** platform integration, **1/1** SMTP capture,
whole-workspace typecheck, **9/9** contracts, **65/65** core, **18/18** configuration/locales
and **31/31** UI/autosave/privacy helpers. Complete ESLint, production build and formatting
checks passed. Three pre-existing formatting warnings in errors.ts, layout.tsx and the
web tsconfig were corrected without logic/config-value changes; no dependency was added.
The complete game runtime result remains **79/79** on the frozen functional source.

Coverage, concrete defaults, supported actions and remaining external gates are recorded
in `docs/npc-implementation-coverage.md`. Provider integration is configurable and locally
fake-tested, not live-vendor verified. Runtime routines are autonomous and free; provider
jobs are explicit, not an unapproved paid sponsor loop. Cold history and safe speech are
implemented, not a claim of arbitrary humanlike intelligence or unlimited simulation.

Prepared for an owner-authorized separate pull request. The new two-context browser
acceptance must run in its CI before browser completion can be claimed. No deployment,
merge, real provider request, purchase or permanent preview/database reset occurred.
The user's separately running Windows copy remains stable merged main, untouched.

### Full-architecture completion pass — in progress after initial PR

The owner correctly identified that the first PR did not close every agreed requirement.
The tracker now names individual requirements instead of labeling whole sections complete.
The intermediate PR #6 source at `96888cb2e3326b16a8922cede716a72aa2cff213` passed both CI
runs: ten browser scenarios and the earlier 79 runtime checks. Its label-persistence and
countdown-only projection race fixes remain in the completion source. These passes are
not being reused as proof of the newer features below.

Completion work adds ordinary dialogue orchestration, OOC isolation, confirmed natural
language intents, authored facts/goals/conditional promises, real provider protocol fixtures,
explicit shared sponsorship, immutable moderation sandbox, bounded needs and memory
retention. Targeted tests are underway; aggregate final-source verification is still pending.
A retention review found that deleting old reply provenance could impair later erasure;
compaction now keeps text-free causal metadata and has an explicit derived-reply regression.
The user's Windows instance was stopped on request and has not been restarted.

The separately approved reusable-image library is being developed in isolated new files.
It is not silently included as an accepted NPC feature or used to delay reporting failures.
No paid provider or image-generation requests, deployment or merge have occurred.

### Full living-NPC local acceptance — 20:13 UTC

The corrected full completion source passed **115/115 PostgreSQL/API/WebSocket tests**
in 252.45 seconds, including the ordinary conversation pipeline, significant-event
routing, OOC isolation, confirmed intents, item and non-item promises, sponsor budgets,
immutable moderator sandbox, cold-memory stress, compacted-provenance erasure, crash,
revocation and all prior round/offline/movement behavior. A failed provider intent now
reaches a terminal state instead of occupying a pending slot indefinitely.

The final production build, whole-workspace types, ESLint and formatting passed. Existing
platform regression passed **62/62** and local SMTP capture **1/1**. Core reached **91/91**;
UI/autosave/privacy/context checks reached **38/38**. The deterministic behavioral rubric
passed **7/7**; its small measured in-process benchmark is explicitly not production
capacity or a real-model quality assessment. Exact final unit commands are recorded in
the publication manifest, not combined into a misleading unique-test sum.

Independent re-review found no further concrete local implementation gap after the
reference-only communicate route and event-scheduling fixes. Extended browser acceptance
still requires the exact updated PR CI; the earlier intermediate ten-browser pass is
not presented as verification of these later UI flows. Live provider/model quality,
actual billing and paid activation remain separately gated. No paid call, deployment,
merge or restart of the user's stopped Windows instance occurred.

The reusable-image library has separate service tests and is deliberately excluded from
this NPC source snapshot. Its Studio, renderer, version-checksum and delivery integration
continues separately; a library prototype is not advertised as an already playable
custom-art pipeline.

## 2026-10-30 — Reusable art integration and NPC CI closure

Full NPC completion PR #7 passed both exact-head CI runs at
`da9e4fe0697611f9724ac379de9f98853a0f7901`, including 115 real runtime checks and
all 10 browser scenarios. The user subsequently merged it; asset work is based on
main `4ec3d857f331ff36b509c8ad300b8f797ce705ef`. This closes the browser gate recorded
above, not the separate live-provider quality/cost gate.

The reusable drawn-art module now connects sanitized uploads, revisioned metadata,
explicit cross-author reuse consent, search-before-generation proposals, Studio slot
autosave, immutable playable-version pins, moderator review, authenticated delivery
and the actual scene renderer. Public display does not grant library discovery or
reuse permission. Revoking future reuse preserves explicitly consented existing pins;
takedown and confirmed erasure withdraw delivery and live rendered art. Campaign state
remains separate while approved image bytes are reused without a generation charge.

Verification: production build passed; platform 62/62, SMTP 1/1, core 95/95,
UI/autosave/privacy/art 48/48, contracts 9/9 and configuration/locales 18/18 passed.
The asset HTTP/PostgreSQL suite passed 23/23 on final affected source, including
publication/erasure races, grants, old-version pins, hidden-entity delivery denial,
review invalidation, replay filtering and live withdrawal. The integrated gameplay
suite passed 115/115 before the last isolated asset-query/erasure fixes; those fixes
were rechecked by the final 23-test asset suite. Exact-head CI will repeat both.
The new asset browser scenario is authored but not yet executed locally; CI must
verify Studio-to-canvas rendering and its real canvas screenshot artifact.

Rendering uses static rasters, not generated directional animation. Scene texture
loading is bounded to four jobs and eight megapixels retained/reserved; catalogue
and moderator thumbnails use browser lazy decoding. Library discovery is bounded,
with localized limits. No image-generation provider call, paid request, deployment
or restart of the user's stopped Windows application was performed. Live text/image
budget preparation remains a separate, default-disabled workstream and is not part
of this asset publication snapshot.

## 2026-10-30 — Art CI closure and image-generation preparation

Reusable-art PR #8 passed both exact-head CI runs at
`4543f46f3b91f9d91fb6cd039e0be09bca316063`: all 11 browser scenarios, 115 game runtime,
23 asset API/PG, 95 core, 48 UI, 18 configuration/locales, 9 contracts, 62 platform
and the SMTP scenario passed. The new browser scenario produced an actual custom-art
canvas screenshot. Its initial run exposed ambiguous nested autosave selectors; map
status now has an explicit semantic scope and both older tests retain their assertions.
This is verified raster reuse/rendering, not newly generated AI artwork.

The next, separate preparation module adds durable image quotes, explicit per-quote
consent, one-attempt jobs, shared total/purpose reservation accounting, own-reference
checks, quarantine cleanup and immutable raster admission. Studio searches for reusable
art first and makes the zero-cost mock sample unmistakable. A result is not automatically
bound, published or moderated. Existing and generated uploads share the same sanitizer
and quota. Ambiguous dispatch retains its budget reservation and is never automatically
retried; account erasure removes private prompts and quarantined bytes while preserving
unresolved financial exposure without actor linkage.

Final local verification passed: image API/PostgreSQL **20/20**, existing asset **23/23**,
full game/NPC runtime **115/115** (231.29s), platform **62/62**, SMTP **1/1**, core **95/95**,
contracts **9/9**, configuration/locales **18/18**, and UI/autosave/privacy/art/image
**50/50**. Production build, workspace typecheck, ESLint and formatting passed. The first
aggregate process was interrupted during platform checks; only the completed earlier
stages were retained, and all unfinished stages were rerun to successful terminal results.
No partial log was counted as a passed suite. New image Studio browser acceptance remains
source-only until its separate exact-head CI; the earlier 11-browser pass does not cover it.

The concrete Images protocol adapter is tested with injected transport, including
configuration fingerprints, bounds, receipts and invalid outputs. **The production image
service remains hard-disabled externally**; adding a key cannot enable it. A defensible
provider request cost ceiling and a validated activation factory remain prerequisites.
The approved one-time text/image test ceilings do not silently authorize ongoing calls.
The separate text smoke kit uses the actual NPC adapter but has made no real request;
local key entry and execution are paused during the user's power outage. No paid call,
deployment, merge or restart of the user's stopped installation occurred.

## 2026-10-30 — Image preparation CI and homepage visual refresh

Image-preparation PR #9 passed both exact-head CI runs at
`fa76d90daafd9d2435ee7c9d8276334ee7abb2bd`, including all **12 browser scenarios** without
retry. The production external-image gate remains closed; passing the mock workflow is
not evidence of real image quality, live model access or a provider-enforced cost cap.

The separately requested homepage now prioritizes adventure artwork, embedded approved
cast, manual neighboring recommendations, accepted campaign continuation and public
collection rails. Mobile stacks art before copy; all three locales and both themes remain.
No autoplay, fake popularity or personalization claims were introduced. A new explicit
published-view query prevents an authenticated author's private draft cast from replacing
the approved public feature. Existing owner detail behavior is unchanged.

Local final checks passed: production build, whole-workspace types, ESLint, formatting,
contracts **9/9**, core **95/95**, configuration/locales **18/18**, UI/privacy/launch guards
**53/53**, platform **62/62**, and discovery PostgreSQL/API **4/4**. Approved portrait bytes
were tested anonymously as accessible, while an unpublished replacement remained 404.
Five new browser scenarios and desktop/light/mobile screenshot outputs are prepared but
not yet executed locally. Exact-head CI and inspection of its actual screenshots remain
required before the visual handoff; no generated mockup is substituted for those renders.

## 2026-10-30 — Live-evaluation repair and owned campaign heroes

The owner separately ran a bounded real-model evaluation on their computer. That
exercise exposed a false stale decision caused solely by affect scheduler bookkeeping;
it is not treated as a complete live-quality acceptance. This cloud repair makes no
paid request and does not restart the owner's application.

Decision fingerprints now omit only `affect.lastUpdatedTick`. Real affect values,
knowledge, positions, object state and full audible public audience still invalidate
stale work. Reference-only planner communication is explicitly explained to the
provider; server disclosure validation remains unchanged. Independent real PostgreSQL,
authenticated controller and gated-provider regression passed **7/7**: bookkeeping-only
advance commits exactly once; mood/knowledge/audience/position changes reject; private
whisper evidence cannot become public speech. Core **95/95** and focused adapter/context
**2/2** passed. No live model was called to obtain those results.

Owned saved heroes can now be selected on launch or invitation acceptance. The campaign
pins a separate immutable personal snapshot; default traveler and legacy saves remain
compatible. My Heroes has a direct play entry, and all launch paths preserve ownership
checks, duplicate-click guards and three locales. Only the player's own snapshot is
returned; the group receives public name and visibility-scoped portrait, not notes or
backstory. Later source edits/deletion do not change that save. Confirmed account erasure
cleans snapshots and identifying labels in retained projections/history.

Focused hero PostgreSQL/API acceptance passed **7/7**, including actual raster delivery,
revocation/reinvite, SIGKILL/restart, scoped export and confirmed erasure. A two-account
browser scenario is supplied but not yet executed locally. Aggregate checks and exact-head
CI are required before calling this repair ready. See `docs/campaign-heroes.md`.

Final repair verification (31 October UTC): production build, whole-workspace typecheck,
ESLint/formatting, contracts **9/9**, core **95/95**, config/locales **18/18**, UI/privacy
**55/55**, semantic adapter **2/2**, platform **62/62** and SMTP **1/1** passed. Runtime
coverage comprises **129 distinct passed checks across split runs**: 116 completed checks
before an execution interruption, plus the unfinished legacy file rerun to **13/13**.
The interrupted file's seven partial passes were excluded from that count. This is not
reported as a single uninterrupted 129-pass run. A legacy sponsorship fixture required
an explicit confirmed-erasure transaction when deleting membership; its corrected
**15/15** test preserved the production immutability guard. The game test runner now
uses an isolated temporary raster directory rather than the preview asset store.

The new 18th browser scenario and a single uninterrupted full pipeline still require
exact-head CI. Follow-on scope is only the complete player flow, working NPC behavior,
generation/drawn scene and one small complete adventure. Translation, Discord, payments
and broad public release are deferred by the owner's latest clarification.

PR #13 subsequently passed both exact-head CI runs at `31e099d946a59c3b03bcb22405a8c30a3468bafa`: the full **129 runtime checks** ran uninterrupted and all **18 browser scenarios** passed without a retry marker.

## 2026-10-31 — One complete Observatory adventure (browser acceptance pending)

A separate authored template now has two lawful routes to the roof journal: the
ordinary brass key/main stairway or a keeper-owned token received through an explicitly
accepted promise/side stairway. The old prototype and existing saves are not migrated.
A delayed-acceptance test found the sample keeper wandering out of interaction range;
his authored patrol post was corrected, without weakening generic movement/range rules.

The server derives a once-only shared achievement from currently authorized party
members, inside the same action/checkpoint transaction. The epilogue is hidden in all
locales until completion. The completion event is retained in the existing event payload;
replay/restart does not duplicate it. Exploration remains available after the ending.
The guarded first-party seed uses the normal immutable playable-version/public launch
route and skips edited content instead of overwriting it.

Core **105/105** and focused real PostgreSQL/API **10/10** passed, including four members,
both routes, one journal owner/shared ending, hard restart/replay, revoked actors and
version pinning. Scene dressing and the journal icon are original code-native drawn
layers, not paid-generated images. Objective UI and moderator review are separate
public/private projections. Four-independent-context browser acceptance and actual
room/ending/mobile screenshot outputs are being prepared for exact-head CI; they have
not yet been executed locally. No translation, Discord, payment or deployment work was
added to this narrowed stage. Live-provider quality and external image-cost approval
remain separate gates, described in `docs/sample-adventure-live-evaluation.md`.

The complete-adventure local aggregate passed: production build, workspace types,
ESLint/formatting, contracts **9/9**, config/locales **18/18**, core **105/105**,
UI/privacy **60/60**, semantic adapter **2/2**, uninterrupted runtime **139/139**,
platform **62/62**, assets **23/23**, image preparation **20/20**, discovery **4/4**
and SMTP **1/1**. The expanded adventure checks additionally verify moderator-only
objective review and repeated seed preservation of an edited draft. The final epilogue
copy explains the original new-star/clock mystery rather than merely announcing item
recovery; this copy-only refinement passed core **105/105** and focused real PostgreSQL/API
**10/10** again. The full aggregate above preceded only that text refinement.

Curated map/entity/exit names follow the viewer's Ukrainian, English or Russian locale;
source renaming invalidates stale curated variants. This is not automatic user-content
translation. The nineteenth browser scenario and actual drawn-scene screenshots still
require exact-head CI and pixel inspection. No real-provider quality or generated-art
acceptance is implied by deterministic tests.

## 2026-10-31 — Narrative-first product alignment (local implementation; browser acceptance pending)

The owner clarified the central experience: AI and players coauthor an evolving story,
and the visual world represents its confirmed state. The initial author package is not
an exhaustive script or catalog of every future character/location. The Observatory is
an opening and acceptance fixture, not the product's narrative ceiling.

The existing authoritative game, personal NPC memory, hero saves and media/budget
boundaries are reusable foundations, but they do not by themselves satisfy this loop.
A normal-play narrative director is now being integrated: player input, bounded typed
world proposal, server validation, atomic shared canon/world commit, persistent new
locations/secondary characters and separately consented media. No proposed outcome is
shown as successful before commit. See `docs/narrative-director.md` for acceptance and
failure cases. The local implementation and bounded tests below are complete; live quality and final browser acceptance are separate gates.

Actual competitive visual/narrative quality remains unproven. Original vector scene
placeholders are not final painted assets; mock acceptance is not live-model quality.
Paid calls, secret entry, local restart and deployment remain separately controlled.

The preceding complete-adventure source subsequently passed both exact-head CI runs
at `0eadc856d3516f732f91ab40c5b29488adcdd9a4`. The new four-independent-player journey
passed both runs, including shared ending/reload and actual desktop/mobile captures.
Push ran all 19 browser scenarios first-pass; PR CI retried the older two-player key
movement scenario once before passing. A separate successful-context teardown race
was fixed; this is not described as universally retry-free. Three actual scene captures
were visually reviewed by integration, UI and independent QA. They show original
vector prototype art, not final generated paintings.

Narrative integration targeted evidence now includes **117/117 core tests** and three
independent real PostgreSQL suites: normal HTTP/premise/privacy **7/7**, gated-provider
admission/rollback/privacy **14/14**, and actual raster reuse/delivery **5/5**. These are
26 distinct targeted runtime checks across separate runs, not a single aggregate pass.
A synthetic held private-inventory canary is absent from the shared provider payload,
but an invisible inventory change still invalidates its pending mechanical readset.
Confirmed erasure was tested against retained other-player responses and generated
prose, while preserving topology and the other player's real item.

Newly created editor templates now opt into the current narrative-capable ruleset.
Previously saved drafts without the flag still compile to their original v2 behavior;
old immutable campaigns are not silently migrated. Legacy saves show an explicit
unavailable state rather than leaving narrative requests pending forever.

The campaign-scoped image bridge has passed its initial full 28-check PostgreSQL suite. It reuses the
existing library-first quote/consent/admission pipeline and keeps external execution
disabled. Reuse attachment is an explicit authoritative campaign mutation, never a
client-only picture or silent source-story edit. Full aggregate checks, exact-head
browser acceptance and actual evolving-scene screenshot inspection remain pending.

The integrated local run passed typecheck, lint, formatting, production build, core
117/117, UI/privacy/guard checks 70/70, provider protocol 3/3, real game runtime
165/165, platform 62/62, asset library 23/23, image generation 28/28, public discovery
4/4 and SMTP 1/1. All provider/image responses in these tests are controlled fixtures,
not paid calls. The NPC evaluation harness passed deterministic invariants; it does not
measure live naturalness, production latency or artistic quality.

Final review additionally tightened three boundaries after the aggregate began:
returning to an older generated scene retains its own canonical description beyond
the recent-turn context window; image prompts include bounded pinned story/current
scene facts rather than a generic location name; and image authorization ignores a
hot runtime cache whose persisted database revision predates erasure or another writer.
The affected final-source checks are recorded separately below before publication.

External image dispatch remains disabled. A valid player-facing quote, explicit
consent, authorized raster admission and a separate authoritative attachment are
required; there is no automatic generation or regeneration. The normal story composer
can create confirmed scenes and new secondary NPCs without a Studio detour. Technical
provider controls are collapsed, not prerequisites for the ordinary mock story flow.

Final affected-source reruns passed: **118/118 core**, **73/73 UI/privacy/guard
checks**, **3/3 provider protocol**, and **29/29 image PostgreSQL/API checks**.
The image suite includes stale-hot-cache erasure fencing and retains matching-revision
live movement checks. Independent source review confirmed the fence is used at quote,
dispatch and admission. Final typecheck passed; publication records the terminal lint
and formatting results alongside the immutable snapshot. The expanded twentieth
browser scenario and its actual scene/history captures remain CI gates, not local
browser claims.

## 2026-10-31 — verified narrative baseline and complete player-journey follow-through

The final narrative baseline `223bf0679bb60080eb5e8775c91222d5e3d7f7fc`
subsequently passed both exact-head CI runs (`41170514487` and `41170510845`),
including all 20 browser scenarios on their first attempt. Actual scene/history
captures were reviewed. These use controlled provider responses and library raster
fixtures; they are not evidence of live-model quality or newly generated final art.

A real PostgreSQL regression reproduced and fixed a publication race: a membership
read between database commit and hot-cache revision promotion could evict a valid
runtime and falsely supersede its active connection. The publication fence retains
the real lease while preserving genuine second-tab takeover, external revision and
erasure freshness, and rollback release. No reconnect guard was disabled.

After the ephemeral workspace was replaced, all 327 source files were restored and
verified against that commit. A new isolated mock-only preview database was created;
no previous user database was reset. The managed preview starts successfully. Public
browser inspection verified Home, the Observatory detail page, Back navigation and
interface-language switching. It also identified an unfinished first-play detail:
guest Start loses the selected story at authentication. The current follow-through
preserves a strictly local story-return intent through authentication/onboarding and
tests explicit hero selection, launch and saved-campaign continuation. It must not
create a campaign merely because authentication completed.

Live evaluation remains separate: fresh secure credentials and an authorized network
route are required. The approved text allowance is not reset by workspace recovery;
the conservative carried budget reserve is 10,769 USD micro-units (reconciled
receipts total 769; the extra safety reserve remains unavailable). Image generation still
requires resolution of the estimate-versus-hard-upper-bound consent gate. No new
paid calls, image-generation claims, deployment or user-computer restart are implied
by the restored preview or these deterministic checks.

Follow-through verification: typecheck, whole-workspace lint, production build,
contracts 9/9, configuration/locales 18/18, core 118/118 and the then-current
UI/privacy/guard suite 88/88 passed. The final Windows preload-URL refinement
subsequently passed its affected guard suite 7/7 and the actual-application
zero-network rehearsal again. The real PostgreSQL budget-guard suite passed 6/6,
including a killed process after durable reservation; provider/sponsorship
integration passed 15/15. Rehearsal executes exactly four fake provider receipts,
two independently authenticated players, evolving scenes/NPC dialogue and an API
restart against the same saved world and ledger. It is not live-model evidence.

The Windows-compatible evaluator uses a dedicated persistent PostgreSQL ledger,
not a platform-specific directory-flush assumption. Independent review found no
additional concrete guard blocker. Actual Windows execution and the new
authenticated browser-return/Continue scenarios remain gates for the next handoff.
No credential was read and no external provider request was made in these checks.

## 2026-10-31: real story evaluation and targeted quality repair

PR17 source `4f0513c` subsequently passed both 24-scenario browser runs without a
test retry, plus pristine native Windows PostgreSQL guard and complete no-network
application rehearsal. The owner merged it; the repair baseline is main `d5fe85a`.

An explicitly authorized real Luna evaluation then completed four requests. New
room/NPC creation, two-player transitions and durable restart succeeded. Semantic
acceptance was partial: NPC identity persisted, but a prior public signal name was
not recalled despite being present in supplied claims; the continuation lacked an
actionable lead. See `player-journey-validation.md` for evidence and accounting.
The four-request allowance is exhausted; it is not reset by these code changes.

The targeted offline repair binds ordinary dialogue to its exact admitted,
audience-authorized utterance and rechecks provenance at commit. Context packing
retains that trigger; manual advanced speech remains compatible. Provider guidance
separates speaking, planning and narration, distinguishes reported words from world
truth, and asks for a supported next step. Provider fingerprints now include the
actual request instructions/schema, invalidating old caches and consent contracts.
Evaluation reports retain each input and only new target replies, with conservative
job/receipt linkage and no automatic semantic-pass grading.

Affected verification passed: real PostgreSQL delayed-speech acceptance 7/7,
provider/runtime/reporter protocol 12/12, and the complete four-fake-receipt app
rehearsal with saved-world restart and canonical media preparation. These are
provenance and mechanics tests, not a live quality retest. No further paid text
request was performed for the repair. Aggregate regression and exact-head CI are
tracked in the next publication handoff.

Final offline repair regression: typecheck, production build, whole-workspace lint
and formatting passed; contracts 9/9, core 121/121, configuration/locales/shutdown
22/22, UI/privacy/guard/report suite 96/96, and the full real PostgreSQL game suite
173/173 passed in one uninterrupted run. Browser acceptance for this exact repair
still belongs to its publication CI, not to these local results.

## 2026-10-31 — unified player story input

The normal game screen now uses one chronological feed and one composer for ordered
`*attempts*` and speech. Click an NPC to select a recipient; click the floor to move.
Directional keyboard movement is removed without disabling text editing or accessible
buttons. Whisper remains audience-scoped; Group chat is separate and never AI input.
Inline quotes and stored confirmations preserve one provider job per turn.

Migration 029 adds durable turns/feed and binds quotes to the exact provider contract
version. Actual database acceptance covers consent/replay, ordered effects, private
receipts, legacy history, restart/offline pause, authorization revocation, erasure,
and rollback of world/job/feed together. Failed inferred actions cannot commit their
dependent success prose. See `unified-story-turns.md` for the boundaries.

Local full regression passed: 191 game/PostgreSQL checks, 62 platform checks and 34
image checks, plus typechecking, production build, lint, formatting and unit/UI checks.
The final escaped-star presentation correction passed the affected UI rebuild and
103 UI/privacy/guard checks; the SMTP integration also passed.
Actual browser execution and screenshot inspection are still pending for this tranche;
these local results do not establish live model quality or successful image generation.
No additional paid calls or changes to the user's running local preview were made.

## 2026-11-01 - per-request reserves and owner policy revisions

Owner quotes can use explicitly reviewed request-planning assumptions instead of a
whole-budget hold. Text planning covers the complete serialized provider envelope;
image planning records actual prompt bytes, selected references, output assumptions,
percentage margin and fixed/reference allowances. The UI separates these operator
estimates from reported usage and provider invoice limits. Legacy fixed profiles keep
their original behavior and labels. Private photo/concept references remain supported.

Migration 037 stores immutable quote/job pricing snapshots and append-only policy
revisions on the existing authorization and financial scope. The owner reviews the
candidate against unchanged liabilities and explicitly applies it with an operation
ID and revision/hash fences. Restart, stale workers and duplicate commands cannot
silently accept another profile, reset spending, clear stops or charge twice. The
secondary NPC queue ceiling follows the acknowledged policy while preserving its
financial counters. Unknown, HTTP 403 and overrun stops remain durable. Export and
erasure retain financial evidence while removing private-input hashes.

Local verification includes production build, workspace typechecks and repository
lint; contracts/core 170/170, platform PostgreSQL 62/62, image suites 87 distinct
checks and visual/spatial 42/42. The full game/PostgreSQL regression passed 295
checks before the final queue-cap/lock refinement. After that refinement the affected
policy PostgreSQL suite passed 14/14 and owner compatibility passed 38/38, including
an actual concurrent amendment versus job-insert lock overlap. Text envelope/cap
units passed 15/15. The final UI/privacy/controller payload passed 137 with four
legacy Windows file-guard skips; database-backed guard tests ran separately.
Configuration/locales/database-shutdown checks passed 22/22.

Chromium verification covered 12 new policy/reserve scenarios and 16 existing owner
and location-art scenarios using synthetic transports. An initial test-only pending
button locator failure was corrected and its scenario rerun successfully. Desktop
and mobile captures were inspected. These checks preserve quote/consent, private
references, save/reload/reuse and map binding; they are not real provider evidence.

Examples remain disabled. No real key, paid provider request, existing user database
or stopped user application was used for this change. Manual setup and renewal are
in `owner-generation.md` and `generation-policy-revisions.md`. The owner must finish
configuration and perform the first real image test themselves; successful provider
access, real image quality and invoice behavior are still unverified.

## 2026-11-01 - independent per-request text window

Owner profiles can choose `text.contextBudgetTokens` up to 256000 independently
from verified model capacity (`contextTokens`), reserved reply length
(`maxOutputTokens`) and cumulative financial caps. The effective window is limited
by model capacity. Explicit window mode removes the former 64 KiB packing gate,
uses a separate 4 MiB transport guard, and sends `truncation: disabled`. Legacy
profiles and image budgeting keep their existing semantics. Policy changes use the
existing reviewed revisions and immutable request/pricing snapshots; they do not
reset the ledger or clear unknown liabilities and permanent stops.

Context assembly can retrieve committed, audience-authorized story history and the
NPC's own archived observations instead of only the short hot-memory slice. Whole
older optional records are selected under the complete request-envelope budget;
canon, rules, current questions, existing summaries and required evidence stay
pinned. OOC chat and other participants' whispers remain excluded. Stored history
is unchanged. Deferred NPC/director requests retain an approved body under the
same canon and phase, avoiding repeated large-context rewrites. No automatic paid
counting, summarization or retry was introduced.

The counter adapter supports verified model-specific implementations, but this
repository currently has no verified GPT-6 Luna tokenizer or connected count API.
The ordinary OpenAI path explicitly uses complete UTF-8 envelope bytes plus a
protocol allowance as a conservative estimate. This can retain less history than
a true tokenizer: 130000 Cyrillic letters occupy 260000 bytes. The large byte
fixture and synthetic exact counter do not demonstrate a real 130k-token Russian
conversation. The UI and documentation expose that limitation. See
`text-context-window.md` and `owner-generation.md`.

Local production build, workspace typechecks, lint and formatting passed. The final
UI/privacy/controller payload passed 150 with four existing Windows file-guard
skips, and focused context/transport/authoring checks passed 28/28. The full
game/PostgreSQL regression passed 297 checks before the final history-packing and
deferred-body refinements; the affected policy (15/15) and turn (13/13) suites
passed again on the final code. Image suites passed 87 distinct checks and visual/spatial authoring 42/42.
Chromium passed 15 policy/context scenarios, including complete uk/en/ru copy; the
three context scenarios were rerun after the final capture adjustment. Desktop and
mobile captures were inspected. Provider responses and browser APIs were synthetic.

No existing user database, actual environment file, key or stopped user application
was used or activated. The real location-image and text/private-photo character
adapters remain separate manual generation workflows. Successful real provider
access, actual image quality and real model-specific token capacity still require
the owner's subsequent manual setup and test. This local change is unpublished.

## 2026-11-01 - explicit manual token-count preflight

The full permitted context is retained before approximate packing. A separate
owner-consented POST can use the official Responses input-token-count endpoint,
then persist body/model/provider/policy/phase-bound evidence for normal quoting,
consent and dispatch. Migration 038 stores durable operations, attempt limits and
financial linkage. Reads, startup and NPC ticks never count remotely. The ordinary
approximate path remains available for a short first game test.

Count pricing has not been verified for the owner's live setup. The default gate
therefore blocks actual counting; it is never assigned an implicit zero price.
An optional separately reviewed fixed count rate uses the same authorization and
text/total ledger. Errors, 403, deadlines and unknown outcomes stop dispatch and
retain liabilities. Duplicate operations, reconnects and status reconciliation do
not resend. Exact token-count evidence is distinguished from configured cost and
provider invoice accuracy. Existing keys, environment and user databases remain
untouched; no real count or generation was dispatched.

The isolated PostgreSQL preflight suite passed 11/11 through the real count-to-
quote/consent/generation pipeline with injected HTTP. The full game/PostgreSQL runner
passed 308 checks (38 owner, 15 policy, 11 preflight, 244 runtime). Focused context/
count/provider checks passed 37/37 after removing the special 256k ceiling; the UI/
privacy/controller payload passed 158 with four existing Windows skips. Production
build, workspace typechecks, lint and formatting passed. Five new Chromium scenarios
passed across uk/en/ru, including duplicate clicks and reload/GET reconciliation of a
lost count response. Test-only game fixture contract errors were corrected before the
successful run. Desktop/mobile captures were inspected. These synthetic results do
not establish live provider access or invoice accuracy.

The owner clarified that 256k was an example rather than a product maximum. The
special 256000-token ceiling is removed: requested windows can be larger and the
verified model capacity determines the effective window. Financial limits and the
separate transport byte guard still apply; persistent story history can grow beyond
any one provider request. Approximate startup needs no new mandatory environment
field, and `text.counting` stays omitted while count pricing is unverified.

## 2026-11-02 — authored character and presentation milestone

Character profiles now compile through immutable story versions into the existing
NPC decision engine, with differing grounded motives/reactions and a bounded public
voice projection. Author lore is knowledge-gated before relevance; reader DTOs do not
include private profiles or lore. Explicit profile removal restores the preceding
manual configuration. Existing campaigns retain their pinned version.

Per-player relationship evidence, long-history obligations and private appraisal use
existing state rather than a parallel memory engine. Typed presentation preferences
have CAS/idempotent receipts, privacy/export/erasure handling and stale-context fences
before provider dispatch. They do not edit canon or grant raw OOC instruction authority.

See `npc-character-quality.md` for the deterministic three-character fixture and the
separate, not-yet-authorized real-model acceptance procedure. New characterization is
opt-in for authored NPCs; existing/generated NPCs retain their existing behavior unless
explicitly authored. No external card import, TTS, new emotional art or paid calls.

## Fixed battlemap and creature-size update (2026-11-02)

The latest owner request supersedes the earlier optional map proportions/no-grid
presentation: newly built maps use 24×24 cells, mandatory deterministic engine
grid, constant visual scale, and full surroundings composition. Existing saves
and immutable geometry are preserved. Creature size is validated independently
of raster dimensions; large/huge creatures occupy 2×2/3×3 cells for movement,
collision and edge interaction range, without changing action budgets or damage.
See [battlemap-layout.md](battlemap-layout.md) for compatibility boundaries and
verification scope. This source change does not perform paid generation or a
production update.

### Hero portrait creation (implementation, not production activation)

The New Hero/edit-hero modal can prepare a drawn portrait from an editable prompt seeded
with name, backstory and traits; private notes are not included. It reuses the image
quote, explicit consent, Sparks reservation/settlement, durable job and private library
pipeline. A draft context is scoped by authenticated actor, never used as a hero ID or
ownership proof. No hero is silently created or modified: the owner previews/selects
an owned portrait revision, then explicitly saves the hero. Closing the modal retains
completed artwork in the private library and recovered portrait history, without retrying
or charging for selection. Production availability still depends on the configured image
generation policy; this change does not enable providers or make live requests.

### Compact image cost confirmation (local preparation)

Hero/library images, inline location images and character authoring image stages now
use an explicit estimate button followed by one Confirm/Cancel decision. The decision
shows approximate Sparks cost, held reserve and uncertainty; it authorizes only the
current immutable quote. Rights are disclosed at estimate preparation, optional metadata
and references remain under Advanced options, and server rights/expiry/policy/framing
validation is unchanged. Editing inputs or cancellation discards the pending decision;
no automatic re-quote, dispatch or retry is introduced. Saved outputs still require an
explicit selection/binding action. This does not enable providers or publish/deploy code.

## 2026-11-02 — explicit reusable NPC silhouette placeholders

- Added optional neutral/male/female/crowd map-NPC presentation, neutral for legacy and
  unspecified entities. Three stable ID-selected original vector variants per category;
  no inference from character text and no provider calls.
- Existing bound portrait/animation wins. Labels and authoritative geometry are unchanged.
- Local exact-geometry offscreen contact sheet inspected at token sizes; schema/compile/
  projection and deterministic-render-selection regressions added. Unique NPC image
  generation remains future work, not part of this change.

## Editable NPC authoring examples (2026-11-03)

Added compact, localized RU/EN/UK example buttons to the story and library NPC
personality/greeting fields, the playable-map private speech-style field, and the
existing character-profile dialogue field. The latter component is not mounted by
main's story editor yet. Examples are ordinary editable prose, not mandatory syntax,
and do not alter runtime behavior, schemas, provider settings or published stories.
Insertion preserves the selection and all existing text, restores the caret, and
rejects an over-limit insertion as a whole with localized feedback.

Verification: full typecheck and lint passed; npm test passed (27 contracts and 205
core tests); aggregate game checks passed 252/252 after the core suite;
API/PostgreSQL integration passed 79/79; focused authoring/UI checks
passed 23/23. Independent code review found no actionable defects. Three mobile
browser cases cover RU/EN/UK insertion, selection preservation, keyboard activation,
overflow and absence of network writes. Browser execution is blocked before page
load by this executor's Chromium Unix-socket restriction; the permitted escalation
could not start because of its restricted filesystem mount. These browser cases
remain unverified locally and require CI. No paid calls, push, deployment or merge.

## Remove story duration and public scope panel (2026-11-03)

Removed fixed duration from story cards, public preparation details, the author input
and author preview. Removed the public “story boundaries” panel. Stored duration and
boundaries remain round-tripped unchanged for compatibility; the author's content
warnings step, moderation notice and NPC behavioral boundaries are unchanged. This
is a presentation change, not removal of safety rules or existing author data.

Added source regression checks and a public mobile browser case that checks the
panels are absent while API metadata remains unchanged. Browser verification uses CI;
this executor cannot launch Chromium under its Unix-socket restrictions.

## Preserve authored NPC public presentation (2026-11-03)

Public speech now includes the authored speaker's existing public name and role when
all listeners can see that speaker. Unseen or unauthorized speakers do not disclose
identity. Legacy saved speech styles map only exact known labels to bounded public
styles; explicit public style wins. Arbitrary private prose, biographies, motives and
examples stay private, and saved state is not migrated by projection.

Speech response guidance permits optional concise observable gestures alongside
spoken words, preserving player agency and treating player assertions as attributed
claims rather than verified canon. Descriptive gestures do not move tokens, create
items or grant authority. This does not implement companion following or automatic
scene/NPC creation. Regression coverage includes old saves, private-text exclusion,
prototype-key style inputs, hidden speakers and authenticated speech context.

Verification before draft publication: all 207 core tests and 17 focused provider,
semantic-context and reply-binding tests passed, as did focused lint and formatting.
Independent review found an inherited-object-key style lookup edge case, fixed with
an own-property check and regression tests. Full API build and repository-wide lint
hit local resource/dependency limitations; two dependency-install attempts were
interrupted or killed (exit 137). Authenticated PostgreSQL integration and aggregate
checks therefore remain for CI. No paid model call or production mutation was used.

## Mandatory grid and character restoration (2026-11-03)

- Fixed the PR56 gameplay regression: schematic maps with saved location art now use the same interactive battlemap canvas as grounded maps. The permanent grid, player, visible NPCs, item/exit menus, movement, camera and inventory remain available, including while art loads or after it is withdrawn.
- The separate server-authorized illustration may supply only the current schematic map's backdrop. The normal art allowlist, immutable file authorization, stale-result cancellation and texture limits remain intact. Existing entity coordinates, collision, map dimensions and saved campaigns are unchanged.
- Removed the passive illustration component and its explanation block. The existing map toolbar has a compact Actions button for keyboard access to all visible targets. No new warning banner, confirmation, paid generation, migration or configuration change.
- This is a playable fallback, not image analysis: positions come from the existing shared game state and are not evidence of raster terrain understanding. KAN-5 retains real spatial grounding; KAN-14 tracks this visible regression.
- Added coverage for backdrop isolation and withdrawal plus desktop/mobile/reload, visible player/NPC and movement/menu browser cases in UK/EN/RU. Exact browser execution must be verified in CI because local Chromium fails at sandbox socket creation; the escalation environment also fails before launch.

### KAN-11: automatic translation preparation (2026-11-03)

Prepared revision-aware, per-viewer cached localization for readable story metadata
and already-visible game prose/labels, including selected-language HTTP and socket
refresh, source preservation, strict output validation and deletion integration.
Synthetic-only tests cover deduplication, stale translations, permission boundaries
and language-switch races. See `automatic-translation.md` for scope and checks.
Production dispatch remains disconnected pending the owner's payer, spend and
content-sharing decision. This is not a claim of live automatic translation.

## KAN-16: stable game viewport and chat (2026-11-03)

- Removed the gameplay “Graphics for new scenes” disclosure. Existing image preparation,
  generation, rights/consent and binding APIs remain available and unchanged.
- Desktop gameplay now uses the viewport's remaining flex/grid space instead of an
  estimated canvas height plus additional document content. Map and story remain aligned;
  campaign/hero/party controls open in a compact scrollable panel. Narrow screens retain
  their single-column document navigation. Legacy encounter controls open when needed.
- The composer stays outside history scrolling, long confirmations scroll separately,
  and the new-event shortcut overlays history without changing its size. Reading position
  is anchored to the first visible entry across new messages, polling and layout changes;
  readers near the end follow new entries. Page scrolling is never used for history.
- Added RU/EN/UK synthetic browser coverage for desktop sizes down to 1024×600,
  messages/polling, pending confirmations, keyboard return-to-latest, campaign details,
  narrow-screen reflow and reload. Updated existing party/hero journeys for the disclosure;
  mobile offscreen-renderer coverage and explicit mock media API coverage remain.
- Local checks passed: full typecheck, repository lint, 37 focused checks and all 549
  `test:game` tests (232 core, 312 UI/domain, 5 director). Installed Chromium is
  blocked before page load by the sandbox's Unix-socket restriction; the permitted
  escalation fails before launch due to the environment mount. Browser acceptance must
  run in CI. No paid calls, merge or production deployment were performed.

## Account/admin selected-design alignment (2026-11-03)

Authenticated visual audit found missing account/overview artwork and small generic
form hierarchy. Added five bundled decorative illustrations, scoped account layouts,
icon tabs, readable session browser/platform labels and illustrated admin overview.
All account/export/security/admin mutations retain their existing guards and behavior.
No fake portraits, production changes, paid external calls, merge or deployment.
See account-admin-design.md. Screenshot coverage added; local tests intentionally
not run per owner's instruction. Full1:1 acceptance remains pending actual CI images.

## Runtime image-aware map context (KAN-5, 2026-11-03)

Added real current-map image input with server-position markers to the existing
NPC/story request. The common permitted view is masked before raster sampling;
current-map immutable pins, ownership/source access, takedowns, positions and quote
body hashes are fenced. The existing confirmation includes map analysis in its one
estimate. No collision, character relocation, art regeneration, paid request or
production activation is performed. The reviewed model-specific image accounting
and separately authorized visual-quality check remain activation prerequisites;
Luna's undocumented image multiplier/counting-endpoint price is not invented.
See `docs/runtime-map-vision.md` for behavior and the exact remaining decision.

## 2026-11-03 — runtime vision activation without an image allowance

The owner explicitly asked to enable map vision rather than wait for a model-specific
image allowance. PR69 now defaults release gpt-6-luna profiles with per-request context
planning to operational exact image-aware counting. Explicit runtimeVision:false
opts out. The count runs only on a gameplay quote POST, outside campaign/SQL locks;
the existing one quote/confirmation and actual generation-usage settlement remain.
Operational counting fee metadata stays NULL/unverified, never a fabricated zero
invoice or a second player debit. Durable evidence and unknown attempts survive
restart; source ACLs, erasure and immutable body checks remain enforced.

The API service was checked read-only through Railway. OAuth hides its variable
values, so the live model/profile is not confirmed. No live calls or deployment were
performed. Real visual accuracy remains unverified. See docs/runtime-map-vision.md.

## Studio dashboard and editor composition (2026-11-03)

Aligned the author workspace with references 14–22 using only each owned story's
actual cover, title, status and updated time: latest-edit feature, cover-card grid,
compact editor title/actions, all eight wrapped steps and a World cover context panel.
Title and synopsis now lead the Basics form. Preview and Publication toolbar buttons
only select their existing steps; save, moderation, private release, consent, lore,
NPC, location/map, scene, boundaries and autosave conflict/error controls remain.
No reference-only story, character, cover replacement or global-shell change was added.

Added a synthetic-account browser journey for 1536/390 screenshots, RU/UK/EN,
light/dark, all eight steps, persisted title/world, invalid-title Back/Stay and media
Cancel. It checks that Preview/Publication navigation sends no mutation. Browser
execution/screenshots and full API/database gates remain CI-only, not locally passed.
Focused cover/metadata/autosave tests: 17 passed; focused lint and format passed.
Current contracts and game-core builds passed; local web typecheck was killed twice
by executor resource limits. Final remote-base synchronization preserves main's
runtime-vision locale/progress additions; no local tests during synchronization.

## Catalog and creator reference composition (2026-11-03)

- Scoped public discovery cards now place readable world covers behind the title,
  synopsis, genuine author handle/initial, genre and persisted metrics/player range.
  Desktop uses three columns and mobile one. Creator profiles have a separate page
  heading, large actual avatar or honest initial, biography and portrait-format worlds.
- Reuses the original decorative world illustration in the creator banner only;
  it is not an author-uploaded image or a story cover. No new authored content,
  invented avatar, biography, popularity, publication or backend metadata is added.
- Catalog query/filter/sort, editorial hiding, direct story/hero links, readable
  creator API data and empty/error states remain. Shared AdventureCard, library,
  launch, shell and backend access behavior are unchanged. Current APIs provide
  arrays, not pagination; this visual slice does not invent pagination controls.
- Added source contracts and browser-only synthetic RU/UK/EN × light/dark ×
  desktop/mobile captures, font/image decoding, search/filter/sort/reset, query
  navigation, error retry, long content and empty publication coverage.
- Local focused source/unit checks: 11 passed; focused lint is clean. All 240 game
  core tests passed, but the npm-test contracts rebuild was killed (exit 137).
  Repository-wide typecheck and lint
  were attempted but killed by the executor (exit 137); no full-pass claim.
  Web typecheck retry also exited 137. Local Playwright Chromium is absent after
  executor restart; browser execution is not claimed. Exact-head CI and rendered
  review remain acceptance gates. Existing
  shared-shell draft owns surrounding chrome. Real story/author content differs
  from the reference; no complete sitewide 1:1 claim is made.

## 2026-11-03 — Story-detail reference composition (scoped, review pending)

Extracted `AdventurePage` into `components/story/story-detail-page.tsx`, with independent
scoped styles and an unchanged public export. The landscape banner uses the actual story
cover, including authenticated authored assets. The intro and NPC content share a left
column beside the preparation panel; real portrait cards retain public descriptions and
greetings, missing portraits use initials, and the synopsis is available in a native
accordion. Private-access warnings, versions, metrics, author links, reports, favorites,
hero return links and all existing launch controls remain. No invented players/difficulty
controls, NPCs, heroes or art. Ref59's stateful expanded picker is explicitly deferred.

`AdventureLaunch`, hero/director hooks, backend, provider, paid consent, operation storage,
and shared shell/catalog behavior are unchanged. Reading the page or using Back/Cancel
must not create a campaign or dispatch generation.

Verification: focused ESLint and Prettier passed; 45 source/controller tests passed
(story metadata/return, hero UI, start flow and Spark equivalents). Playwright successfully
listed seven new browser cases: 18 locale/theme/viewport captures plus authored/private/
empty/loading/error states, report dismissal, guest return, duplicate-start guard and
invalid hero recovery. Browser cases were not executed locally. Web TypeScript was
attempted without emitting/incremental output and killed with exit137 by this constrained
executor; it did not pass. No install/build, database/provider calls, screenshots, merge,
or deployment ran. Fresh CI and rendered review remain required, including existing paid
start, auth-return and director suites. Scoped source review is pending.

Independent source review found no privacy/access/launch blocker. Its legacy browser
selector findings were corrected: existing story metadata/art/layout tests now use the
stable `story-detail` root and scoped selectors, preserving their mobile width/button
assertions. The metadata test opens the native synopsis summary and checks visible
nonempty content. Focused lint/format and the same45 source/controller tests passed again;
Playwright listed12 cases across the four affected browser files. No browser execution
or rendered acceptance is claimed.

## Inner Studio composition follow-on (2026-11-03)

Viewed reference pixels 17–22. This bounded follow-on adds a selectable location/scene
index, focused editors with every draft field retained, actual story-cover context for
scenes and boundaries, and separate readiness/publication columns. Collection selection
is local UI state only. Inactive editors stay mounted but hidden and disabled to avoid
unfocusable native required-field errors; the unchanged complete adventure schema still
validates every draft field before any save. Adding selects the new item; deleting the
selected item falls back to the first remaining item. Original image preparation,
24×24 policy, CAS, save, moderation, private release and invitation actions remain.

No generated reference content, fabricated map preview or new safety option is included.
NPC/lore inner layouts (references 18–19) remain a follow-on gap; neither the independent
NPC library extraction nor story-NPC/lore handlers are changed. This is not 1:1 completion.
18 focused metadata/cover/autosave tests and focused ESLint passed. New browser source
covers two-item selection/edit persistence and 24 RU/UK/EN desktop-dark/mobile-light
captures across locations, scenes, boundaries and publication, with drawer-aware prefs.
Browser execution, actual new rendered review and full type/API/database/build gates
remain unrun locally and are required in integration CI. No production/provider calls.

Independent source review follow-up: selected-item deletion restores focus to the
remaining selected rail button or Add button only when the removed control left focus
on the document body. Normal typing never triggers this focus recovery. Invalid item
buttons are marked from the existing location/scene schemas, with a localized warning;
selection opens the original retained fields. No alternate or weaker validator added.
Browser source now also covers keyboard add/delete/last-scene focus, a hidden invalid
item blocking save, HTTP save failure/retry, CAS conflict input retention and cancelled
versus confirmed server reload. 26 focused source/controller checks, ESLint and format
passed; browser execution remains unrun. The separate confirmation-safety test requires
contracts/dist and was dependency-blocked, not passed; no build was run for this slice.

## Story-character and lore composition follow-on (2026-11-03)

Inspected actual pixels of desktop references 18 (story characters) and 19 (story lore).
The story-scoped NPC list now uses selectable portrait/name/role cards, explicit create,
copy and edit controls, and a separate public-description preview. Existing authored
portraits are used; absent portraits get a neutral icon, never invented story content.
The NPC schema round-trip, private profile/knowledge/secrets, CAS revisions, replay
identity, dirty confirmation, library export and explicit appearance actions remain.

Lore uses the existing persistent CollectionEditor for a left entry index and focused
fields; inactive entries remain mounted. Shared lore schema and source-reference checks
mark invalid entries in the index, while the unchanged full adventure validator blocks
invalid saves. All disclosure, question, knower, location and topic fields remain.
Preview stays explicit, save/revision/fingerprint-bound, with separate included/excluded
columns; excluded content is not rendered. No fabricated illustrations or lore added.

Checks: 33 focused source/controller tests passed (NPC templates, character UI, story
metadata, autosave), focused ESLint and formatting passed, and Playwright listed four
cases across the existing character-authoring file and the two new synthetic cases.
New browser source covers selection, private-field preservation, invalid/hidden entries,
save failure/retry, add/delete/last-delete focus, preview staleness, reload, empty/loading/
read-error retry, and RU/UK/EN desktop-dark/mobile-light screenshots with drawer-aware
preferences. Browser execution and actual rendered comparison remain unrun locally.
Direct no-emit web typecheck reached only the base public.tsx missing Badge import errors
(two TS2304 errors at line 63); parent reports that defect fixed in the later integration
head. This scoped patch does not alter public.tsx. No build, install, API/database run,
publication, merge, deploy or paid/provider action was performed for this slice. This is
not 1:1 acceptance; integrated CI and actual rendered review are still required.

## Ref59 owned hero choice presentation — 2026-11-03

Added a full-width, native-modal hero picker to the compact story selector. Cards use
only owned `/heroes` records and their authorized portrait assets, with neutral missing-art
fallbacks, an explicit traveler, loading/error/empty states, and a validated hero-management
return. Selection is immediate; Done, Close and Escape only dismiss the picker and return
focus. Preparing heroes is an ordinary management detour, not automatic creation.

The existing compact select remains compatible. AdventureLaunch receives only presentation
metadata; its controller, selection hook, disabled guard, restoration, director, quote,
consent and dispatch handlers remain unchanged. No generated or reference heroes are seeded.

Verification: 41 focused hero/start/return tests passed; targeted ESLint and diff whitespace
checks passed. Web typecheck finds the existing missing Badge import in public.tsx on the
33a2d055 base (the integration's separate Badge fix is not duplicated here). Added CI browser
cases for owned cards, keyboard/Close/Escape focus, no mutations/navigation, unchanged launch
DOM identity, unavailable/empty/error states, loading and restored locked preparation.
Browser screenshots and visual fidelity are pending CI; no local build, install, provider,
payment or deployment action was performed.

Ref59 presentation refinement: the landscape now has a readable foreground gradient rather
than a barely visible wash; the create card uses a neutral silhouette and plus badge. The
summary displays localized authored synopsis, genre and the actual supported player range,
without invented mode metadata. Close focus falls back to the programmatically focusable
hero-selection group if the trigger became disabled during restoration. Added a CI browser
case that selects a hero with an existing ready preparation, verifies locked cards, closes,
and checks fallback focus without navigation or mutation. The same 41 focused tests and
targeted ESLint passed again; controller source remains byte-identical. No build or browser
execution was performed, and the changes remain unpublished pending independent review.

## Integrated design browser corrections — 2026-11-04

Exact PR88 head4516b428 run387 passed production build/types/lint/source checks and
browser shards1/3, but shard2 and isolated PostgreSQL failed. Two shard2 failures
and the isolated authoring assertion were diagnosed from exact-head logs and traces:

- The visually hidden native hero radio was a 1px target intercepted by its fieldset.
  It now covers its own visible card, retaining native keyboard and disabled behavior.
  Browser coverage checks card-sized bounds, pointer selection for hero/traveler,
  keyboard reselection, unchanged launch identity, and restored locked-focus fallback.
- The Studio keyboard test focused a button while shared hydration protection still
  disabled it; Enter therefore never deleted a scene. Both traces retained both scenes.
  The test now waits for enabled state, verifies focus before Enter and verifies actual
  deletion, retaining all original focus restoration and persisted-empty assertions.
  No Studio application behavior, timeout, retry count or production safeguard changed.
- The isolated authoring journey used obsolete NPC row markup after presentation
  extraction. Scoped named selection/edit controls now replace structural selectors;
  persistence, private-template and duplicate-save assertions remain unchanged.

Independent source review completed.70 focused hero/start/return/metadata/NPC/autosave
checks passed, changed source lint/format and whitespace checks passed. Full types,
build, isolated DB and browser execution were not rerun locally because resources are
constrained. Fresh exact-head remote checks and rendered evidence still gate merge.

## NPC round response regression — 2026-11-04

- Every active-scene NPC now receives a model consideration on each completed player round, including empty turns; only bounded agreed off-map companion crossings stay mechanical.
- A valid, correctly fenced decision with an impossible action is retained as private cognition plus a blocked intention, with no action or belief mutation. The same known-usage job completes normally instead of creating an unresolved failure-policy hold. Malformed/stale results and unknown financial liability remain protected.
- Added explicit adjacent communication targets and full whisper-bystander guidance. The regression exercises a distant whisper, the subsequent player reply, fences and exact one-job settlement.
- Added live player-phase cost forecasts, automatic exact world-quote preparation without consent, own-account Sparks/Dreams visibility and persistent unresolved-cost messaging. Local mock tests do not establish live provider roleplay quality.
- Added a narrow owner-confirmed known-cost settlement route with exact amounts, original tariff/cache-usage proof, append-only capture/refund, concurrent replay and restart safety. It never retries a provider or rewrites historical gameplay.
- Full CI exposed deterministic planning overwriting unfinished public action plans and obligations. The follow-up retains these as private current-plan context and reconsiders them in the free mock provider without skipping the mandatory round decision or weakening action/reaction assertions.

- Turn-based speech selection is removed without losing NPC inspection or legacy real-time compatibility. Cell-based hearing remains authoritative, stale selected-recipient metadata cannot block speech, and pure emotes reach visible observers with strict whisper privacy.
- RP extras now derive from the complete reply-audience-authorized claims at freeze, dispatch and commit; new observation identities remain pinned. Mixed emote/speech does not add duplicate NPC reply jobs. Existing targetless coauthor continuation is preserved in the explicit combined quote.
- Definitive Cancel/rejection/expiry retires quote identity; uncertain transport and consent retain the same immutable retry. Browser layout assertions remain intact; only the full journey budget changes from60s to90s after measured runner-wide slowdown.

## Continue or start an independent save — 2026-11-05

Story entry now offers Continue and Start over, with a compact selector when
several accepted saves exist. Lookup spans playable revisions of the same story
and retains live-owner, membership and source-access checks. Continue is a direct
link, with no preparation or financial mutation. A confirmed finished local
launch releases its operation/director pin; a fresh start uses a new operation
and the unchanged preparation, cache reuse, consent and settlement path. Old
campaigns and snapshots are retained. Failed restore reads expose status recovery
instead of a misleading fresh-start button; unknown or pending dispatch identities
are not retired.

Verified locally: contracts/core/API build, web typecheck, 55 focused launch,
hero, metadata, return and list tests; 15 localization and private-access source
tests; changed-file ESLint and diff whitespace checks; all 18 isolated paid-start
PostgreSQL checks, including old campaign/snapshot preservation, scoped save
access and unchanged generation charge/reuse. Independent source review passed.
Added RU/EN/UK browser cases for selection, Continue, Back, reload, repeated Start
over and save retention, including a legacy completed director pin. Browser
execution is blocked locally: Chromium cannot create its required socket in the
shell sandbox, and the approved escalation fails during sandbox mount setup.
No browser assertions ran; exact-head CI remains the browser acceptance gate.
No production data, real providers or wallet funds changed in this slice.

First exact-head CI passed production/static checks, isolated PostgreSQL and two
browser shards; all five paid-start recovery journeys passed. The remaining
story browser shard exposed a missing explicit accessible name on the save
selector and two pre-existing ready-preparation fixtures that incorrectly marked
an already-created campaign. Added the translated selector name and retained
picker-lock coverage with genuinely unstarted preparations. The 42 focused
launch/hero checks, web typecheck and changed-file lint/format checks pass after
these corrections. A fresh exact-head browser run remains required.

Follow-up CI passed static/production, isolated PostgreSQL and the affected
browser shard, including all three localized continue/restart journeys. Visual
inspection of its RU desktop and EN/UK mobile screenshots confirmed the compact
layout and translations, and exposed a missing primary style on Continue. It now
uses the standard primary button style, with source and browser assertions, so
the returning-player action is visually emphasized over Start over. The 35
focused launch tests and changed-file lint/format pass after this one-class fix;
exact-head CI still gates release.

Integrated onto the main tree after scene/map recovery (#103) and recoverable
admin deletion (#101). All incoming test registrations and all continue/restart
checks remain present; map/settlement and deletion/privacy guards are preserved.
The 47 focused launch, campaign-list, deletion UI and location-only UI checks,
changed merge-file lint/format and whitespace checks pass. A fresh integrated
head CI is required before the coordinated final release.

## Occupied direct-exit arrival — 2026-11-05

Direct exits now choose a deterministic free landing within four cardinal steps
when the intended destination is occupied by an actor. The original landing and
every searched footprint must still satisfy map bounds, walls, closed doors,
active encounters and existing image-grounding admission. Only actors overlapping
the intended landing are ignored during this bounded search; final placement
uses normal strict collision checks. No resident is moved, no disconnected room
is selected, and unsafe or full destinations still refuse without mutation.
Consenting companions retain witnessed crossings and follow through their normal
world-action budgets rather than being moved with the player.

Local verification: core build and core typecheck passed; all 439 core,
travel-grounding and idempotency checks passed, including 29 new occupied-exit
regressions; whole-repository ESLint passed. The new tests reproduce Daro at
courtyard 20,12, preserve him while the player and two companions arrive at
distinct cells over normal turns, and cover large/huge footprints, bounded search,
closed doors, walls, encounters, unknown/unsafe/disconnected imagery, stale image
bindings, refusal rollback and serialized replay. An initial concurrent full
workspace typecheck was killed by local memory pressure (exit 137); serial core
build/typecheck passed afterward. API/database and browser suites were not run
locally for this slice; exact-head CI remains required. No provider calls,
production changes, repository publication or deployment were performed.

## 2026-11-06: historical reservation recovery (implementation)

- Added bounded owner-only wallet discovery and a historical authoring deep link,
  so earlier jobs are not hidden by a newer story build.
- Added legacy-only NPC/player recovery UI using the existing durable confirmation
  controller. New automatic requests never gain a manual confirmation button.
- Legacy player `story_turn` uses complete original admission and cost evidence;
  exact pre-world-batch hashes are supported without dropping a real batch identity.
- Terminal funding is checked against its original receipt; pending unknown costs
  remain untouched. No migration, production mutation or provider retry is involved.
- Local focused tests and final PostgreSQL/browser acceptance are recorded in the
  task report. Production settlement still requires a verified release and fresh
  owner/job/quote/amount checks under the specific owner's consent.
- Validation: full API build and web typecheck; 250 focused backend regressions,
  38 browser-controller/discovery tests; real PostgreSQL HTTP NPC/player recovery
  (concurrent replay, process restart, owner isolation, split Dreams/Sparks),
  authoring recovery 9/9, and native/permit automatic regression 5/5 all passed.
  Local disposable PG used 1 MB WAL segments and a 16 MB WAL target due disk limits;
  transactional/locking behavior was unchanged. Browser E2E is deferred to normal CI.
