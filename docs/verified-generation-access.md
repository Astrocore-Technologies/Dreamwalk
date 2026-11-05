# Future verified generation access recovery

This layer restores an existing gate only after the native billing evidence is verified.
It never dispatches, retries, admits a late result, increases a cap, changes policy or
consent, captures an old hold, or rewrites a provider receipt. Financial settlement is
still performed exclusively by the existing source-specific settlement services.

## Durable origin, not a blocked boolean

Migration 064 adds nullable epoch pointers to authorization, shared-scope and legacy
provider gates. It inserts no history and does not backfill any existing row. An immutable
epoch records whether the gate was already blocked/stopped before its first observed
assignment. A historically true gate plus a new recoverable event stays baseline-unknown.
A newly inserted stopped gate is also baseline-unknown. Neither can reopen automatically.

Every assignment to blocked/state/stop code, including true-to-true, appends a durable
event. Unannotated assignments are authorization-level vetoes. Direct pointer assignments
cannot replace an existing epoch. Epochs and events are append-only. A separate unique
recovery receipt binds the exact scope and authorization epochs and financial fingerprint.
The only existing explicit model-rejection clear path rejects new durable epochs rather
than silently erase their later vetoes. Old null-epoch explicit recovery is unchanged.

Each event records exact native source ID, authorization, scope, policy revision/hash,
configuration hash, original cause, canonical reason and request/authorization class.
Security, source access, erasure, overrun, operator/user stop-all, policy and authorization
expiry remain vetoes. A manual grant superseded by owner mode is inert only if its later
history contains nothing except that migration policy cause.

## Request timeout is not authorization expiry

Canonical request reasons are IMAGE_RESULT_UNKNOWN, PROVIDER_OUTCOME_UNKNOWN,
TEXT_COUNT_OUTCOME_UNKNOWN, REQUEST_TIMEOUT, REQUEST_DEADLINE_EXCEEDED and
JOB_CANCELLED_UNKNOWN. Only server callsites with an exact native job/count/permit and
original authorization can mark these request-scoped. The raw cause is retained.

A deadline/timeout/cancellation of one request may recover after its exact liability is
terminal, but its original work must remain discarded: stale/failed/cancelled/rejected
(or exact financially resolved unknown count without installing its tokens). It cannot
be admitted/committed as a late result. Image late timeout/cancel receipts are settled
and discarded using immutable source events. Authorization expiry and ambiguous deadline
origins are not reclassified as request deadlines. A later cause is appended even if the
source was already unknown, so a known late receipt cannot erase a stop-all/security veto.

## Stop-writer inventory

- Image service: missing cost, explicit transport/result uncertainty, per-job deadline,
  cancel-in-flight and provider HTTP/access failure. Exact image job, original reservation
  and owner/release authorization. HTTP/credential/unattributed failures remain vetoes.
- Generation count completion: exact count ID and authorization. Count credential/HTTP/
  schema errors retain their distinct causes instead of becoming unknown transport.
- Generation permit completion and NPC callbacks: exact permit ID plus native job cause.
  Every repeated unknown callback appends any later request expiry/cancellation/security
  cause. Count/permit terminal financial proof does not apply stale gameplay/token data.
- Authoring/shared settlement: reservation is resolved to exactly one native source;
  ambiguous source stays an unclassified nonrecoverable reservation stop.
- NPC direct-release account stops: exact NPC job and authorization. Native provider
  timeout/cancel is distinguished from cost overrun. Legacy provider budget overrun and
  limit-violation writers record exact NPC/provider provenance and remain vetoes; this
  layer never clears those provider gates.
- Shared reservation overrun or late charge after release: exact reservation/scope veto.
- Owner-policy takeover of a manual grant: exact old authorization/policy event, never
  treated as uncertainty. All other SQL writers, including scripts/admin/security, are
  caught by the database trigger as unattributed vetoes until explicitly supported.

## All-liabilities proof and retained funds

Existing native image, count, permit, NPC and authoring proof functions are reused in
explicit proof-only mode. Their mutation defaults and automatic-settlement opt-in rules
are unchanged. The proof checks exact source/reservation/authorization ownership, original
request and pricing snapshots, actual-versus-reserve bounds, deterministic receipts, both
Sparks and Dreams splits, terminal ledgers and wallet totals. Legacy provider budgets
must reconcile to their jobs; orphaned/unknown/overrun exposure or unexplained blocks veto.
Generated-but-unadmitted work is not terminal. Missing bindings never become zero cost.

A historically known, fully funded pending hold may remain unchanged alongside recovery
of a different new request. This is encumbered known liability, not permission to debit.
It needs exact native cost proof and original reserve coverage on both funding sides,
matched pending ledgers/wallets and full cap exposure. It must not be the source of any
stop being cleared. Unknown/unpriced/orphaned holds are never accepted in this class.

## Serialization and bounded work

A separate 30-second worker scans at most 25 blocked scopes with a rotating cursor.
Each transaction locks all target authorizations in ID order, then the target scope,
then the shared admission fence, and rechecks the authorization set. No foreign
scope/authorization lock is acquired. Source/access rows use FOR SHARE NOWAIT and own
wallets use FOR UPDATE NOWAIT, avoiding inversions with NPC callbacks and erasure flows.
Contention rolls back and is retried by the rotating worker, never by provider dispatch.

Every proof read is bounded to 501 rows and 4,000 total records; exceeding the proof
budget yields PROOF_SIZE_LIMIT, not an incomplete proof. Stop history is similarly
bounded. Lock timeout is 100ms and statement timeout 2s. Larger histories remain blocked
pending an aggregate-proof implementation; this is an explicit availability limitation,
not evidence of unknown billing or permission to repair historical records.

Recovery atomically inserts its unique receipt, clears only its clean owned scope and
authorization epochs and appends one audit. Transaction failure rolls everything back.
Current source access, policy/configuration, pricing freshness, authority and exact cap
shape must still match. The next separately requested generation runs all normal gates.

## Verification boundary

Only synthetic providers and disposable local PostgreSQL are used. No production SQL,
provider transport, paid requests, deployment or user data changes are part of this work.
Exact-head test results are recorded in the handoff; this document does not assert that
an unrun full platform/web/browser suite passed.
