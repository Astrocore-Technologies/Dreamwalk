# Sidebar and starter Sparks — 2026-11-02

## Authorized scope

- Remove only the lower sidebar Create Story shortcut and early-access indicator.
  Studio, Settings, Help and authoring routes remain available.
- Show the authenticated usage wallet's available Sparks in the header, not the
  independent demo wallet. Loading and failure are explicit; failed reads never
  become fictional zeroes. Integer amounts retain the existing Sparks formatter.
- Grant exactly 50 Sparks (500000 subunits) once during a new registration.
  Existing users/wallets are not backfilled or converted. Handle validation and
  signup hints are unchanged.

## Accounting and isolation

Migration 045 adds the immutable `starter_grant` ledger shape with a unique owner
index, fixed amount and deterministic event key. Other ledger kinds still require
an existing hold. User creation, the new wallet and its grant share one transaction.
A duplicate/replayed grant never restores spent funds or re-enables a wallet.

New wallets use `enabled=true` to enforce the existing Sparks quote/reserve checks;
`false` is the old opt-out accounting path, not a spending block. This does not
activate any provider, purchase, consent, generation policy or shared budget.
Existing wallets and all provider controls remain unchanged. Anti-farming is deferred.
The exact built-in no-network mock provider with zero simulated cost and zero credit/
provider policy price remains a free simulation: it does not create a Sparks hold or
require new paid consent. External providers, wrappers, subclasses and nonzero mock
policies receive no such exemption; missing verified pricing remains fail-closed.

The wallet endpoint returns only the authenticated owner's ID. UI checks that owner
before rendering and discards outdated responses after account changes. Successful
API mutations, focus and visible 15-second polling refresh balances, including
asynchronous settlement. Logout removes the balance. Wallet-page ledger and balance
responses are checked before rendering, including canonical bigint bounds.

## Verification

Local workspace typecheck, lint, web production build, focused UI/localization tests,
unit/game suites and real PostgreSQL platform integration were executed. The new
PostgreSQL cases cover concurrent duplicate signup, exactly one grant, rollback and
retry, immutable ledger and refusal to backfill an existing wallet.

Browser cases cover desktop/mobile sidebar and RU/UK/EN balance display, mutation
refresh, polling, error, delayed old-owner response and logout. Local browser execution
is blocked before page creation by Chromium `socket() failed: Operation not permitted`;
browser acceptance must be established by CI, not inferred from authored tests.

No deployment or production database mutation is performed by this change. Migration
045 must be applied through the normal deployment flow before the updated API starts.
