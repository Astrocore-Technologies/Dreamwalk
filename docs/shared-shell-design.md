# Shared shell reference alignment

Scope: shared application rail, utility header and outer canvas. Based on selected desktop references 01/02/05/12/14/31/41/53/60/61, inspected as images. No changes to story data, account permissions, wallet accounting, generation, authentication forms or game content.

- Reuses the exact castle/crescent `AuthMark` proposed in the standalone authentication design change. That separate PR's auth-brand change must be retained when combining the branches.
- Removes grouped miniature navigation headings and the active dot. Larger icons and labels, a real Workshop route, profile entry and bottom rail preferences follow the selected composition.
- Global search remains a labelled keyboard-submittable form in the rail, including in the mobile drawer. It is not removed to reproduce an illustration.
- Flat page canvas replaces the scenic outer background and inset panel. On wide desktops, supported page headings and real utility controls share a reserved vertical band without overlapping. At narrower sizes utilities remain in their own responsive row.
- Keeps Dreams and Sparks, real account avatars with initial fallback, notifications, logout, existing guest sign-in/up and admin-only navigation. Reference balances and portraits are not application fixtures.
- Language/theme persistence is unchanged. Mobile drawer still closes on navigation, search, Escape and backdrop; keyboard focus is contained and returned, and widening to desktop closes the drawer. Existing bottom navigation remains.
- Gameplay and standalone authentication retain their separate layouts and preferences.

## Verification

Passed locally: workspace typecheck, repository lint, `test:unit`, full isolated API/PostgreSQL integration (successful sequential retry after a resource-killed initial build), and 17 focused shell/palette/wallet checks. Browser test discovery recognizes all three new journeys. The source contains 36 synthetic screenshots covering account/guest × 1536/820/390 × RU/UK/EN × dark/light, plus search/navigation, focus, persistence, avatar, admin, logout and shell-isolation assertions.

Local browser execution is blocked: installed Chromium aborts at `socket() failed: Operation not permitted`. No sandbox bypass attempted. The browser journeys and screenshots therefore require CI execution and rendered review; they are not claimed passed or captured locally. API/database integration passed separately; it is not inferred from UI tests.

This is a scoped design correction, not a claim of pixel parity or production validation. Real dual-currency/action controls necessarily differ from example mockups, and each separate page retains its own content and design work. No deployment or paid provider calls were made.
