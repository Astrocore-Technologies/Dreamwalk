# ADR 001: platform first, server authority, no MMO

**Status:** accepted for P0–P4.

Dreamwalk is a platform for independently authored, versioned adventures and individual campaigns, not a shared MMO world. Deliver accounts, discovery, creation, moderation and preparation before game runtime. No canvas/AI NPC conversation is needed to call the platform useful.

NestJS is the sole domain authority. Next renders public-safe contracts. Browser state never grants role, ownership, wallet credits or publication status. PostgreSQL constraints supplement service validation; they do not replace authorization.

Future campaigns pin immutable published versions. Later editing produces a new draft, not changes to ongoing saves. Discord instance/guild IDs will be launch associations only, never identity or access proof. Standalone and future Discord shell share the same persisted core.
