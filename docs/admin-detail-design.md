# Admin users, content queue and review

## Scope and source

This presentation-only refinement follows the selected desktop references 42–44:
readable user rows, outlined roles and status, saved cover thumbnails, and a wide
two-column review with story content beside the decision and readiness controls.
The mobile review stacks these columns; tables retain a bounded horizontal scroll.
The existing dialog still supports Escape, Close and Cancel.

User avatars and story covers use only existing asset identifiers and the normal
server-authorized asset endpoint. Missing, denied or broken images use an initial
or icon, never an invented portrait or story illustration. No new art was needed.
Reference images and authenticated audit screenshots are not included. Browser
fixtures use synthetic accounts/content and an existing bundled image only.

The server's role/asset checks, moderation choices, reason constraints, immutable
version acknowledgement, pinned-art gate and stale-review behavior are unchanged.
Readiness uses the existing submitted-version inspector, not a fabricated checklist.
Its map/NPC/art controls remain outside the moderation form. Overview, other admin
pages, global shell and runtime/decision semantics are outside this change.

## Verification

Before publication: contracts and game-core builds, web TypeScript, focused ESLint,
8 locale checks, 27 existing game UI/Sparks checks, formatting and whitespace checks
passed. Playwright discovered all five synthetic browser cases. Independent source
review identified and corrected an overly broad test search locator; no application
source blocker was found.

The browser cases cover RU/UK/EN, desktop/mobile, dark and representative light
views, loaded and missing media, search, roles, cancellation/focus return, all
moderation choices, real readiness gates, compiled maps/NPC/pinned-art controls,
stale versions and a delayed save with duplicate-click protection. They attach
screenshots after fonts and relevant media settle.

Browser execution and exact-head build/integration checks are deferred to CI because
this executor cannot launch Chromium under its sandbox restrictions. Listing tests
is not a browser pass. Visual parity is not claimed until CI renders are inspected.
No real moderation, provider call, deployment or merge was performed.
