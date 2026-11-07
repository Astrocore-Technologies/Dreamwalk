# Split staging: Vercel web + Railway API

Prepared configuration, not a deployed or publicly approved release. Use a clean,
reviewed commit, never the temporary shared preview directory or its launchers.

## Services and routing

- Vercel: Next.js, Node 22, dashboard project root `apps/web`. Enable access to
  files outside the root directory and use `apps/web/vercel.json` commands:
  `cd ../.. && npm ci` and `cd ../.. && npm run build:web`.
  Dashboard output directory is `.next` (relative to `apps/web`), not
  `apps/web/.next`. Do not statically export this app.
- Railway: repository root (shared contracts/game-core are required), Node 22,
  `infra/railway-service-settings.json` (reviewable settings worksheet, not an auto-applied platform config). One persistent API replica; no scale-to-zero. Game simulation,
  socket subscriptions and image workers have process-local state.
- Supabase PostgreSQL 17 (eu-central-1): the API connects over TLS through the
  **session-mode pooler** (confirmed by the owner on 2026-11-07). Never use a
  transaction-mode pooler: the migration runner holds a session advisory lock. The
  database is not exposed through the Supabase Data API; Nest owns all access. See
  `database-connections.md` for `DATABASE_URL`, `DATABASE_MIGRATION_URL` and
  `DATABASE_SSL` rules. An earlier Railway PostgreSQL service was replaced because of
  database problems there; do not delete it until the owner has confirmed that its
  accounts, ledger and assets were migrated as one recovery unit.
- API volume: mount `/data/assets`, set `ASSET_DIR=/data/assets`. Do not mount
  uploads into the frontend public directory. Media stays behind existing API ACL.

Web `API_URL` is the HTTPS Railway API origin (no credentials/path/query). It is
build-time configuration: rebuild web when it changes. All browser HTTP calls,
including auth and images, stay at `/api/...` on the Vercel origin. API
`WEB_ORIGIN` must be that exact canonical HTTPS web origin, not a wildcard and not
an arbitrary deployment preview URL. The conservative rate limiter currently groups ingress connections by the direct
proxy IP; this may limit staging concurrency. Do not solve this by trusting arbitrary
forwarding headers. Cookie stays HttpOnly, Secure, host-only,
SameSite=Lax. Do not add cross-origin cookies, permissive CORS, or trust arbitrary
forwarding headers.

## Supported hosted ingress

On Vercel, `proxy.ts` forwards HTTP to the fixed HTTPS API origin and injects
`x-dreamwalk-ingress` as a request-only header. Set the same fresh random secret
(at least 32 characters) as `DREAMWALK_INGRESS_SECRET` in web and API server
variables. Set `DREAMWALK_REQUIRE_INGRESS_SECRET=true` on API. Do not put it in
NEXT_PUBLIC variables or a browser cookie. The API rejects direct public traffic
without it; only the non-sensitive GET health endpoint is exempt. Existing
session/role/asset ACL checks remain mandatory after this transport gate. HTTP
mutations and WebSockets also enforce the exact Origin contract documented below.

Use Vercel Authentication on a protected staging preview deployment; verify both
HTML and API routes are covered before sharing. Do not expose an unprotected
production domain. A leaked ingress key is not a user session, but must still be
rotated. No bypass URL/automation secret is required for the human owner to test.

Hosted WebSocket routing uses the official `upgradeWebSocket` Next route API,
not an assumed external-CDN Upgrade rewrite. The server-side relay preserves
the browser session cookie and sends the configured canonical API trust Origin
plus the ingress secret to Railway. Browser Origin validation runs before
forwarding; missing or invalid configuration fails closed. Campaign and session
checks remain unchanged.
The browser never learns a Railway session token or shared secret. The API keeps
performing campaign/session authorization and projection revocation checks.
The relay has a bounded lifetime below Vercel's 300s Hobby function limit;
existing client reconnect is required and must be tested across that boundary.
Local/self-hosted Next still uses beforeFiles rewrites to the native Nest socket.

Sources: https://vercel.com/docs/functions/websockets and
https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package.
Actual hosted Upgrade, heartbeat, reconnect and cookie behavior remain mandatory
post-deployment acceptance checks; local helper tests do not certify the platform.

## Configuration and start

Railway injects `PORT`; omit `API_PORT` there to use it. An explicit `API_PORT`
takes precedence so existing local launchers can share a separate web `PORT`. Set `API_HOST=0.0.0.0`
and `NODE_ENV=production` explicitly. Local default remains loopback. The web
`npm run start:web` honors `PORT` and binds all interfaces for a later VPS move.
Keep web/API process environments separate when they use different ports.

Set private `DATABASE_URL`, canonical `WEB_ORIGIN`, and persistent `ASSET_DIR` on API.
On hosted web, set `API_WEB_ORIGIN` to that same canonical `WEB_ORIGIN`; use the
same value in production and previews sharing the API. Local web keeps its
existing `WEB_ORIGIN` configuration.
Use normal disabled generation defaults until the intended existing account,
ledger and generation configuration are reconciled. No credentials belong in `NEXT_PUBLIC_*`, repository files, images or logs.
Provider/database credentials stay on Railway only. The deliberately shared ingress
secret is the sole credential required in Vercel server-only web variables.

Apply the worksheet settings through the Railway service API/dashboard; it builds
API dependencies and runs compiled migrations once in the
pre-deploy phase; the migration runner uses a PostgreSQL advisory lock and checksum
verification. Take and verify a backup before migration. Do not run demo seed or
local admin creation at deployment. Health `/api/v1/health` checks PostgreSQL.
A passing healthcheck does not prove login, media, WS or provider readiness.

## Existing data and isolated preview differences

The original preview database, assets and financial history must be migrated as
one consistent recovery unit. A story JSON rescue is not a database backup and does
not include accounts, balances, unknown requests or generated assets. Never create
a new grant merely because the host changes. Reconcile old liabilities before any
provider calls; this is independent of preparing/building the hosting code.

The temporary preview had an audited continuation-after-unknown patch that is NOT
part of main at preparation time. This deployment branch does not copy that dirty
runtime patch. Include it only after separate source review/tests and explicit
release selection; otherwise the different error-stop behavior must be disclosed.

## Launch gates and verification

Before network exposure, protect staging and replace the old local test-admin
credential with a fresh private password. Do not migrate a weak exposed admin
password unchanged. API access must not bypass the chosen staging access policy;
protecting only Vercel HTML is insufficient if API is independently public.
Confirm current Vercel plan eligibility (Hobby is personal non-commercial and Git
organization repositories are restricted), Railway account/plan and actual billed
resources. Do not create another account to assume another trial.

After approved deployment, verify:

1. Terminal platform deployment SUCCESS, TLS and health/DB connectivity.
2. Register/login/logout and session revocation through canonical web origin;
   cookie flags unchanged, wrong-Origin mutations rejected.
3. Authorized socket Upgrade, wrong-Origin and unauthenticated socket rejection,
   reconnect/revocation and two-player projection privacy.
4. Private assets denied to unauthenticated/other users and survive API restart.
5. Draft persistence, playable story, disabled/no unexpected AI dispatch, migration
   idempotency, backup restore and persisted financial unknowns.
6. Preview protection on both web and API; no secrets/default admin in artifacts.

No paid provider test is part of deployment health verification. Later VPS migration
can use the same build/start commands, PostgreSQL dump/restore, persistent assets,
and a TLS reverse proxy forwarding both HTTP and WS on a single canonical origin.

Railway Config as Code is deprecated and cannot be enabled on new services.
The settings worksheet is deliberately not named railway.json. For this release,
service API settings own the configuration; no project-wide IaC import/apply runs.
Source: https://docs.railway.com/infrastructure-as-code#migrating-from-config-as-code.

## Production database prerequisite

On Supabase, `pgcrypto` is installed in the `extensions` schema (observed read-only on
2026-11-07). The migration runner's check that `digest(text,text)` resolves in the
current search path still applies, so that schema must be on the runtime role's path.

The database operator must install `pgcrypto` once using their database console.
It is needed by existing SQL digest-based erasure triggers, not only UUIDs.
Production migrations only read-check `pg_extension` and fail closed if it is
missing. After verification, the runner omits the exact extension-install statement
from the first migration's execution; historical files and recorded checksums are
unchanged. New extension DDL is rejected in production, not silently executed.
No operator extension command is dispatched by the deployment agent.

### Exact browser origins and stable API trust

The owner approved restoring HTTP and WebSocket Origin protection after the
custom domains were connected on 2026-11-05. `ENFORCE_BROWSER_ORIGIN` is `true`
on both the web relay and API. Login, sessions, campaign membership, private
content ACLs, ingress-secret checks and fixed upstream destinations remain required.

Vercel web deployments require two server-only, non-secret configuration values:

- `API_WEB_ORIGIN`: the exact HTTPS `WEB_ORIGIN` configured on the API. Use the
  same value for production and previews sharing that API. It is the stable
  server-to-server trust origin, not the API URL or a per-preview URL.
- `WEB_ALLOWED_ORIGINS`: a comma-separated list of exact HTTPS browser origins.
  For the connected site these are `https://www.dreamwalk.online`,
  `https://dreamwalk.online`, and `https://dreamwalk-rho.vercel.app`. No wildcard,
  credentials, path, query or fragment is allowed. The entire list fails closed
  if any entry is invalid, empty, over 16 entries, or over 4096 characters.

Since 2026-11-07 the canonical origin is `https://www.dreamwalk.online`: the API
`WEB_ORIGIN` and the Vercel `API_WEB_ORIGIN` are both set to it (the apex domain
redirects to `www`; `dreamwalk-rho.vercel.app` stays only in `WEB_ALLOWED_ORIGINS`).
The two values must always be identical. `VERCEL_PROJECT_PRODUCTION_URL`
is deliberately ignored for both backend trust and browser admission. On Vercel,
missing or invalid explicit configuration fails closed; there is no fallback to
`WEB_ORIGIN`, a primary platform domain, or a caller header.

Only on `VERCEL_ENV=preview` are the current deployment's exact `VERCEL_URL` and
`VERCEL_BRANCH_URL` also admitted. Arbitrary `*.vercel.app` addresses, production
build URLs not explicitly listed, and forwarded-host headers are never trusted.
The browser Origin must exactly match the admitted request URL origin. A supplied
Host must match the request host, and supplied Fetch-Site must be `same-origin`.
Missing, null, foreign, cross-site, same-site or contradictory Origins are rejected
before HTTP/WS forwarding. The server-to-server hop then uses `API_WEB_ORIGIN`
and the existing ingress secret, never the browser-supplied Origin.

Hosted API mutations require exact equality with the API's `WEB_ORIGIN`, including
rejecting absent Origin. Only non-production, non-ingress local/test HTTP clients
retain absent-Origin compatibility. API WebSockets always require exact canonical
Origin plus ingress, session and campaign authorization.

Configure these values before deploying the enabled checks. Verify the exact
commit in CI and then verify HTTPS, HTTP and WS on the new domain, old domain and
a real preview. A body-only POST to a nonexistent diagnostic route (no cookies,
no auth data) should return API 404 for a matching Origin and 403 for foreign,
missing or null Origin. Never use a real mutation route for this diagnostic.
A narrow routing check does not prove gameplay or authenticated WS behavior.
Vercel deployment protection remains separate and unchanged.

Previews using the production API share real accounts, stories and balances;
they are not an isolated sandbox. Cookie sessions remain host-specific. Google
OAuth callbacks, redirects and mail links derive from API `WEB_ORIGIN`, so they now
use `https://www.dreamwalk.online`. Sessions created on the old vercel.app host do
not carry over.

### Changing the canonical origin (lesson from 2026-11-07)

1. Change API `WEB_ORIGIN` (Railway) and web `API_WEB_ORIGIN` (Vercel) to the same
   exact HTTPS origin. Railway redeploys the API on every variable change and the
   API is briefly unavailable.
2. Create a new Vercel production deployment. A redeploy alone is not enough:
   **new production deployments are not automatically assigned to the custom
   domains** of this project. Assign `www.dreamwalk.online` and the vercel.app
   alias to the new deployment, or promote it in the dashboard.
3. Verify with a real mutation from a browser, and check the API HTTP logs: while
   the live deployment still carries the old `API_WEB_ORIGIN`, every POST is
   rejected with 403 in a few milliseconds while GET requests succeed, which looks
   like a login that works but cannot save anything.

Rollback: reassign the aliases to the previous deployment and restore both origin
variables together.

## Verified email and Google sign-in (configured 2026-11-07)

Railway API variables, names only; values are secrets or deployment-specific and
are managed in the platform dashboard: `BREVO_API_KEY`, `BREVO_FROM`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Brevo and Google settings must be set
as complete pairs, otherwise the API refuses to start (a missing `BREVO_FROM` with
a present key crashed startup during rollout). Do not set `SMTP_*` together with
Brevo.

- Brevo key: API key with only **Transactional email** permission, not the SMTP
  key. Sender `noreply@dreamwalk.online` on the authenticated domain
  `dreamwalk.online` (DKIM and DMARC records in GoDaddy DNS).
- Google OAuth web client with redirect URI
  `https://www.dreamwalk.online/api/v1/auth/google/callback` and only the
  `openid email profile` scopes.
- `AUTH_EMAIL_VERIFICATION_REQUIRED` stays off until real delivery is confirmed.
  Real inbox delivery and the Google callback are verified by the owner in a
  browser, not by this repository's synthetic tests.
