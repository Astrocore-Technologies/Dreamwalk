# Sitewide design refresh

The shared shell and surface system cover discovery, story details, library, heroes, author studio (including NPCs, maps and media), account, wallet, authentication, notifications, static pages and administration. Existing domain controls and permission checks remain in their original components.

- Plum/ivory surfaces and gold actions share readable dark/light palettes. Theme is initialized before hydration from the existing device preference and remains saved to account settings for signed-in users. RU, UK and EN controls remain available at desktop and mobile sizes.
- Home has a cinematic approved-story feature, existing resume/hero flow, real popularity rail and genre rails. No mockup titles, counts or prices are seeded.
- Public cards/detail use API `totalRounds` and `likeCount`. Likes are distinct from saved stories and update through authenticated idempotent endpoints. Missing metrics are omitted, never fabricated.
- The game route has no global sidebar or mobile navigation. Map and narrative/composer use the full workspace; turn, character, room, inventory and accessibility controls remain available. The player-facing objectives list is removed without changing game objectives or NPC behavior.
- Authoring keeps every existing world, map, NPC, scene, safety, preview and publication step. Basic metadata and real cover controls sit side by side on wide screens. Duration is no longer edited/shown; stored values remain compatible. Public story-scope UI is omitted, author safety warnings are retained.

## Deployment dependency

Apply migrations `053_story_popularity.sql` and `054_dreams_accounting.sql` before starting the updated API. See `story-popularity.md` for metric definitions, privacy and ranking behavior, and `dual-currency-accounting.md` for the wallet migration and accounting rules. This PR does not execute production migrations or deploy itself.

## Verification

Shared palette tests enforce WCAG AA normal-text contrast for foreground/muted/accent text on the main surfaces and gold actions. Browser tests cover language/theme persistence, public and signed-in route layout, actual like/unlike persistence, draft action eligibility, tablet drawer visibility and sidebar-free desktop/mobile play. Existing end-to-end suites remain the functional regression gate for authoring, maps, game turns, account/admin, assets and paid-action confirmation boundaries. Screenshot artifacts use anonymous pages or synthetic test accounts, not private user data.

## Dual wallet

The wallet and header show Грёзы / Мрії / Dreams separately from Sparks, with real account-bound integer balances and separate history. New accounts receive 50 Dreams instead of the old 50-Sparks welcome grant; existing Sparks balances and history are preserved. No daily grant or currency conversion is introduced.

Both currencies cover the same supported generation uses at the same two-units-per-provider-cent rate. A quote shows an estimated Dreams-first split and an explicit maximum Sparks reserve if the free balance changes before confirmation. The original confirmation button authorizes the request; no additional payment click is introduced. Each atomic reservation and final receipt show the actual currency split, and unused reservations return to their original currency. Pending or unknown costs remain held for reconciliation. Provider consent, hard limits and fail-closed controls remain in effect.
