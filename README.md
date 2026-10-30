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

- Play, campaign/lobby, AI generation, Discord Activity and real checkout are unavailable, clearly labeled in UI.
- Email delivery is not configured. Password recovery explicitly says no email was sent; use a reviewed operator procedure during closed testing. No fake success email.
- Account deletion immediately disables access/anonymizes identity and hides content; remaining private resources/immutable records enter a purge request, not a false claim of complete erasure.
- Legal/privacy/content pages are templates requiring owner review, jurisdiction/age decisions and operational setup before public release.
- Production hosting, merge and deployment are outside this implementation. Source review is through an owner-authorized draft pull request.

## Configuration and safety

`AI_PROVIDER=mock`, paid generation/payments/Discord flags off, `GLOBAL_SPEND_CAP=0`. This milestone rejects attempts to enable live providers or money flows. Production also rejects dev auth/faucet and requires HTTPS. `OPENAI_*` model names are future config only; no external availability is asserted. Server credentials never belong in `NEXT_PUBLIC_*`.

Docs: [Architecture](docs/architecture.md), [API contract](docs/api-contract.md), [Plan](docs/implementation-plan.md), [Progress/evidence](docs/progress.md), [Backup/restore](docs/runbooks/backup-restore.md), [agent rules](AGENTS.md).
