# Confirmed settlement of a known NPC bill

The owner-only endpoint resolves one existing rejected NPC result whose provider bill is already known. It does not generate, retry, apply a proposal, advance a round, change a provider budget, or turn a historical failure into an accepted game action.

- GET `/api/v1/game/campaigns/:id/ai/jobs/:jobId/settlement` returns the exact hold, immutable provider cost, total capture/release, Dreams-first split and settlement status. It never returns the model's context, proposal, private thoughts or provider credentials.
- POST to the same URL requires `consent: true`, a UUID `operationId`, the exact `holdId`, and decimal-string `expectedActualMicros`, `expectedReservedSubunits`, `expectedCaptureSubunits` copied from the displayed quote. A changed amount or hold is a conflict. Consent is specific to this job and hold, not a future failure-charging policy.
- The current authenticated campaign owner must also own the original hold and be the job's payer/requester. Ordinary members, admins acting for another owner and outsiders cannot settle it.
- Only terminal `stale`/`failed` NPC jobs from the ordinary release path qualify. The provider and shared reservation must both have settled, known cost. The existing hold must be `failure_policy_pending`. Unknown outcomes, unsupported tariffs, unpriced cache use, missing receipts, demo/sponsored/manual paths and overruns fail closed.
- The complete stored usage, including cache reads and mixed-duration cache writes, is checked against the immutable request pricing. That request must match the admitted quote. Current provider settings do not change the historical price.

POST preserves the established lock order: campaign/job prerequisites, provider budget, existing authorization rows in ID order and their shared scope, global admission fence, Spark wallet, hold, and the accounting helper's Dreams-first settlement. It calls `SparksAccounting.settle` with explicit reconciliation. Capture/release remain append-only and atomic with a small audit receipt. No database migration is needed.

Keep the same `operationId` when checking or retrying an uncertain POST. An identical replay returns the settled result without charging again, including after a server restart. A different receipt for an already settled hold conflicts. GET can confirm the current status without making a new financial decision.

The endpoint is a supported recovery mechanism, not an automatic retry loop. Other unresolved liabilities continue to block new generation. Authentication, trusted web ingress, origin checks and `Cache-Control: no-store` are unchanged. A caller must obtain the owner's explicit approval of the displayed capture and release before POST.

Verification: `tests/game/known-npc-settlement.test.cjs` covers eligibility, owner checks, pricing, exact amounts, lock ordering and the real accounting helper with a deterministic transaction double. `tests/game/integration-known-npc-settlement.test.mjs` uses a disposable PostgreSQL database and an injected synthetic provider to check the authenticated HTTP route, concurrent replay, exact capture/refund, original evidence preservation and restart replay. Neither test contacts a paid provider.
