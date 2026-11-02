# Ordinary generation for the open alpha

`GENERATION_MODE=release` is a separate admission mode, not an enabled Live Test.
It uses `GENERATION_CONFIG_JSON` (the strict text/image profile described in
`owner-generation.md`, plus either explicit finite ceilings or `allowance: "unlimited"`). There is no
owner handle, expiring test session, claim button, or per-user administrator grant.
The real server-only provider key must already be configured. Selecting release
mode is an operator deployment action; this change does not deploy or call a provider.

## Admission and money

- The existing account/session and content/campaign permissions remain required.
- `/generation/status` is read-only. It neither creates an authorization nor funds a wallet.
- The first authorized quote/consent mutation establishes a stable `release:<user UUID>`
  financial scope and a `release` authorization. An unavailable/disabled wallet fails
  closed. No existing account is silently funded or enabled.
- Starter Sparks are handled by registration or verified-email completion, not
  generation. Duplicate quotes/operations cannot create a second debit.
- Each concrete request has a pricing/profile snapshot and an atomic Sparks reserve.
  Successful verified results settle through the existing accounting layer. Unknown
  outcomes retain their own hold and are not retried automatically.
- Actor scopes isolate concurrent users and failures. An unresolved request is not a
  global Live Test stop. A genuine aggregate financial ceiling can still reject new
  requests; it is not the historical USD 1 test allowance.
- With `allowance: "unlimited"`, omit all four `*CapMicros` properties. No cumulative
  per-user or aggregate operator ceiling applies. Database caps are NULL behind an explicit
  release-only allowance flag; no large-number sentinel, automatic funding or wallet bypass.
  Remaining amounts in the UI are the user's actual available Sparks, not a fabricated quota.
  Finite per-request token/output limits, quoted reserves, locks and idempotence still apply.
- An optional bounded release profile instead supplies `totalCapMicros`, `textCapMicros`,
  `imageCapMicros` and `aggregateCapMicros`. Its aggregate includes held/settled shared
  reservations plus unlinked legacy NPC liabilities, without double counting linked receipts.
- Profiles do not create a new financial scope or erase past spending. A changed
  persisted profile fails closed rather than silently reset an account's authorization;
  operator-reviewed profile migration is required for existing release authorizations.

## Compatibility

Legacy `manual`/`owner` authorizations and financial records remain intact for audit
and recovery. The release NPC worker does not reinterpret or automatically sweep jobs
from a different historical provider; their liabilities remain visible to aggregate
admission and require the appropriate explicit recovery procedure. The release front door does not expose their claim/policy controls.
`LIVE_TEST_ENABLED` is not enabled as part of release setup. Existing test transports
and fixtures remain synthetic. No payment checkout, automatic recharge, invitation
restriction, CAPTCHA, or antifarming system is introduced here.

## Before enabling in production

Review actual model pricing, current provider capability/credentials, profile expiry,
the chosen allowance mode (the requested deployment uses unlimited operator allowance). Apply the additive database
migration, deploy the API and web builds together, verify status and registration,
and only then have the authorized user request real generation. Keep credentials
out of logs, repository files, test fixtures, and frontend variables.

## Standard text cache pricing

An optional `text.cachePricing` freezes `cachedInputMicrosPerMillion`,
`cacheWrite30mMicrosPerMillion` and `cacheWrite12hMicrosPerMillion` alongside the existing
pricing evidence. Both text adapters then explicitly request implicit caching with a 30m
TTL and Standard/default service tier. Returned mixed-TTL details are validated and priced
by their own total rates; a total-only write count uses the explicit 30m request policy.
Input, cache reads and writes are disjoint, and the combined amount is rounded up once.
Quotes reserve using the largest reviewed input category. All rates are included in immutable
request/profile fingerprints; cache usage cannot be made chargeable with a provider-supplied
boolean alone. Legacy profiles with no cache tariff remain unverified on cached results.

On 2026-11-02 the official [Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna)
and [pricing table](https://developers.openai.com/api/docs/pricing) list Standard short-context
USD/1M rates 0.10 input, 0.50 output, 0.01 cached read, 0.125 30m write and 0.25 12h write.
These are not valid assumptions for long-context premiums, other service tiers or regional
endpoints. The activation profile must stay within its reviewed applicability and validity.
The [cache guide](https://developers.openai.com/api/docs/guides/prompt-caching) documents the
30m default and response write categories. No provider call is needed to validate this code.
