# Dreamwalk

Preserve the completed P0–P4 platform. The owner authorized local hybrid gameplay G0–G3 on 2026-10-30. Read docs/implementation-plan.md, docs/hybrid-rpg-architecture.ru.md and docs/progress.md. Stop before real-provider G4 without separate budget approval.

- npm workspaces, strict TypeScript, Next.js UI, NestJS is sole business-logic owner, PostgreSQL.
- Ukrainian, English and Russian UI through complete locales; English identifiers. Brand: Dreamwalk.
- Preserve ownership/role checks on server. Never expose session hashes, NPC secrets, credentials or private content.
- No paid AI, payment processing, Discord integration, public deployment or repository publication without owner approval.
- Demo wallet is not money. Append-only ledger and idempotent mutations only.
- Validate all input; don't render user HTML. Raster-only bounded image upload.
- Run typecheck, lint, API/database tests and applicable browser tests before handoff. Never claim unrun checks passed.
- Keep root package-lock.json as sole dependency lock; no parallel backend/package manager.
- Do not commit .env, local database, upload files or test output.

Commands and configuration: README.md. Contracts: docs/api-contract.md. Architecture: docs/architecture.md.

The owner subsequently approved the full living-NPC architecture implementation. Read
`docs/living-npc-architecture.ru.md` and `docs/npc-implementation-coverage.md`. Continue
through the agreed domain, mock-tested runtime, provider/budget boundary and UI; do not
stop at a first slice or claim unverified production/provider behavior. Drawn 2D only;
pixel art is cancelled, existing placeholders remain temporary. Real provider calls,
real payments, deployment and merge still require separate authorization.

The owner also approved the reusable drawn-art library and preparation of image
creation through search, quote, explicit consent and durable admission. Keep image
jobs separate from NPC state and preserve immutable asset/version rights. A single
synthetic live evaluation has a separately approved text ceiling of USD 1 and image
ceiling of USD 1 (USD 2 combined), with no automatic retries/regeneration. This is not
blanket production activation. Credentials must be supplied through an authorized
secret-entry flow; never reuse earlier chat tokens. External image dispatch remains
unavailable until a defensible request upper bound is verified under that approval.
No deployment, merge or restart of the user's stopped application is authorized by
this preparation alone.

The owner clarified the gameplay invariant on 2026-10-31: players and AI coauthor an
ongoing visual story. Initial author content is the world's opening and constraints,
not an exhaustive script or catalog of future locations/NPCs. Read
`docs/narrative-director.md`. Keep proposals separate from committed shared state,
private NPC/hero knowledge out of shared narration, and media grounded in the current
confirmed canon. The prepared Observatory remains an acceptance fixture, not a hard
story ceiling. Current delivery scope is the coherent player/NPC/visual loop and one
small adventure; automatic translation, Discord, payments and deployment are deferred.
