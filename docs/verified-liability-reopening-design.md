# Verified liability reopening: report-only design

This slice does not reopen authorization, unblock scopes, retry a provider or change canon.
It also does not automatically capture historical pending image holds without explicit
native `known-cost-v1` policy authority. No old quote or job is backfilled.

## New image admission authority

A client that displays the automatic known-cost settlement terms may explicitly request
`automaticKnownCostPolicy: "known-cost-v1"` in its native image quote input. This field is
part of the native request hash, copied unchanged to the admitted job. The immutable
Sparks quote also records `providerQuote.automaticKnownCostPolicy` and its bound hash.

The quote response exposes `automaticKnownCostSettlement`: version, native quote ID,
request hash, original reserve in micros, risk basis, known-failure capture/remainder
release rule, unknown/overrun retention, no automatic retry, and the policy fingerprint.
The existing single confirmation POST supplies `automaticKnownCostPolicyHash` with
`consent: true` and the existing estimate-risk consent. The server compares the exact
fingerprint before it creates the unique native job. No second button or subsequent
player reconciliation is needed for these expressly admitted requests. Missing or
changed policy acceptance is rejected. Read-only replay creates no new authority.

The API never injects this opt-in for legacy clients or internal batches. Existing
unmarked quotes and jobs retain their previous rules. New external travel quotes include the same policy in immutable media entries. The
combined quote exposes a hash of all exact text and media entries; the existing single
combined consent POST must accept it. Native image admission derives its policy hash
only after reproving that accepted batch, rather than injecting user consent. Older
accepted travel batches remain unmarked and keep their previous authority. Client
disclosure/localization and these backend changes must ship together after review.

## Known image completion

All mutation paths and the bounded rotating recovery worker require the explicit policy
marker in both the native request and immutable Sparks snapshot. They prove the native
quote/job/attempt identity, signed historical request/pricing snapshots, original reserve,
verified cost, authorization ownership and scope, reservation and wallet bindings, and
both sides of any Dreams-first split. Receipt identity stays `image:<jobId>` to preserve
successful-image idempotency. A missing, altered, erased, unverified or over-budget proof
retains the hold; a number alone is not billing authority. Generic Sparks hooks are not
relaxed. No provider billing is inferred from HTTP rejection or silence.

## Proposed future reopening admission

A future helper should acquire no new foreign scope or authorization locks. Caller must
lock all authorizations for the target scope in ID order, then scope, then the shared
admission fence, before any source/wallet locks. A concurrent admission, settlement or
policy amendment must not invalidate the checked snapshot before any update commits.

Only exact uncertainty stops `IMAGE_RESULT_UNKNOWN` and `PROVIDER_OUTCOME_UNKNOWN` are
candidates. Preserve every other stop, including explicit administrator/user stops,
security/model-access denials, policy/configuration changes, expired authorizations,
provider deadlines, erasure, overrun and revoked source access. A recoverable stop does
not itself prove why the scope is blocked: the current boolean has no reason history.
The all-liabilities proof below is mandatory, and financial review must decide whether
additional durable block provenance is necessary before automatic reopening is safe.

Report a stable source-specific blocker rather than mutate when any condition fails:

- All authorizations sharing the scope have matching ownership, valid current policy
  revision/configuration, and permitted states. A retained migrated manual row stopped
  for `OWNER_GENERATION_MODE_ACTIVE` may be inert; no other stop is silently removed.
- Every reservation is terminal. Settled values are present, nonnegative, within the
  original reserve and matching their exact source receipt. Released reservations have
  proof of no dispatch or exact verified zero, not merely an empty actual column.
  Scope totals and purpose totals remain within bounded caps; unlimited authorization
  must have the exact existing unlimited-policy shape, not be inferred from nulls.
- Every text permit is terminal and has a matching reservation and provider job; every
  count request is completed with trusted exact-cost evidence or a proven no-dispatch
  release. Unknown, dispatched or orphaned counts block reopening, including legacy
  counts outside the scope that still contribute to shared safety checks.
- Every external NPC job is terminal and its permit, shared reservation, provider budget
  state and actual cost agree. Legacy provider ledgers must reconcile to their full
  associated jobs without reserved/unknown/overrun exposure or unexplained blocked state.
  A closed job alone does not discharge provider liability.
- Every external image job and attempt is terminal or explicitly recovered through its
  established secure recovery receipt. Known generated but unadmitted jobs remain live
  work and block reopening. HTTP 403/model access failures require the separately
  authorized secure recovery proof, including restored access; never infer free cost.
- Every authoring job is terminal and bound to its source reservation and verified receipt.
  Completed/stale application state alone is not provider settlement evidence.
- Every required Sparks hold and linked Dreams hold is terminal with matching owners,
  source IDs, historical rate/policy, capture amounts, deterministic receipt fingerprints
  and exact split. Missing required holds, orphaned pending holds, mismatched receipts,
  ledger totals or wallet held totals block reopening.

Even after financial review approves an implementation, reopening must atomically update
only the specifically recoverable uncertainty stop and that same scope's block, with an
idempotent audit describing the evidence snapshot. It cannot change caps, policy,
consents, source/canon, historical billing receipts, or enqueue/generate anything.
Normal authorization checks still gate the next separately requested generation.

## Verification boundary

Focused source-transpiled proof tests cover known-cost and policy admission guards,
historical rates, duplicate receipts, split funding, source mismatches and fail-closed
transaction behavior. PostgreSQL concurrency/restart verification, full API typecheck,
client disclosure and exact-head aggregate checks remain coordinated release gates.
No production data or providers are used by this slice.
