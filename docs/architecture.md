# Architecture

## Shape and trust boundaries

A modular monolith: **Next.js** owns presentation/routing; **NestJS** owns authorization, validation, persistence, catalog, studio, moderation and demo accounting. Next forwards `/api/v1` to Nest; it does not duplicate domain logic. PostgreSQL is authoritative. Shared public-safe Zod contracts live in `packages/contracts`; SQL constraints/migrations in `packages/db`.

Cookie sessions are opaque. The database stores hashes, never raw session tokens. Passwords are salted and hashed, not reversible. User identity and role are read server-side, not accepted from request bodies. Mutations validate Origin to mitigate CSRF; protected ownership is enforced in every content/media endpoint. Admin is a database role, not a hidden frontend button.

## Entities

- User, Session, settings, Notifications and account requests: durable account and preferences.
- Adventure and immutable published versions: authoring metadata and typed JSONB content. Location definitions and SceneDefinitions are nested but separately identified and validated. Published catalog views never expose another author's draft.
- PlayerHero: a player's persona. NPC: author-owned definition, with secrets excluded from public projections. Neither is a behavioral model or runtime configuration.
- ModelProfile and versions: Green Apple/Cookie delivery style. RuntimeProfile: provider/model/capability/limit configuration. Non-mock execution is disabled. Endpoint identifiers are allowlisted, not arbitrary URLs.
- Asset: owner, MIME/dimensions/storage/provenance. Uploads are bounded raster formats, decoded/reencoded, and served only through ACL.
- Wallet/LedgerEntry: integer demo credits, unique source keys and transactional mutations. Ledger is append-only; correction is a compensating entry. Client amounts are not trusted for purchases because there are no purchase endpoints.
- ModerationReport, Audit: administrator decisions have reasons and attribution.

## Internationalization

Three supported interface locales: `uk`, `en`, `ru`. Localized presentation includes accessible names, validation, loading/error/empty, admin and legal/help. Guest preference is local; authenticated preference is persisted. API codes and notification identifiers are stable; UI translates them. Dates/numbers use Intl. Adventure text, names, biographies and other user content remain as written.

## Current execution and cost boundaries

All AI is mock configuration; no external AI request path runs. Payment and Discord flags are false, spend cap is zero. Unsupported live flags fail startup. Wallet is labeled **demo**, not a purchased asset or real money; admin test adjustments are restricted and audited. The platform prepares adventures and heroes. A separate explicitly identified observatory prototype is being added under the approved G0–G3 scope; existing stories without a playable map do not become playable automatically. No paid image generation service or checkout is enabled.

## Approved hybrid game architecture (local implementation in progress)

A separate deterministic rule core resolves typed intents. AI may propose bounded actions and narration; the server validates knowledge, references, permissions and rules before any commit. Campaigns will pin published versions. Layered visual assets and HTML alternatives will preserve scene accessibility; client rendering will not grant permissions. Durable operations will separate short database transactions from external calls: validate → reserve → execute outside transaction → persist/capture → outbox. All side effects must be idempotent; no end-to-end exactly-once guarantee. Discord instances will map to persistent campaigns, never be their identity or ACL.

## Assets

Original bundled cover art is in `apps/web/public/images`, with hashes/provenance in `assets/demo/manifest.json`. No borrowed franchise images. Uploaded assets are separate, private by default, and excluded from Git. Local filesystem storage is a development implementation; public deployment needs explicit storage/retention/backup setup.

See `docs/api-contract.md` for routes, `docs/decisions/` for decisions, `docs/runbooks/` for operations, and `docs/progress.md` for actual verification rather than intended behavior.

## Owner update: two publication modes

The later owner instruction supersedes the source specification's unlisted option. Adventures have exactly two visibility choices: **private, invitation-only** or **public, moderated**. Internal draft/review/published/archive lifecycle is separate from visibility. Private access belongs to the author and accepted invitees only, including detail, library and attached images; acceptance never grants editing, and revocation removes future access. Merely knowing a URL is never authorization. Public changes preserve the old approved snapshot while the new draft is reviewed. Moving public content to private withdraws it; moving back requires a new approval.

NPC definitions and secret notes remain author-only; invited/public readers receive a safe preview. Downloaded copies cannot be retroactively erased, so private asset responses should not invite caching. Administrative content listings must not become an unintended private-content bypass.

## Metadata localization, without automatic AI

Authors write the original title and synopsis once and may identify their source language. Adventure metadata stores `sourceLanguage`, a server-owned `sourceRevision` and optional locale variants. The interface uses a valid preferred-locale field when present, otherwise the original field. Full story/NPC text is not translated. Curated demo metadata has three-language variants. There is no required translation wizard and no provider/job claiming work has been completed.

Changing the original title, synopsis or source language advances the source revision; stale translated fields are not served to readers. An explicit correction/reconfirmation endpoint checks the expected revision and creates a new draft. Ordinary full-form saves cannot silently reconfirm old translations. Published snapshots include the approved metadata variants, and pending edits never replace them before moderation. Automatic provider translation remains a later, explicitly enabled integration.

See [ADR 001](adr/001-hybrid-rpg.md) and the full [approved hybrid plan](hybrid-rpg-architecture.ru.md). The implementation status and actual checks are recorded separately in progress.md; the architecture is not evidence of completed behavior.
