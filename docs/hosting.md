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
- Railway PostgreSQL: private connection from API; not exposed publicly.
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
session/role/asset ACL checks remain mandatory after this transport gate. Origin
enforcement is temporarily paused as documented below.

Use Vercel Authentication on a protected staging preview deployment; verify both
HTML and API routes are covered before sharing. Do not expose an unprotected
production domain. A leaked ingress key is not a user session, but must still be
rotated. No bypass URL/automation secret is required for the human owner to test.

Hosted WebSocket routing uses the official `upgradeWebSocket` Next route API,
not an assumed external-CDN Upgrade rewrite. The server-side relay preserves
the browser session cookie and sends the configured canonical API trust Origin
(when valid) plus the ingress secret to Railway. Browser Origin validation is
temporarily paused; campaign and session checks are unchanged.
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
Before re-enabling Origin checks on hosted web, set `API_WEB_ORIGIN` to that same canonical `WEB_ORIGIN`; use the
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

The database operator must install `pgcrypto` once using their database console.
It is needed by existing SQL digest-based erasure triggers, not only UUIDs.
Production migrations only read-check `pg_extension` and fail closed if it is
missing. After verification, the runner omits the exact extension-install statement
from the first migration's execution; historical files and recorded checksums are
unchanged. New extension DDL is rejected in production, not silently executed.
No operator extension command is dispatched by the deployment agent.

### Temporary Origin enforcement pause

The owner explicitly approved pausing browser Origin/CSRF enforcement on
2026-11-04 until domain setup is ready. `ENFORCE_BROWSER_ORIGIN` is `false` in
both `apps/web/lib/hosted-origin.ts` and `apps/api/src/ingress.ts`. This pauses
the HTTP and WebSocket Origin checks on both sides; there is no expiry, timer,
environment-triggered toggle, or automatic re-enable when a domain appears.

This removes a cross-site-request defense. It does not disable login, session
validation, roles, campaign membership, private-content ACL, the ingress secret,
fixed HTTPS upstream target, request limits, cookie flags, OAuth state/PKCE, or
the separate loopback-only local test-admin guard. Missing user authorization
still fails, even with a foreign or missing Origin. Vercel deployment protection
is separate and is not changed by this code.

`API_WEB_ORIGIN` is optional during the pause. An invalid canonical origin is
never copied from caller headers: the relay omits it instead. Normal deployment
and CI gates remain required. Re-enable only after the owner's explicit approval,
configure the stable API origin below, change both policy constants together,
restore the strict active-path assertions, and verify HTTP and WebSocket behavior.

### Strict request-origin policy retained for later re-enable

The retained strict helper validates the browser against the current
public request URL before forwarding to the API. Only the stable canonical API
web origin, Vercel's project-owned production domain, and its exact
`VERCEL_URL` / `VERCEL_BRANCH_URL` are admitted. Forwarded-host
headers and arbitrary `*.vercel.app` domains are not trusted. Missing, null,
foreign, or contradictory browser origins return false. These decisions are
tested but are not enforced by the active HTTP/WS paths during the pause.

Set server-only `API_WEB_ORIGIN` on Vercel to the exact HTTPS `WEB_ORIGIN` already
configured on the API. Use that same value for production and every preview that
shares that API. It is not a secret, the API URL, a wildcard, or a per-preview value.
After edge validation, HTTP and WebSocket server-to-server hops use this stable
Origin and the existing ingress secret. Adding a project custom domain changes
browser admission through `VERCEL_PROJECT_PRODUCTION_URL`, not the API contract.
The stable API origin will let the existing API Origin guard be restored without
tracking every preview or Vercel primary-domain change.

Deployments without `API_WEB_ORIGIN` retain the previous compatibility behavior:
use `VERCEL_PROJECT_PRODUCTION_URL`, then `WEB_ORIGIN` only when the platform value
is absent. When enforcement is restored, that fallback still requires the API canonical origin to match and is
not safe against primary-domain drift. A malformed explicit setting fails closed,
never falling through to another origin. Before restoring enforcement, verify
the API's canonical origin, configure `API_WEB_ORIGIN` for each intended Vercel
environment, and rebuild only after the exact commit passes CI. Test a body-only
POST to a nonexistent diagnostic route on production and a preview: 404 from the
API is expected, never an edge/backend origin 403. Send no session or auth cookies,
and do not use a real mutation endpoint. Also verify a foreign Origin is denied.
Do not infer full gameplay or WebSocket health from this narrow routing check.
Vercel deployment protection and
application authentication/authorization remain separate and unchanged.

Previews using the production API share real accounts, stories, and balances;
they are not an isolated sandbox. Google OAuth callbacks remain canonical-bound.
Before re-enabling enforcement, verify a real preview's public URL/Host/Fetch-Site behavior using
non-mutating diagnostic endpoints and confirm untrusted origins are still denied.
