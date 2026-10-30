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
