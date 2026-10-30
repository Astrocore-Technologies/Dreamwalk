# Dreamwalk

A platform-first fantasy adventure application: discover stories, prepare a hero, create adventures and NPCs, manage drafts and moderation. Private adventures use explicit invitations; public adventures require moderator approval. **The game runtime comes later.** This is a local platform candidate, not a publicly deployed service.

- Next.js 16 / React 19 frontend; NestJS 12 backend; strict TypeScript; PostgreSQL 17.
- Ukrainian, English and Russian interface (`uk`, `en`, `ru`). Authors write once. Titles/synopses use available approved locale variants with original fallback; full story/NPC text stays original. Automatic translation is not connected.
- Real account/content persistence, opaque cookie sessions, ownership and admin checks.
- Demo-only Sparks wallet with append-only ledger and idempotency. No actual purchases or AI calls.
- Original bundled fantasy covers; provenance: `assets/demo/manifest.json`.

## Start locally

Prerequisites: Node.js 22+ and npm. A supported Linux/macOS/Windows host for the embedded PostgreSQL binary, or your own PostgreSQL instance.

```sh
npm ci
npm run dev
```

`npm run dev` builds contracts, starts **real PostgreSQL** on loopback when `DATABASE_URL` is absent, applies migrations, seeds original demo content, and starts Nest (4000) + Next (3000). Open `http://localhost:3000`. It generates private random database credentials under `.local/preview-live/`, which is Git-ignored. No shared login password is created: register your own account in the UI. Stop gracefully with Ctrl+C; local data persists.

Do **not** set `NODE_ENV=production` for the local bootstrap. Do not expose this development setup to the Internet.

### Use your own PostgreSQL / Docker

Copy `.env.example` to `.env`, set a unique `DATABASE_URL` and correct `WEB_ORIGIN`. No credentials go into Git or frontend variables. For Docker-based PostgreSQL:

```sh
# Set POSTGRES_PASSWORD in your shell first, using a unique local value.
docker compose -f infra/compose.yml up -d
# Set DATABASE_URL in .env to that database, then:
npm run dev
```

The launcher uses an existing `DATABASE_URL` instead of starting another database. A normal local shell can run `npm run db:migrate` / `npm run db:seed` separately. Demo seed is idempotent and forbidden in production.

### Administrator access

There is no default admin/password. Register a local account, then use the explicit operator command with the **same database**:

```sh
npm run admin:grant -- --email your-registered-email@example.com
```

The command is development-only and audited. The managed local launcher also supports an explicit development-only `LOCAL_ADMIN_EMAIL` startup target for an existing synthetic QA account; remove it immediately after bootstrap. There is no web admin-grant endpoint. Refresh the application to see Admin. Never grant admin based on browser input or a public signup field. In isolated managed executors, operator commands must run in the same process/network namespace as the database; do not assume a loopback URL is reachable from another command session.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:integration
npm run test:mail
```

`test:integration` owns a fresh PostgreSQL cluster, applies migrations/seed, launches Nest, tests live HTTP and database invariants, then stops it. No external services, purchases or keys. Private disposable test clusters live in `.local/test-*`; remove only stopped test clusters if reclaiming disk space.

Browser test sources are in `tests/e2e`:

```sh
# On your normal local/CI machine with application running:
npx playwright install chromium
npm run test:e2e
```

The managed Work environment uses its provided CUA browser and `sites-preview` daemon instead of installing or launching another browser. See `docs/progress.md` for checks actually executed, screenshots and limitations; test source existing is not proof of a passed browser run.

## Main flows

- Public: home, catalog, story detail, creator profile, about, support and policy templates.
- Account: signup/signin, onboarding, profile/avatar, themes/locales/privacy/notifications/accessibility, sessions/password and export/deletion requests.
- Preparation: favorites/library and separate player heroes.
- Studio: stories, world/rules, locations, NPCs, starting scene, boundaries, preview, versions and moderation submission; safe raster assets.
- Admin: users/roles, content, reports, model styles vs runtime configuration, demo credits and audit.

## Deliberate limitations

- A bounded mock game and authored-grid editor are available. Real AI generation, Discord Activity and real checkout remain unavailable and separately gated.
- Email delivery is optional and disabled without SMTP configuration. Secure recovery/verification is implemented and tested against local SMTP capture; external provider deliverability remains an operator setup step. No external mail was sent during development.
- Account deletion immediately disables access/anonymizes identity and hides content. An explicit audited operator command processes exports and physical purges; private archives expire after seven days. Financial/event identifiers and backup-retention obligations remain, not a false claim of global erasure.
- Legal/privacy/content pages are templates requiring owner review, jurisdiction/age decisions and operational setup before public release.
- Production hosting, merge and deployment are outside this implementation. Source review is through an owner-authorized draft pull request.

## Configuration and safety

`AI_PROVIDER=mock`, paid generation/payments/Discord flags off, `GLOBAL_SPEND_CAP=0`. These platform flags still reject live generation and money flows. The separate NPC provider boundary defaults to `NPC_AI_PROVIDER=mock` and external approval off; enabling its trusted HTTP adapter requires explicit operator configuration and separately approved budget, not a player setting. No vendor integration or live cost measurement is claimed. Production also rejects dev auth/faucet and requires HTTPS. Server credentials never belong in `NEXT_PUBLIC_*`.

Docs: [Architecture](docs/architecture.md), [API contract](docs/api-contract.md), [Plan](docs/implementation-plan.md), [Progress/evidence](docs/progress.md), [Backup/restore](docs/runbooks/backup-restore.md), [Account data operations](docs/runbooks/account-data.md), [Optional email](docs/runbooks/email.md), [agent rules](AGENTS.md).

## Hybrid RPG prototype (G0–G3, local only)

The authenticated `/game` area can start the compatibility observatory fixture or an
available immutable authored version. Studio's Locations step has a bounded grid editor:
choose a template, place walls/spawns/items/doors/NPCs/exits, validate it and launch a
private test. Public launch requires moderation of the submitted immutable package;
the moderator reviews its topology and approves that exact version.

Campaign invitation alone does not grant private source-story access. Each invited
player needs both permissions. Author edits do not change existing campaigns.

Authored campaigns support multiple local simultaneous-intent rounds, boundary joins,
flee/end votes and configured deadlines; players on other maps continue exploring.
The mock NPC can approach, give an owned item and patrol using a persisted bounded plan
and observed-event memory. This is not full combat AI or a professional level editor.
Old observatory campaigns retain one-round semantics for compatibility.

Game progress saves automatically: significant actions commit before acknowledgement,
movement checkpoints periodically. There is no manual game-save step. Existing Studio
narrative, NPC and playable drafts autosave after valid edits with visible status and
revision conflict protection; first creation and publication remain explicit. Unacknowledged
offline/invalid input stays in memory with leave warnings, not crash-proof local storage.
When everyone leaves, simulation and remaining round/mock-job clocks pause durably.
No paid AI or purchases are enabled. Narrative-only stories are not automatically playable.

```sh
npm run test:game              # deterministic rules and adversarial mock cases
npm run test:game:integration  # fresh isolated PostgreSQL + API/socket/restart tests
npm run test:e2e               # includes independent-browser game scenario where runner is available
```

Game integration always provisions a disposable local test cluster and refuses production
mode. It never uses `.local/preview-live`. Follow the managed-preview recovery runbook
for the persistent development database; do not remove database lock files blindly.

[Architecture](docs/hybrid-rpg-architecture.ru.md), [ADR](docs/adr/001-hybrid-rpg.md),
and [acceptance evidence and limits](docs/game-acceptance.md) distinguish implementation
from checks actually run. New game code is not deployed or published by these commands.

## Living NPC ruleset

In a saved Studio adventure, open Locations and choose the keeper/helper template or
explicitly enable reactive NPC behavior. Set bounded personality, habits, authored links,
initial knowledge and disclosure rules; saved-draft perception preview is owner-only.
New test/published campaigns pin this `hybrid-v3` package. Existing campaigns do not
silently upgrade, and publication still requires explicit moderation.

NPCs observe only permitted events, keep personal evidence and relationships, investigate,
warn, patrol and fulfill promises using real owned items. Their routines do not require
clicking an NPC-request button and never make paid calls. Players can speak aloud or
whisper; private speech and memories do not become a shared global NPC mind. Semantic
episodes are archived separately from bounded hot context and erased with their causal
dependencies when an account purge is confirmed.

The AI panel is an explicit **mock** operation preview/consent flow. Its plan, summary
and speech results pass server validation before commit. Demo-credit holds and provider
cost accounting are separate; timeout does not imply a free provider request. Real-model
quality, automatic translations, generated artwork and live payments remain gated.
The approved art direction is drawn 2D; bundled fixture sprites are temporary.

See [NPC architecture](docs/living-npc-architecture.ru.md),
[coverage and verification](docs/npc-implementation-coverage.md), and
[provider operations](docs/npc-ai-operations.md). Admin-only aggregate diagnostics are
available at `GET /api/v1/admin/npc-ai/metrics`; they contain no private prompts or actor IDs.

## Reusable art and image preparation

`/studio/assets` manages private raster revisions and explicit cross-author reuse grants.
Adventure Locations can autosave compatible art bindings; playable versions pin the exact
revision without mutating existing campaigns. See [reusable art](docs/assets-reuse.md).

The adventure-scoped library also offers an explicitly labelled **mock image pipeline**:
search reusable materials, request a quote, consent, and receive a fixed synthetic raster
sample as a new immutable library revision. It does not bind or publish the result for you.
External image generation is hard-disabled; adding a key alone cannot activate it.
See [generation preparation and remaining live gates](docs/image-generation.md).

Run `npm run test:images:integration` for the isolated PostgreSQL/fixture-provider checks.
No test command above makes paid image requests or starts the user's separate installation.
