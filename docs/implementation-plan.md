# Dreamwalk — platform first

The original prompt's platform override (§2A, §22, §24) takes precedence over historical game-first sections. The chosen product name is Dreamwalk. Latest owner instruction: interface localization for **Ukrainian (`uk`), English (`en`), Russian (`ru`) immediately**, including validation, errors and accessibility; author-written content is not translated.

## Current work packages (six)

1. **P0 foundation:** audit, npm workspaces, Next/Nest, validated config, real PostgreSQL migration/seed, shared contracts, responsive design system and navigation.
2. **P1 accounts:** registration, secure sessions, profile/onboarding/preferences, privacy/security, export/deletion workflows and reachable support/legal pages.
3. **P2 discovery:** public catalog, detail/creator pages, search/filter/sort, favorites, library and separate player heroes.
4. **P2 creation:** manual adventure/NPC studio, locations/scenes, safe media, validation, duplication, private drafts, version previews and moderated publication.
5. **P3 administration:** clearly demo-only ledger, idempotent audited adjustments, behavioral model and runtime catalogs, moderation/reports/admin roles.
6. **P4 verification:** API permissions and PostgreSQL invariants, user/author browser flows, localization parity/switching, mobile and interrupted-flow checks, documentation.

## Gates

| Phase | Acceptance                                                                                                                                                   | Exclusions                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| P0    | App launches; design tokens, dark/light shell and reachable routes; migration/seed; typecheck/lint/tests; reproducible README                                | No fake backend completion                        |
| P1    | Real registration/login/logout, persistence across relogin, owner guards, profiles/preferences, session management, confirmation deletion and export request | No false claim of email delivery without provider |
| P2    | Create/edit story + NPC, validated links, media/preview/version, moderation submit; drafts hidden; favorites persist                                         | No gameplay required                              |
| P3    | Append-only integer ledger + idempotency; RBAC and audited mutations; editable model/runtime config                                                          | No paid calls or checkout                         |
| P4    | Functional platform RC with database and browser evidence; clear unavailable game controls; three complete interface locales                                 | Not public production-ready                       |
| G0    | Strict playable maps, campaign access, deterministic core and mock provider                                                                                  | Authorized locally; no paid calls                 |
| G1    | Two real accounts walk, take one key, open a door, change map and restore progress                                                                           | Local vertical slice, not production              |
| G2    | Local simultaneous-intent rounds, deadlines, collision and independent locations                                                                             | No full combat system                             |
| G3    | NPC world actions, perception, bounded mock proposals and adversarial safety                                                                                 | Stop before real AI                               |
| G4    | Limited real text AI with separate provider budget and kill switch                                                                                           | Requires provider and spend authorization         |
| G5    | Visual pipeline and author map editor                                                                                                                        | Paid images require separate permission           |
| G6    | Discord Activity with persistent campaign identity                                                                                                           | Requires integration authorization                |
| G7    | Load, backup/restore, retention and release hardening                                                                                                        | Not implicit deployment approval                  |
| L0    | Eligibility, payment verification/refunds, legal/age policy, backups, monitoring                                                                             | Explicit launch/payment authorization required    |

The owner explicitly authorized the hybrid RPG implementation on 2026-10-30 ("приступай"). G0–G3 now proceed locally against the approved [hybrid architecture](hybrid-rpg-architecture.ru.md). The previous point-and-click/no-free-walking game queue is superseded. External publication, deployment and paid services remain separate gates.

## Later owner update: publication and sharing

Exactly two publication choices: private (author plus accepted invitees) and public (visible only after moderation). The original unlisted mode is removed, including link-only access. Implement persisted invitations, acceptance/decline and revoke, read-only recipient library/detail, and corresponding asset/metadata ACL tests. Public approved versions remain immutable and visible during re-review. This update must be complete before final P4 verification.

## Later owner update: write once, localized metadata

Store source language and optional title/synopsis variants now, display preferred valid variants with per-field original fallback, and preserve moderation/version/stale-source guarantees. Do not require authors to translate manually. Curated demo variants are allowed; automatic translation waits for a future provider integration and is not simulated. No full adventure/NPC automatic translation is in this milestone.
