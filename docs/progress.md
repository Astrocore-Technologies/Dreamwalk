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
