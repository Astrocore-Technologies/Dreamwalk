# Automatic settlement of verified text costs

This change prepares source-specific accounting for failed/stale NPC requests,
fixed-price token counts, and legacy text permits. It does not dispatch a provider,
retry generation, restore game effects, or reopen a stopped generation scope.

## Authority boundary

New Spark quotes carry `providerQuote.automaticKnownCostPolicy = 'known-cost-v1'`
in their immutable price snapshot. This is created at the original quote/admission,
not added later to old rows. The same consent POST must explicitly acknowledge
`automaticKnownCostPolicy`; a marker alone is never acceptance. NPC jobs bind that
acknowledgment in their original request hash. Count and permit quotes retain the
acknowledged request/operation identity in `automaticKnownCostAcceptance`. Missing
acknowledgment, including old clients using a newly issued quote, remains no-auto.
NPC proof also reconstructs the original consent
request hash, native quote linkage and either the original unexpired acceptance or
the finite accepted world-batch entry. Token-count and permit proof joins their
original consent admission to the same reservation, source quote and owner.

Unmarked historical holds are not automatically charged. The only existing
exception is the separately established `end-turn-v1` ordinary-turn allowance:
exact accepted batch, no images, no estimate-risk consent and matching runtime
request. Existing terminal receipts, including old manually settled receipts,
remain terminal and are never rewritten by automatic workers.

## Financial proof

Every eligible cost must match the persisted provider receipt, original pricing,
reservation and historical Spark conversion rate, and remain within the original
reserve. Text receipts are independently recomputed from verified usage. A stale
or late token count uses only its admitted fixed request price. Unknown/missing
usage is not treated as zero. Dreams-first split funding must match the immutable
linked Dreams quote and hold; existing accounting performs the atomic capture and
release. Deterministic receipt keys are source-specific.

The general pending-hold accounting hook remains closed to arbitrary late success.
Only the source-specific proof may reconcile an eligible pending hold.

## Recovery and UI

NPC recovery and text/count recovery run at startup and every 30 seconds, with
25-row pages, independent advancing cursors, overlap prevention and awaited
shutdown. Each mutation rechecks proof under the established lock order. No GET
performs settlement. The NPC settlement page is a read-only status view and polls
without issuing a confirmation or retry POST. Pending cost is not displayed as an
already completed debit.

A known late count may become stale after accounting; its tokens are never adopted
into a changed runtime request. A legacy permit waits for durable verified native
NPC usage; a bare numeric callback is not settlement proof. Unknown/security/
policy/deadline scope stops are not cleared by this change.

## Verification limits

Focused synthetic source-backed tests cover native enqueue metadata, quote and
receipt proof, historical-policy rejection, ownership/request/rate/overrun/funding
mismatches, exact-once accounting and read-only UI. PostgreSQL integration and
browser execution must run on the final integrated candidate before release.
