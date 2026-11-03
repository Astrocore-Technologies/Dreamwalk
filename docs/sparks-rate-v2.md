# Generation debit rate v2

New generation quotes use two Sparks per USD cent of provider cost. One Spark remains
10,000 subunits; the purchase pack remains USD 5 for 200 Sparks. No balances, starter
credits, existing ledger entries or provider USD prices/limits are converted.

The immutable Spark quote tariff stores `sparkRateVersion`. Its hold references that
quote, and settlement reads this persisted version rather than the current default.
Version 1 quotes/holds retain one Spark per cent, including late receipts and explicit
reconciliation. Missing or unknown rate versions fail closed; operators must investigate
rather than guessing or rewriting immutable quotes. Existing overrun handling leaves a
hold pending instead of capturing more than its authorized reserve. Replay remains
idempotent.

Provider component costs, including priced cache reads/writes, are summed and rounded
up to provider micros once. Debit conversion then multiplies by the bound rate. Quote
and hold displays read stored subunits; aggregate quotes sum child wallet amounts, not
provider micros. USD budget checks continue using unconverted provider micros.

## Rollout

No database migration or wallet adjustment is required. Deploy API and web together
through the normal separately authorized release process. Existing wallet denomination
metadata is historical storage identity, not the current generation debit rate. Do not
backfill, reprice, recreate or capture old operations as part of rollout. The accounting
primitive still understands version 1 so old in-flight work can finish at its quoted rate.
No production deployment or provider call is performed by this change.

## Verification

- Full workspace typecheck, ESLint, changed-file formatting and diff checks passed.
- `npm run test:unit`: 284 tests passed across contracts, core and platform suites.
- `npm run test:game`: 205 core and 221 game/UI tests passed.
- Disposable PostgreSQL accounting: 8 tests passed, including legacy/current rates,
  immutable records, concurrency, missing/future quote versions and idempotency.
- Disposable PostgreSQL dispatch: 10 tests passed individually, covering authoring,
  paid token counting, gameplay text and image charging. Two combined attempts hit a
  database shutdown connection error after all assertions passed; the isolated run
  passed cleanly. This is recorded rather than counted as a clean combined run.
- NPC/aggregate tests and bound-rate UI regressions passed; independent safety review
  found and then verified fixes for aggregate reserve totals and legacy UI estimates.
- No live provider, production database or production browser test was used.
