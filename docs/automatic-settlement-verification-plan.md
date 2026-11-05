# Source-specific settlement verification gates

Source integration combines image settlement, native/visual-authoring UI policy
acceptance, combined travel consent, and NPC/count/permit accounting. This is not a
release approval. No production data or provider request is needed for the gates below.

## Required policy boundary

- Historical unmarked quotes, pending holds and jobs remain unchanged. No backfill.
- A newly stamped immutable quote is not by itself user acceptance. For every new
  client path, the existing single confirmation must explicitly accept the quoted
  policy, and native durable proof must bind that acceptance. Old clients omitting
  the new field must not gain automatic settlement authority.
- The previously established finite `end-turn-v1` ordinary-turn allowance is a
  separate proof path, with its existing no-image and no-extra-risk constraints.
- Marked travel native admission and later text/image accounting must reprove the
  accepted aggregate's exact text and media entries, not only their own child.
- No generic pending-hold override, automatic provider retry or scope reopening.

## Narrow synthetic checks

Run the existing source-backed image, travel and location proof suites, new text
proof suite, native enqueue consent tests, and the native/combined UI handler tests
on the final integrated head. Add or preserve cases for:

1. Missing/unknown policy and explicit acceptance, including an old client asking
   for a new quote, create no automatic capture authority.
2. Different quote ID, operation, request, reserve, model/rate, owner/scope, attempt,
   provider request or receipt rejects settlement without writes.
3. Changed/missing aggregate hash, changed sibling media/text entry or omitted
   native policy rejects compound proof; an old accepted unmarked batch stays old.
4. Repeated click, unknown HTTP outcome and page reload preserve the original
   operation and exact accepted payload. No second confirmation action appears.
5. A known accepted receipt captures at its immutable rate and releases the exact
   remainder, including zero and Dreams-first splits. Inconsistent proof stays held.
6. Terminal receipt compatibility remains idempotent. Missing/malformed evidence,
   unknown receipt, unpriced usage, erasure and overrun remain non-mutating.

## Isolated PostgreSQL acceptance

Use only synthetic fixtures and local stub providers after the coordinated build:

1. Snapshot every table/ledger for representative historical unmarked pending
   image/NPC/permit/count holds, run startup recovery, and assert no capture or
   retroactive marker/consent writes. Include the six known historical-case shapes
   identified by the owner-side inventory without copying production content.
2. Admit a policy-marked native image through the explicit existing consent; exercise
   generated cancellation, known late result and admission rejection. Each should
   capture exact verified cost once and release the remainder atomically.
3. Race result delivery, cancellation/admission rejection and two recovery workers.
   Restart between phases. Assert one capture/release event per hold, consistent
   wallet held/balance totals, and matching immutable final fingerprints.
4. Fault after the Dreams update and before the Sparks update. Transaction rollback
   must restore both wallets/holds; replay then terminalizes both exactly once.
5. Mark an image receipt unverified, omit actual cost, alter a binding, or exceed the
   accepted reserve. Assert retained liability, no fabricated charge/zero, no retry.
6. Confirm one fixed combined text+image travel quote and admit children later after
   native quote expiry. Original acceptance within expiry remains authoritative;
   changed aggregate/child policy fails before dispatch or reservation mutation.
7. Exercise new explicit NPC/count/permit policy acceptance and old-client omission
   against the same fresh quote. Only the accepted policy path may automatically
   settle failed/stale verified usage; all prior consent constraints remain active.
8. Keep an unrelated unknown/security/policy/deadline/overrun liability alongside a
   completed known receipt. No authorization is reactivated and no scope unblocked.

## Aggregate and browser gates

Build contracts/API and typecheck the integrated web/API once, then run registered
aggregate tests and localized browser flows. Check native image, visual-authoring,
combined travel and legacy/reloaded quote screens in RU/EN/UK. The disclosed rule
must match the accepted payload: verified actual cost within the quoted reserve is
settled automatically after failure/cancellation, remainder released, unknown or
overrun retained, no retry authorization. Pending is not displayed as completed debit.

Automatic scope reopening remains a separately reviewed design because existing
blocked state lacks durable exact cause provenance. None of these checks claims that
problem is solved. Record skipped/blocked checks distinctly from passing checks.
