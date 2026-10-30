# ADR 003: visual layers and durable persistence

**Status:** platform assets in place; game rendering deferred.

Future scenes use layered backgrounds, NPCs and interactive entities, not a regenerated flattened image for every interaction. PixiJS will render in the browser; HTML will supply accessible controls and alternatives. Rules and ACL remain server-side. Returning to a location reuses existing scoped assets.

For the platform, original raster cover art is bundled with provenance. User uploads are validated, pixel-bounded and reencoded. Resource identifiers are not an access grant; requests check owner or published attachment. No arbitrary SVG/HTML or remote URLs are executed.

PostgreSQL stores accounts, metadata, published snapshots, financial invariants and audit. Flexible adventure content uses typed JSONB; ownership, unique operations and versions use explicit SQL constraints. Future Discord launch IDs never replace persistent campaign IDs. Local file storage is not a production durability claim; database and resources must be backed up together.
