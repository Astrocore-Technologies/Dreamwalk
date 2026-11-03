# Dreams and Sparks

New verified accounts receive **50 Dreams once**, replacing the future 50-Sparks registration gift. No daily grant and no existing-account Dreams backfill. Password accounts grant on verification (or immediate registration when verification is explicitly disabled); verified Google accounts grant on creation. Previously eligible unverified legacy accounts keep their existing Sparks eligibility. Every existing Sparks balance, held amount, quote and ledger entry remains unchanged by migration.

Both currencies pay for the same operations at the same immutable quoted tariff: currently 2 units per API cent. Each unit has 10,000 integer subunits; JSON uses canonical decimal strings. Dreams are used first, then Sparks. This is allocation, not conversion or transfer. Existing provider caps, consent, authorization, request identity, retries, and unknown-outcome protections still apply. Built-in free simulations remain free.

Migration 054 adds independent Dreams wallets, quotes, holds and append-only ledger, plus optional allocation bindings on Sparks holds. New quotes bind `dreams-first-v1`; old in-flight quotes lacking this policy remain Sparks-only. The compatibility Sparks quote/hold reserve field continues to describe the TOTAL ceiling in common pricing units. Its new `sparks_reserved_subunits` is the exact paid-currency portion; its linked Dreams hold is the free-currency portion. Existing Sparks ledger entries keep their old meaning, and new entries record ONLY the Sparks portion. Dreams movements appear ONLY in the Dreams ledger.

At quote time, `funding` marks the current split as an estimate and explicitly supplies the maximum possible Sparks portion (the total quoted cap). This avoids promising the same free balance to multiple outstanding child quotes. Wallet locks serialize admission: the exact Dreams-first split is fixed once at reservation, with both holds committed atomically. Held `funding` and receipts show exact amounts. At settlement, actual usage consumes held Dreams first, then Sparks; unused hold amounts return to their original currencies. Duplicate receipts cannot debit twice, changed receipts conflict, and unknown/failure-policy/overrun outcomes keep both holds pending until explicit reconciliation. No automatic late success clears pending liability.

`GET /api/v1/currencies/wallet` returns independent `sparks` and `dreams` DTOs. Existing `/sparks/wallet` is unchanged. No public wallet-funding or transfer endpoint is introduced. Every user's wallet and ledger is authenticated and owner-scoped. Account exports include Dreams records; historical accounting evidence is retained consistently with Sparks.

`funding` fields: `policyVersion`, `allocation` (`estimate` or `reserved`), `dreamsReservedSubunits`, `sparksReservedSubunits`, `totalReservedSubunits`, `maxSparksSubunits`, optional `dreamsCapturedSubunits` and `sparksCapturedSubunits`. No aggregate UI balance combines the currencies. Batch estimates conservatively avoid counting the same free balance twice.

Verification uses disposable local PostgreSQL and mocked providers only. Dedicated tests cover grant idempotency, no backfill, free-only text, mixed image spending, legacy quotes, exact partial capture/refund, unknown outcomes, competing reservations, overrun, authorization and immutable accounting. Production migration/deployment and real provider calls are separate authorized operations.

## Local verification

- Workspace typecheck, lint and shared/core unit suites passed.
- Home/dual-wallet PostgreSQL + HTTP suite: 18 passed.
- Full isolated image/generation suite: 367 passed; added Dreams-only release-authority case also passed (9-case targeted suite).
- Google, verification mail, signup/admin and NPC accounting regression suites passed.
- Full platform suite: 80 passed, one unrelated pre-existing redesign locale-audit failure from two raw `Dreamwalk` JSX literals in `shell.tsx`; frontend owner is handling that in the combined PR.
- Browser tests updated for the new grant but not executed in this backend worktree.
