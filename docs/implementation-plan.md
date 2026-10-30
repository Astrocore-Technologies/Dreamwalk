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
| G0    | Deterministic mock scene, two players, shared item, reconnect/repeat safety                                                                                  | Not in current implementation                     |
| G1    | Short original adventure, real AI with validation, memory and cost controls                                                                                  | Requires explicit paid-call authorization         |
| G2    | Image job lifecycle, scoped asset reuse, reservations/quotes/recovery                                                                                        | Requires explicit paid-generation authorization   |
| G3    | Discord Activity/OAuth, invitations and 1–4 players, real embedded smoke test                                                                                | No private chat scraping                          |
| L0    | Eligibility, payment verification/refunds, legal/age policy, backups, monitoring                                                                             | Explicit launch/payment authorization required    |

No transition to G0 before platform acceptance or a new explicit owner priority. No external publication is implied by local implementation.

## Later owner update: publication and sharing

Exactly two publication choices: private (author plus accepted invitees) and public (visible only after moderation). The original unlisted mode is removed, including link-only access. Implement persisted invitations, acceptance/decline and revoke, read-only recipient library/detail, and corresponding asset/metadata ACL tests. Public approved versions remain immutable and visible during re-review. This update must be complete before final P4 verification.

## Later owner update: write once, localized metadata

Store source language and optional title/synopsis variants now, display preferred valid variants with per-field original fallback, and preserve moderation/version/stale-source guarantees. Do not require authors to translate manually. Curated demo variants are allowed; automatic translation waits for a future provider integration and is not simulated. No full adventure/NPC automatic translation is in this milestone.
