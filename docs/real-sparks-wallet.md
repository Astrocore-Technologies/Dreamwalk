# One visible Sparks balance

The header and wallet page read `/sparks/wallet`. The single balance card displays available
subunits with the same formatting, loading/unavailable behavior and mutation/focus refresh.
The old demo wallet is not displayed, converted, credited or debited by the admin interface.
`/wallet` remains a legacy API for old synthetic adapters; it is not the spendable Sparks source.

`POST /admin/credits` now accepts whole Sparks (`amount`), converts exactly with BigInt at
10,000 subunits per Spark and returns the actual Sparks wallet. It requires the existing
administrator authorization. Each explicit adjustment writes an immutable `admin_credit` or
`admin_debit` entry and an audit record in the same locked transaction. An idempotency key is
bound to actor, recipient, signed amount and reason. Debits cannot consume held funds.
New or previously disabled wallets are enabled only on an explicit successful adjustment;
this enables accounting, not providers, paid APIs, payment processing or budget-policy bypasses.
Retries do not restore spent balances or change activation. A recipient waiting for their
verification-only welcome gift must verify first, so an early adjustment cannot break verification. Migration 049 grants nothing and
converts no legacy balances. Existing demo grants will not appear as actual Sparks.

The duplicate AI accounting card, explanatory magic card, demo badge and three lower balance
lines are removed. Both NPC editors hide the playable-profile and model-preference controls,
but keep existing values in edit/save payloads. Their internal NPC behavior remains unchanged.

Verification: local real PostgreSQL platform integration, unit/source UI regressions, typecheck,
lint and production build; browser retry/refresh and hidden-profile preservation tests are
included for CI. No production accounts, grants or provider requests are made by these tests.
