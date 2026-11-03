# Notifications and missing-page composition

Scope: selected reference13 notification hierarchy and reference54 missing-page composition.
The notification banner and missing-page forest are original generated decorative UI artwork,
not saved story assets or representations of real notifications. Notification rows show genuine
API titles, messages, localized invitation metadata and timestamps. No illustrative reference
story, author, private cover, update category or generated artwork is invented as user content.

The current API exposes individual read actions and at most100 visible notifications. This
slice retains those explicit per-row actions rather than adding a misleading all-notifications
bulk control. Pending IDs guard duplicate clicks; failures remain unread and can be retried.
Invitation navigation still opens the existing invitations tab. Server ACLs are unchanged.
The reference's wide story thumbnails are not fabricated: these notification payloads
have no authorized cover identity. Rows use honest category icons, so this is a deliberate
remaining visual difference, not a claim of1:1 parity.
Read/all/empty states are not fabricated; a loading error no longer shows an empty-success
message underneath. Unknown routes retain the existing client router and home destination;
this does not change HTTP404 behavior.

Two images were made through the built-in image-generation tool on2026-11-03, then compressed
without changing their composition to WebP. Prompts requested original polished hand-painted
anime fantasy art in violet/plum/gold, with no text/UI/logos:

- notification-observatory.webp (2172×724,183940bytes): wide moonlit observatory terrace,
  brass telescope, flower-vined arches, white-haired adult stargazer in a celestial cloak
  at right and dark negative space at center/left.
- missing-path.webp (1536×1024,228220bytes): cobbled forest path, antique lantern at left,
  distant moonlit castle/bridge at right, violet leaves, flowers/fireflies and dark center.

Verified locally: contracts/core build; changed-file lint/format;13 source/UI regressions.
Full web typecheck was attempted and killed by the executor (exit137), not passed. Browser
suite is synthetic and covers RU/UK/EN, both themes,1536/390px, image/font-ready screenshots,
read failure/retry/duplicate-click prevention, invitation navigation, empty/error, keyboard
home recovery and history. Execution and actual rendered review remain for exact-head CI.
No real account writes, paid/provider calls, moderation, deployment or merge were performed.
Shared shell is a separate draft. These page changes are not a sitewide1:1 acceptance claim.
