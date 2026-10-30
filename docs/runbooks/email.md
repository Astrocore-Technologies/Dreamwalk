# Optional account email adapter

Email stays disabled unless `SMTP_HOST` and `SMTP_FROM` are configured server-side. No external delivery is enabled in the development preview. An operator must obtain authorization before configuring a real provider. No paid provider or credential UI is included.

`SMTP_PORT` defaults to 587; `SMTP_SECURE=true` selects implicit TLS (usually port465). Optional `SMTP_USER` and `SMTP_PASSWORD` must both be set. Production enforces STARTTLS or implicit TLS, verified certificates and TLS1.2 minimum. SMTP/file/URL debugging and content fetches are disabled. Transport timeouts bound failures. Credentials never reach the client.

- `POST /auth/reset-password {email}` returns `{ok:true,code:"REQUEST_ACCEPTED"}` uniformly for known/unknown addresses when configured. Otherwise it returns `EMAIL_DELIVERY_UNAVAILABLE`. Acceptance is not a delivery receipt. SMTP failures do not change the anonymous response or expose an account; failed-delivery tokens are deleted.
- `POST /auth/reset-password/confirm {token,password}` consumes a valid token once and revokes every existing session. It does not automatically log in.
- Authenticated `POST /account/email-verification/request` uses the current account email only.
- `POST /auth/verify-email {token}` consumes a verification token once. `User.emailVerified` becomes true.
- Invalid, malformed, expired, wrong-purpose and used tokens return stable `TOKEN_INVALID`.

Links use `/auth/reset-password/confirm#token=...` or `/auth/verify-email#token=...`; fragments are not sent in HTTP requests. The UI strips the fragment into component state and requires an explicit confirmation, not an automatic scanner-triggered mutation. Password reset and verification emails use the account's Ukrainian, English or Russian language.

Migration007 adds hash-only, random256-bit bearer tokens with a30-minute expiry. No raw token endpoint, database field or logs exist. Per-address/purpose cooldowns persist in PostgreSQL for known and unknown addresses; shared auth IP limits also apply. Re-requesting after cooldown invalidates older same-purpose tokens. Password changes invalidate outstanding reset tokens; account deletion removes all account email tokens. Email verification is informational, not an unexpected gate on existing accounts.

Operators may periodically remove `auth_email_tokens` where `expires_at < now()-interval '1 day'` and `auth_email_cooldowns` where `requested_at < now()-interval '1 day'`. Neither table belongs in user exports. Keep normal encrypted database backup controls; hashes are still sensitive metadata.

Run `npm run test:mail` for an isolated PostgreSQL and local in-memory SMTP capture integration. It tests actual Nest endpoints and SMTP messages, disabled mode, uniform anonymous responses, cooldown, hash-only storage, fragment links, wrong-purpose/malformed/expired/replayed tokens, password reset/session revocation/login and email verification. Captured raw messages remain in test memory only; no external mail is sent.

Reference: [Nodemailer official SMTP transport](https://nodemailer.com/smtp).

Requests also remove up to1000 expired cooldown/token rows older than one day opportunistically; periodic maintenance is recommended for idle deployments. Account deletion removes its tokens and hashed-address cooldown. The capture test is not an external provider deliverability test: real SMTP authentication, DNS/SPF/DKIM/DMARC, bounce handling and inbox placement must be verified by the deployment operator after explicit authorization.
