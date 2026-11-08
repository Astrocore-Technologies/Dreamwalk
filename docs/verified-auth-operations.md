# Verified email and Google login — separate opt-in rollout

This change retains Dreamwalk users, sessions and PostgreSQL. The application
database is Railway PostgreSQL (see `hosting.md`); Supabase is no longer used and
Supabase Auth was never used.

## Safe rollout boundary

Migration 047 preserves all existing accounts with
`email_verification_required=false`; it does not falsely mark their email verified,
grant extra Sparks, or reset their sessions/roles. Existing administrators keep access.
Do not assume a configured admin address is an owned or deliverable mailbox.

`AUTH_EMAIL_VERIFICATION_REQUIRED` defaults to `false` so publishing code cannot
lock users before working email delivery is configured. While false, password signup
retains the previous registration bonus flow. This is a deployment transition, not
completion of the requested mandatory-verification launch. After activation, new
password accounts receive restricted sessions and no starter balance until email
confirmation; protected gameplay APIs reject them with `EMAIL_VERIFICATION_REQUIRED`.
Me, logout, email confirmation/resend and password recovery remain available.

Confirmed new users get 50 Sparks exactly once, atomically with verification. Legacy
accounts have no new gift eligibility. Turning the activation flag off later does not
remove the verification requirement from accounts already created as pending.

## Brevo on Railway Hobby

Railway Hobby does not support outbound SMTP. Use Brevo's **HTTPS API**, not its SMTP
key; there is no need to upgrade Railway merely to send these emails.

Backend-only variables (Railway API service, never `NEXT_PUBLIC_*` or Vercel web):

- `BREVO_API_KEY`: transactional API key from the owner's Brevo account.
- `BREVO_FROM`: an email sender accepted/verified by that Brevo account.
- `WEB_ORIGIN`: canonical HTTPS web origin, currently `https://www.dreamwalk.online`
  (must equal the Vercel `API_WEB_ORIGIN`; see `hosting.md`).
- `AUTH_EMAIL_VERIFICATION_REQUIRED=true`: only after an authorized real delivery test.

Do not configure SMTP and Brevo simultaneously. Existing `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` remain supported for local
capture tests or hosts/plans permitting SMTP. The SMTP path still requires TLS in
production. Brevo calls use a fixed HTTPS endpoint, a 10-second timeout, no automatic
retry, no redirect following and sanitized errors. No API key, raw provider error,
recipient or verification token is logged.

The free provider allocation and shared-sender eligibility are external policies,
not code guarantees. A vercel.app URL is not an owned sender domain. Brevo may offer
temporary sender rewriting; the actual account must be activated and the sender
accepted. The owned domain `dreamwalk.online` was authenticated in Brevo on
2026-11-07 (DKIM and DMARC), with the sender `noreply@dreamwalk.online`.

A 201 response means **provider accepted the request**, not that the email reached
the inbox. Confirm arrival (including spam), open the link, confirm once, and check
repeat/expired links and resend. Quota, provider rejection or timeout leaves the user
pending; the resend UI remains accessible. Mail sends retain the existing detached
transport model, not a durable queue. A crash after token commit may require resend.

## Google configuration

Provide backend-only `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Both or neither
are required. Until configured, no Google button is displayed. Create a Web OAuth
client with the exact authorized redirect:

`https://<canonical-web-host>/api/v1/auth/google/callback`

Use the canonical web host (`www.dreamwalk.online`) through the existing ingress
proxy, not the Railway hostname. For local development use the matching localhost origin separately.
Configure consent/branding and audience for the intended public launch; no Gmail,
Drive or other mail-reading scopes are needed (`openid email profile` only).

The backend validates signature, issuer, audience, expiration, age, authorized party
and nonce; state and browser cookie are bound to a single-use 10-minute DB attempt,
with PKCE S256. A fresh Dreamwalk session replaces the invoking browser session.
Google identity is stable provider `sub`, never email. Tokens and OAuth client secrets
are not stored in the frontend or returned to clients.

Gmail and verified Workspace (`hd`) addresses need no separate email. Google accounts
using third-party addresses require Dreamwalk email confirmation before activation
and the bonus, because Google may not be authoritative for current mailbox ownership.
If the email already belongs to a password account, Google login does **not** link or
overwrite it: the UI directs the user to ordinary login/recovery. Explicit account
linking is not part of this initial flow. Google-only users can use password recovery
to set a password for existing password-protected account management actions.

## Verification before activation

1. Run `npm run test:auth` (local SMTP/PG and synthetic Google/Brevo only), typecheck,
   lint, API integration and account-email browser tests.
2. Deploy migrations/code with mandatory mode disabled; confirm old/admin login.
3. Owner configures Brevo sender/API key and Google OAuth client via secret settings.
4. With explicit authorization, verify real delivery and Google callback on canonical
   production origin; do not claim synthetic tests establish external delivery.
5. Activate mandatory mode and test a fresh password signup: no gameplay or bonus
   before email, 50 exactly once afterward. Existing accounts are intentionally
   grandfathered, not silently migrated.

References checked 2026-11-02:

- https://docs.railway.com/networking/outbound-networking
- https://developers.brevo.com/reference/send-transac-email
- https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan
- https://help.brevo.com/hc/en-us/articles/14925263522578-Comply-with-Gmail-Yahoo-and-Microsoft-s-requirements-for-email-senders
- https://developers.google.com/identity/openid-connect/openid-connect
- https://developers.google.com/identity/gsi/web/guides/verify-google-id-token

## Registration runtime permissions (KAN-36)

Password registration grants the existing starter Dreams inside the same transaction.
Migration 054 enabled RLS on the four Dreams tables, while production uses the
non-owner, non-BYPASSRLS `dreamwalk_runtime` role. Table grants alone do not satisfy
RLS: missing policies reject the starter wallet insert with SQLSTATE 42501 and roll
back the account. Owner-role test databases do not expose this failure.

Migration 071 supplies only backend-role policies for the existing operations:
wallets/holds SELECT, INSERT, UPDATE; quotes/ledger SELECT, INSERT. RLS stays enabled,
no role/credential is created, existing GRANTs are unchanged, and no policy is given
to PUBLIC, anon, authenticated or other browser roles. The runtime role is trusted
server-only: API authentication, ownership checks and accounting constraints remain
the user-level boundary. It must not be exposed through a client or Data API role.

Applying this migration to production changes persistent access and requires the
owner's explicit action-time approval. Review the role/table matrix first, apply via
the approved migration rollout, and verify policies and non-owner registration.
The disposable PostgreSQL `platform-registration-runtime` test reproduces the
pre-policy failure, rolls back the failed fixture, then checks signup, one starter grant,
case-insensitive identity, and denial for another non-owner role. It creates no
real production accounts. No existing account receives a gift or data change.

Registration and profile accept ASCII uppercase handles, canonicalize them to
lowercase before the existing UNIQUE key, and retain the supplied display name.
Password login remains email-based, with existing case normalization. Google
credentials and mandatory email-verification rollout remain separate operations.
