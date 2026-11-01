# Sparks and provider-accounting lock order

Scope: combined migrations 001–043 and the existing owner, bounded-authoring, manual-permit and direct-NPC paths. These are preventive integration fixes, not evidence of a live deadlock. The historical 043 hold predates Sparks and has no Spark quote. No wallet is activated/funded and no provider request is made by this work.

## Financial partial order

Within one transaction, retain the path-specific source/ACL/campaign/request/job prerequisites described below; do not move image jobs ahead of their authorization/scope locks. Not every operation touches every financial node:

```text
NPC provider-budget row(s), sorted by provider_id when batching
  → target authorization row(s); existing multirow helpers order by id
  → target shared provider scope
  → global generation-scope-admission advisory fence
  → Spark wallet(s), sorted by owner when there are multiple
  → Spark hold
  → append-only Spark ledger entries
```

The directed financial edges are `P → A → S → F → Ws → H`, `P → F` for direct admission, and `Wd → P` for legacy demo enqueue; admin demo adjustment is `operation-id lock → Wd`. Here `P` is provider-budget row(s), `A` authorization, `S` shared scope, `F` the global fence, `Ws` Spark wallet, `H` Spark hold, and `Wd` the **different** legacy demo wallet. A quote-only transaction can begin at `Ws` but terminates without reaching `P`, `A`, `S` or `F`. No produced-job path has `Ws → P` or `F → P`; wrapped settlement/reconcile take `P` first, and sweep prelocks all `P` rows. There is no `P → Wd` edge in normal terminal processing: demo capture occurs only after provider settlement, in its own semantic-finalization transaction. This distinction rules out treating `Wd → P` and `P → Ws` as a wallet cycle.

`GenerationAuthority.lockAuthorization` and image `lockBudget` sort the existing authorization rows of their one target scope by ID; single-authorization paths simply lock their target. This is not a claim that arbitrary cross-scope batch authorization prelocking is implemented.

A direct-NPC path without a shared permit omits authorization/shared scope. A shared authoring/image path omits the NPC provider budget. Quote-only Spark transactions may take the wallet alone: they must not subsequently acquire a provider budget, authorization, scope or global fence. Pure `SparksAccounting` does not know provider locks; integrations must establish prerequisites before calling it.

**Do not acquire another financial scope/provider row after the global fence.** Read-only cross-scope liability queries are allowed. A batch must prelock its complete sorted provider-budget set before its first callback can acquire the shared fence. Current wrapped NPC permits use the existing fixed owner/manual shared scope; the bounded 043 child is NPC-ineligible. Supporting mixed authorization scopes in a future batch would require prelocking their complete authorization/scope set before the first fence, not adding locks inside the loop.

Source/job prerequisites remain path-specific: NPC terminal callbacks own their NPC job before provider/permit locks; wrapped `begin` also owns the NPC job before authorization. Image callbacks take their authorization/scope before the image-job lock. The new central settlement hook does not acquire an authorization or a foreign scope. It locks only the reservation's own scope, which existing shared financial callers already hold.

## Operation checklist

| Operation                                   | Relevant order and boundary                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary/shared text or image consent       | Existing source locks → authorization/scope → `reserveGenerationSpend` global fence → wallet reservation → job insertion. Provider and Spark reserves commit atomically.                                                                                                                                                           |
| Bounded 043 quote/dispatch                  | Child authorization/scope → `boundedPolicy` global fence → current aggregate/purpose/source/policy checks → optional wallet. Incoming reserve is checked under the same fence.                                                                                                                                                     |
| Direct NPC quote                            | ACL/source checks → wallet quote; no provider reservation or later financial lock in that transaction. Quote is not dispatch permission.                                                                                                                                                                                           |
| Direct NPC enqueue                          | Existing campaign/request/job prerequisites → provider-budget row → legacy-owner exclusion/global fence for external providers → sorted wallet owners → hold/job insertion.                                                                                                                                                        |
| Wrapped NPC enqueue                         | Existing campaign/request/job prerequisites → provider-budget row → global fence/current acknowledged text cap → wallet-mode check. `ownSparkHold` is false: the shared permit is the only paid hold.                                                                                                                              |
| Shared known settlement                     | Authorization/scope prerequisites → `settleGenerationSpend` global fence → reservation actual. Semantic acceptance later captures Sparks; cost accounting does not imply acceptance.                                                                                                                                               |
| Shared failure, stale or late image receipt | Existing target authorization/scope/job prerequisites → `settleReservationSparks` scope/global fence → wallet. A subsequent provider settlement cannot invert wallet/global order. Unknown/failure policy remains pending, not an invented charge/release.                                                                         |
| Direct NPC cache/failure/stale/commit       | NPC job → `settleNpcSparks` provider-budget row → wallet/hold. Later `settleProvider` reuses the already-held provider row. A direct hold on `ManualLiveProvider` is rejected before wallet locking.                                                                                                                               |
| Wrapped NPC settlement                      | NPC job → `settleProvider` provider-budget row → `session.settleJob` authorization/scope/global fence → optional permit wallet. No direct NPC hold.                                                                                                                                                                                |
| Wrapped reconciliation                      | NPC job → provider-budget row **before** the explicit full-cost shared receipt → shared authorization/scope/global fence → provider update. Full actual cost is retained; original event-key replay remains idempotent.                                                                                                            |
| NPC expiration sweep                        | Lock selected jobs; prelock all distinct provider budgets sorted; only then invoke terminal callbacks. Prevents first callback's global fence from preceding a later provider row.                                                                                                                                                 |
| Balance/admin inspection                    | `admin.ts` reads enabled/balance/held without `FOR UPDATE`; no Spark balance mutation endpoint or purchase fulfillment exists. Accounting updates use wallet→hold ordering after integration prerequisites. Migration-created wallets stay disabled/zero. Future funding/admin writers must not lock provider rows after a wallet. |
| Legacy admin demo adjustment                | Existing operation-id idempotency advisory lock → legacy `wallets` row → legacy `ledger`; NPC credit holds are read only. It takes no provider-budget or shared generation-global lock. This is not Spark funding.                                                                                                                 |
| Confirmed operator erasure                  | Existing campaign/job locks with `NOWAIT` → all affected provider rows sorted, also `NOWAIT` → authorization/scopes → existing purge writes. Provider aggregates are no longer first acquired after authorization. Contention preserves fail-fast busy/retry behavior; erasure is not permission to release unknown liability.     |

## Legacy demo wallet is a different lock domain

`wallets` / `ledger` are legacy demo credits, not `spark_wallets` / `spark_ledger`. Disabled-mode enqueue can lock the legacy demo wallet before the provider budget. Its successful semantic finalizer takes only the legacy wallet (provider cost was settled earlier); stale/failure paths take the provider budget without capturing demo credits. Thus these paths do not add a normal provider-budget→legacy-wallet reverse edge. Enabled direct jobs persist `credits=0`; wrapped jobs have no direct Spark hold. Mixed paid-requester/demo-sponsor paths are rejected, and mode is rechecked under the provider-budget/Spark-wallet locks. Do not treat the two wallet tables as one lock vertex or infer that demo funding authorizes paid funding.

Legacy admin balance adjustments, where present, affect the demo wallet only. Production Spark balance inspection is read-only; there is no Spark admin funding/purchase-fulfillment mutation route. Isolated tests directly seed enabled Spark balances solely in newly created disposable databases.

## Independent monetary controls

Sparks is not a replacement for provider caps. The 043 child keeps its receipt-bound child allowance, all prior settled liabilities plus the retained unknown liability, configured lifetime per-kind caps, expiry, immutable policy and private-story binding. Direct external NPC admission calls `excludeLegacyOwnerBypass` under its provider row/global fence and rejects whenever any owner authority exists, active **or stopped**. Enabling a Spark wallet cannot create another provider allowance. Wrapped NPC consent cannot use the bounded child; it must resolve the original authority and cannot bypass its stop.

Unresolved Spark costs stay pending, repeated terminal callbacks cannot capture twice, and application-cache/undispatched zero outcomes release only their own confirmed hold. Demo balances are not converted to paid value. Technical-failure charge policy is not silently changed.

## Isolated opposing-operation tests

`tests/game/bounded-authoring-test.test.cjs` applies actual migrations 001–043 to a fresh local PostgreSQL cluster. Synthetic enabled wallets are explicitly test-only. Barriers inspect `pg_blocking_pids`, with bounded database lock timeouts, rather than inferring ordering from a successful sequential execution:

1. Actual bounded child admission holds scope/global; same-owner synthetic legacy callback waits **before** wallet; child reserves wallet and completes. The late shared receipt scenario rolls back without modifying historical rows.
2. Direct NPC enqueue-side provider row opposes actual `settleNpcSparks` + `settleProvider`; terminal waits before wallet. Pending failure retains liability; success replay captures exactly once.
3. Provider-row holder then requests global fence while actual wrapped `settleProvider` → `GenerationAuthority.settleJob` handles authorized→zero. Terminal cannot hold global while waiting for provider budget.
4. Same opposing pair exercises actual `reconcile` and unknown→known receipt, including event-key replay.
5. While the actual 043 child holds its fence, a competing direct external enqueue/dispatch exclusion gate holds its provider row and waits. Once released, it rejects `GENERATION_AUTHORITY_IMMUTABLE` before reserving anything; the enabled Spark balance does not bypass the authority. Existing owner integration tests additionally cover both directions of the initial owner-activation/direct-provider race.
6. A mixed-provider expiration sweep waits on the second provider row before acquiring global; the competing holder can acquire global and finish.
7. The real operator-erasure lock helper, opposed by a provider-row holder, returns PostgreSQL lock-not-available before acquiring authorization/scope. The receipt-side holder can then lock authorization/global and finish; erasure locking succeeds after it releases.

The existing fixture also checks original-row preservation, inherited purpose caps, concurrent activation replay, simultaneous text/image admission, foreign late actual cost, expiry and next-unknown stopping. Focused Sparks dispatch/accounting/NPC tests and owner-generation integration tests retain their independent coverage. These tests use injected/synthetic data and no external provider transport.
