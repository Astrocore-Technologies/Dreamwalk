# Reviewed release policy adoption

Release accounts retain one authorization and one financial scope. A runtime configuration
fingerprint change deliberately prevents new quotes/dispatch until an administrator reviews
and adopts that exact candidate for the selected account. This is not financial reconciliation.

## Administrator workflow

Open **Admin → Users**, find the affected account, and choose **Generation settings**.
Review the current and proposed profile, including the expandable pricing and limit details.
For a legacy account, the old profile and platform ceiling are explicitly unavailable;
review the entire candidate rather than assuming that only a token limit changed.
The new platform ceiling and retained customer holds are shown before confirmation.
Choose **Approve new profile** only after reviewing those settings. This applies to that
account only and is never offered on the player's launch screen.

If acknowledgment is lost, use **Check status**, which only reads the preview. Do not infer
success from a timeout or retry a paid operation. After successful adoption, the player can
request a fresh estimate and separately confirm generation. Existing pending holds still
need their own reconciliation decision.

## API

- `GET /api/v1/generation/release-policy/:actorId`: administrator-only, read-only preview.
  Returns persisted revision/hash, the runtime candidate and fingerprint, blockers, provider
  liabilities, and retained Spark holds. A legacy profile without an immutable snapshot is
  explicitly unavailable, not inferred from the new configuration.
- `POST /api/v1/generation/release-policy/:actorId/revisions`: administrator-only.
  Body: `operationId`, `expectedRevision`, `expectedHash`, `candidateFingerprint`, `consent:true`.
  Exact operation replay returns its original receipt. Changed replay inputs conflict.

Adoption uses the existing release admission lock, authorization and scope locks, and global
admission fence. It checks the candidate fingerprint and persisted revision/hash under locks.
It rejects stopped/blocked/unapproved accounts, disabled wallets, stale pricing, changed
per-account caps or allowance mode, active provider work, and unresolved provider outcomes.
This endpoint does not expand per-account limits or create a replacement financial scope.

The runtime candidate includes the reviewed aggregate ceiling; the endpoint does not edit
that global runtime setting. After a reviewed snapshot exists, a changed aggregate ceiling
is rejected by this narrow adoption endpoint. A legacy authorization has no historical
aggregate snapshot, so its old ceiling cannot be proven unchanged: the administrator must
review the entire proposed runtime profile with that explicit limitation. Historical totals and retained exposure still constrain subsequent
admission, as do available Spark funds.

A historical failed job can have settled provider accounting while its customer Spark hold
remains pending. Adoption may proceed only when that provider evidence is settled/released
and no unresolved execution remains. The hold, wallet balances, quote snapshots, provider
reservation, ledger and job evidence remain unchanged; the reserved funds remain unavailable.
Orphaned/unsettled provider evidence blocks adoption. Reconciliation is a separate action.

Only the session policy identity/revision changes. An immutable candidate snapshot and an
administrator audit record are appended. Existing quote/job policy and request snapshots
are never rewritten. Old quotes cannot dispatch under the new revision. New preparation
requires a fresh exact quote and the player's explicit payment consent; adoption itself
makes no provider request, reserves no funds, and does not retry a failed start.

Local verification uses isolated PostgreSQL and injected synthetic providers only:
`IMAGE_TEST_FILE=integration-release-policy.test.mjs node tests/images/run.mjs`.
