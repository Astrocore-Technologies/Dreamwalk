# Ordinary generation for the open alpha

`GENERATION_MODE=release` is a separate admission mode, not an enabled Live Test.
It uses `GENERATION_CONFIG_JSON` (the strict text/image profile described in
`owner-generation.md`, plus a required positive `aggregateCapMicros`). There is no
owner handle, expiring test session, claim button, or per-user administrator grant.
The real server-only provider key must already be configured. Selecting release
mode is an operator deployment action; this change does not deploy or call a provider.

## Admission and money

- The existing account/session and content/campaign permissions remain required.
- `/generation/status` is read-only. It neither creates an authorization nor funds a wallet.
- The first authorized quote/consent mutation establishes a stable `release:<user UUID>`
  financial scope and a `release` authorization. An unavailable/disabled wallet fails
  closed. No existing account is silently funded or enabled.
- New-registration starter Sparks are handled by the registration transaction, not
  generation. Duplicate quotes/operations cannot create a second debit.
- Each concrete request has a pricing/profile snapshot and an atomic Sparks reserve.
  Successful verified results settle through the existing accounting layer. Unknown
  outcomes retain their own hold and are not retried automatically.
- Actor scopes isolate concurrent users and failures. An unresolved request is not a
  global Live Test stop. A genuine aggregate financial ceiling can still reject new
  requests; it is not the historical USD 1 test allowance.
- `aggregateCapMicros` is explicit operator exposure authorization. All held/settled
  generation reservations, including historical legacy reservations, plus unlinked
  legacy NPC provider liabilities count under the shared admission lock; uniquely
  linked receipts are not counted twice. Per-account scope ceilings and wallet availability are also
  enforced. None of these values are inferred from the API key or a client request.
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
per-actor ceilings and the aggregate exposure ceiling. Apply the additive database
migration, deploy the API and web builds together, verify status and registration,
and only then have the authorized user request real generation. Keep credentials
out of logs, repository files, test fixtures, and frontend variables.
