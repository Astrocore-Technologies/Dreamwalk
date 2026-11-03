# Automatic release profile updates

The validated server configuration is the source of truth for new release generation quotes.
Changing models, output envelopes or pricing no longer requires an administrator to approve
that profile separately for every player. The former account-level review UI and endpoints
have been removed. A configuration update does not start generation or charge a customer.

## Admission and immutable history

Release admission refreshes the existing account authorization under its authorization,
financial scope, global admission fence and enabled wallet locks. It appends an immutable
profile revision rather than rewriting historical quote, job, reservation or ledger evidence.
A legacy revision without a saved profile remains unknown; it is not reconstructed from the
new configuration. New quotes use the current validated profile and its revision.

The ordinary account, wallet, pricing validity and financial admission checks still apply.
This is not a way to enable a disabled wallet, restore a stopped account, expand account
spending authorization, clear an unresolved provider outcome or create a fresh financial scope.
No new aggregate spending limit is introduced. Existing unlimited configuration stays unlimited.

## Price changes and customer consent

A quote is tied to its immutable profile and price. If a server change makes an unexecuted
quote stale, dispatch rejects it before admitting a new paid job. The client offers a fresh
estimate and requires the customer's explicit confirmation again. It never treats the old
confirmation as permission for a different quote or price.

For the story start flow, only explicit HTTP 409 policy, quote-expiration or inactive-deployment rejections clear the
pending-dispatch marker. A lost response, network failure or unknown provider result retains
that marker and exposes read-only status recovery, not an automatic paid retry.

Already dispatched work and existing customer holds retain their original financial snapshots.
A verified successful result may complete against its original admitted revision even after a
profile update. Text results are revalidated against the current bounded proposal schema and
source fence. Image results retain raster/source checks and verify the immutable quote using
the recorded provider attempt rather than the new provider profile. Neither path dispatches
again. Queued work that has not reached the provider remains subject to current dispatch fencing.
Profile refresh itself does not capture, release, cancel or retry any hold or job. Historical
pending holds continue to reserve their funds until their separate reconciliation completes.

## Verification

The focused release-policy PostgreSQL suite uses an isolated local database and synthetic
providers. Browser fixtures intercept generation dispatch, including stale-price rejection;
no test performs a real paid generation request.

`IMAGE_TEST_FILE=integration-release-policy.test.mjs node tests/images/run.mjs`

## Deployment ordering

The existing Railway pre-deploy command, `npm run db:migrate:production`, applies migrations
and registers an immutable ordered candidate tied to the Railway deployment ID. Registration
never changes the active profile. After required API initialization and a successful listener
bind, that runtime may activate only the latest candidate with its exact deployment ID and
fingerprint. Health remains HTTP 503 until activation commits; an activation failure closes
the application. A candidate that fails before startup activation leaves the old healthy
profile active. An obsolete or superseded process cannot register or activate a new profile.

`RAILWAY_DEPLOYMENT_ID` is required for release pre-deploy and runtime startup. Railway supplies
it to both phases; it is an identity, not a sortable timestamp. Non-Railway deployment tooling
must supply an equivalent unique UUID consistently through the two phases. API requests never
activate profiles. Admission reads the latest successful activation under the global financial
fence. A deliberate rollback must be a newly registered deployment, so even a prior fingerprint
receives a new epoch. Repeating registration/activation for the same deployment is idempotent.
After a post-readiness application failure, normal deployment restart can re-use that exact
registered active deployment. Rollback uses the ordinary deployment pipeline, not per-account
approval or changes to customer holds.

Deployment-phase ordering currently relies on the verified Railway API service topology:
one replica with the persistent `/data/assets` volume. Railway prevents multiple active
deployments mounted to that service, including during healthchecked deployments. Read-only
verification on 2026-11-03 found one running replica, one active deployment and no pending
service changes. Before changing this topology, the deployment controller must provide an
ordered activation step; do not register arbitrary profiles from replica startup or activate them from request traffic.

Sources: [Railway volume caveats](https://docs.railway.com/volumes/reference) and
[volume-backed healthchecks](https://docs.railway.com/deployments/healthchecks).

A completed token-count request also keeps its original fixed-cost receipt when a profile
changes or its pricing expires in flight. The count is marked stale and not applied to new
context; its known provider cost is persisted, and pending customer reconciliation stays pending.
