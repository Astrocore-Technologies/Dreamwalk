# Platform verification

- `npm run test:integration` creates a new **real PostgreSQL 17** local cluster, builds contracts/API, applies migrations, seeds fixtures, verifies migration/seed rerun idempotency, runs the live Nest API and config suites, then stops API and PostgreSQL. No Docker or provider key is needed. It refuses non-loopback test services. Test data lives in ignored `.local/test-*`; it is not production data.
- `node --test tests/platform-config.test.mjs` checks mock defaults and startup rejection of paid/Discord/non-mock and unsafe production configuration without connecting a database.
- `npm run test:e2e` is the Playwright source suite for a normal development/CI environment with the app running and the browser installed. Tests cover registration/onboarding, profile/settings persistence, author NPC/adventure flow, interrupted confirmation, role-denied UI and mobile navigation. Managed Sites environments use the provided CUA browser for actual UI execution instead of installing or launching another browser.
- `.github/workflows/platform.yml` uses a disposable PostgreSQL service, performs typecheck/lint/build, live API checks and browser checks without any paid keys.

## Live API coverage

Anonymous/private/admin boundaries; secure sessions and cross-origin rejection; profile/settings and all three persisted language preferences; password/session lifecycle; separate hero/NPC ownership; raster reencoding and private asset ACL; SVG rejection; hidden drafts, publication validation, duplicate drafts, moderation and immutable published versions; secret NPC exclusion; private/public visibility, invitation acceptance/decline/revocation, private asset ACL and no-store responses; audited local administrator bootstrap; favorites and reports; integer demo ledger idempotency, mismatched replay, concurrent debit and append-only database triggers; model version edits, quarantine; external endpoint/live-runtime rejection; honest unavailable email recovery and confirmed account deletion.

An authored test is not a passed test. See `docs/progress.md` for the actual executed commands and remaining verification limitations. Game runtime, WebSocket co-op, real AI, payments, email delivery and production backup/restore are outside this platform-only test suite.
