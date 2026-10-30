# Dreamwalk

Platform first: finish P0–P4 before gameplay G0. Read docs/implementation-plan.md and docs/progress.md.

- npm workspaces, strict TypeScript, Next.js UI, NestJS is sole business-logic owner, PostgreSQL.
- Russian UI, English identifiers. Brand: Dreamwalk.
- Preserve ownership/role checks on server. Never expose session hashes, NPC secrets, credentials or private content.
- No paid AI, payment processing, Discord integration, public deployment or repository publication without owner approval.
- Demo wallet is not money. Append-only ledger and idempotent mutations only.
- Validate all input; don't render user HTML. Raster-only bounded image upload.
- Run typecheck, lint, API/database tests and applicable browser tests before handoff. Never claim unrun checks passed.
- Keep root package-lock.json as sole dependency lock; no parallel backend/package manager.
- Do not commit .env, local database, upload files or test output.

Commands and configuration: README.md. Contracts: docs/api-contract.md. Architecture: docs/architecture.md.
