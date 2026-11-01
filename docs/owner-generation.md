# Owner-operated generation

This is an opt-in application mode, not a temporary evaluation session. The owner
configures a persistent server, registers/logs into their ordinary account, and
acknowledges the displayed budget once. The server creates the durable authorization
ID; there is no UUID file to prepare and no two-hour authorization expiry. Starting
the application, opening a page or viewing a quote does not authorize a paid request.

Defaults remain mock/disabled. This implementation is tested with synthetic keys and
injected transports. It does **not** establish real model availability, provider
account access, actual image quality or invoice accuracy. Product configuration does
not override permissions imposed on a tool or an assistant operating the machine.

## One-time owner setup

1. Use the **existing persistent database** and your registered account handle. Back
   up that database normally. Do not create a replacement database to clear a failed
   request, spent budget or an unknown charge. Owner mode refuses implicit database
   bootstrap when no database is explicitly configured.
2. Keep provider credentials in a private file outside the repository, or the ignored
   root `.env`. One `OPENAI_API_KEY` serves text and images; an existing
   `NPC_AI_API_KEY` is also accepted. If both exist, text prefers `NPC_AI_API_KEY`
   and images prefer `OPENAI_API_KEY`. Do not put keys in `apps/web`, `NEXT_PUBLIC_*`,
   a shell command, a screenshot or Git.
3. Set the root `.env` configuration below. Keep the platform's existing
   `AI_PROVIDER=mock`, `PAID_GENERATION_ENABLED=false`, `PAYMENTS_ENABLED=false`,
   `DISCORD_ENABLED=false` and `GLOBAL_SPEND_CAP=0`: owner generation is a separate,
   explicitly budgeted subsystem. Do not enable `LIVE_TEST_ENABLED` simultaneously.

```dotenv
GENERATION_MODE=owner
GENERATION_OWNER_HANDLE=your_registered_handle
DREAMWALK_SERVER_ENV_FILE=/absolute/private/path/server.env
DREAMWALK_DATABASE_ENV_FILE=/absolute/path/to/existing/database.env
# Alternatively supply the existing DATABASE_URL directly in this ignored file.
# GENERATION_OWNER_CONFIG_JSON is the explicit profile described below.
```

On Windows use an absolute path such as `C:/Private/Dreamwalk/server.env`; no specific
machine directory is assumed. The optional database file must contain only
`DATABASE_URL`. The private server file accepts only `OPENAI_API_KEY`,
`NPC_AI_API_KEY`, `NPC_AI_KILL_SWITCH`, `GENERATION_MODE`,
`GENERATION_OWNER_HANDLE` and `GENERATION_OWNER_CONFIG_JSON`; unrelated execution
settings are rejected. It is not evaluated as a shell script. Both private files
must be regular, non-symlink files no larger than 64 KiB.

The private server file is read only when owner mode is explicitly selected. It can
contain the existing key alone, with the nonsecret policy in root `.env`, or the key
and owner policy together. The launcher never writes another key file. Credentials
and provider policy go only to the API process, not Next.js or compilation/migration
children. A credential-shaped `NEXT_PUBLIC_*` variable is rejected.

### Explicit model, pricing and budget profile

Set `GENERATION_OWNER_CONFIG_JSON` to a JSON object with the following shape. The
angle-bracket strings are **placeholders, intentionally not a usable configuration**;
replace numeric placeholders with integers. Node dotenv accepts a single-quoted
multiline JSON value. No model or price below is inferred from an account or a
previous test.

```json
{
  "totalCapMicros": "<cumulative total USD micro-units>",
  "textCapMicros": "<text purpose ceiling>",
  "imageCapMicros": "<image purpose ceiling>",
  "text": {
    "model": "<explicit supported Responses model>",
    "contextTokens": "<verified model context limit>",
    "maxOutputTokens": "<chosen bounded output limit>",
    "maxInputBytes": "<chosen serialized request limit, at most 64000>",
    "inputMicrosPerMillion": "<verified input USD micro-units per million tokens>",
    "outputMicrosPerMillion": "<verified output USD micro-units per million tokens>",
    "pricing": {
      "source": "<official HTTPS pricing/model documentation URL>",
      "reviewedAt": "<UTC ISO timestamp of review>",
      "validUntil": "<explicit UTC ISO pricing-review validity timestamp>"
    }
  },
  "image": {
    "model": "<explicit supported Images model>",
    "size": "1024x1024",
    "quality": "low",
    "outputs": 1,
    "format": "png",
    "maxPromptUtf8Bytes": 8000,
    "maxReferenceImages": 0,
    "inputTextMicrosPerMillion": "<verified text-input rate>",
    "inputImageMicrosPerMillion": "<verified image-input rate>",
    "outputImageMicrosPerMillion": "<verified image-output rate>",
    "estimatedTotalMicros": "<documented planning estimate for this profile>",
    "reserveMicros": "<chosen operational reserve, at least the estimate>",
    "estimateRiskAccepted": true,
    "pricing": {
      "source": "<official HTTPS pricing/model documentation URL>",
      "reviewedAt": "<UTC ISO timestamp of review>",
      "validUntil": "<explicit UTC ISO pricing-review validity timestamp>"
    }
  }
}
```

One USD equals 1,000,000 micro-units. Each purpose ceiling must fit the total. The
text reserve is calculated conservatively from the entire declared context and
output ceiling at the configured rates, not a guessed characters-to-tokens ratio.
The serialized input plus protocol allowance and output limit must fit the context.
Only Standard service tier, no reasoning, no tools and bounded outputs are requested.
Use a model that actually supports that contract; configuration is not proof of access.

The owner image profile allows **one output PNG** and an explicit maximum of **zero,
one or two owned/private reference images**. Choose `maxReferenceImages` for the
intended workflow: zero disables photo/reference-conditioned generation rather than
silently stripping a reference. Each reference must be PNG/WebP, at most 5 MiB and
4096 × 4096 pixels; ownership, consent, content hash and actual raster bounds are
checked before dispatch. Private photo character creation and approved-concept
references use the same normal review/adoption flow. A reference-capable profile
must use a model supporting image edits and its estimate/reserve must cover the
maximum configured references and their input cost, not just a no-reference request.

An image estimate is **not a guaranteed invoice maximum**. The provider does not
enforce our monetary reserve. The server records reported usage, stops on unknown
cost or overrun, and the owner must accept estimate risk separately for each quoted
image request. No model, access or rate is inferred from the example above.

Pricing evidence must be current at configuration and checked again before use.
Its validity is distinct from authorization lifetime; there is no invented two-hour
pricing limit. Do not extend a date without checking the underlying model/rates.

## Ordinary startup and use

With the configured existing PostgreSQL service running, from the checkout root:

```sh
npm ci
npm run dev
```

Open `http://localhost:3000`, sign in as the configured handle, review the owner budget
panel, and acknowledge the displayed policy. This acknowledgement creates no provider
request. Subsequently quote and explicitly confirm the individual text/image action;
estimated images require a second risk checkbox. Successful images remain private
until the normal admission/review and library/map-binding steps. An unavailable or
failed external provider is never represented as a real generated fixture image.

If using the project's embedded PostgreSQL rather than an installed service, start
the **same existing cluster**, not a new one. For example, only for a known existing
cluster on Windows PowerShell (replace the placeholder with its actual name):

```powershell
$env:LOCAL_POSTGRES_CLUSTER = '<existing-cluster-name>'
npm run db:local
```

Keep that terminal open and run the application in another terminal. A different
existing cluster must use its actual name and corresponding database file. If there
is a stale lock or unclean shutdown, follow the database recovery procedure; do not
delete locks/data or invent a fresh cluster. Do not replace an existing database to
reset its recorded spending or unresolved liability.

## Durable safety and configuration changes

- Authentication, account/source/asset rights, phase fences and request idempotency
  are rechecked server-side; the configured handle is not a replacement for login.
- The authorization ID is stable across restarts and is not an allowance. The old
  ledger/scope remains authoritative. Historical spent, held, unknown, blocked and
  overrun records are not deleted or moved to a fresh scope.
- Existing ceilings are not silently raised or revoked budgets reapproved by changing
  mode. Effective limits are the stricter configured/persisted ceilings; prior costs
  reduce availability. Unresolved older-scope liability blocks use for reconciliation.
- Unknown outcome, HTTP 403, overdue dispatch and budget overrun stop further use.
  Restart, repeated clicks, a new operation ID, model changes or a key rotation do not
  make that request free or authorize a retry. Late known accounting does not resume
  a stopped authorization automatically.
- Owner identity and the cost/model profile are pinned to the durable acknowledgement.
  Changing a pinned profile fails closed; an explicit operator policy-amendment/
  reconciliation workflow is not supplied by this version. Do not edit database
  counters or authorization rows to work around it. Key rotation alone does not
  change the nonsecret profile identity or reset spend.
- The old temporary manual-test mode remains compatible and separately restricted;
  its expired grant cannot activate owner mode. Never select both modes together.

Malformed owner configuration yields a nonsecret error rather than mock fallback.
Status distinguishes configured adapter, acknowledged owner policy, current pricing,
available reserve, outstanding work and a stopped budget. Secrets and private prompts
are not included in status, logs or browser configuration.
