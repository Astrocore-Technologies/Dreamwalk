# Round actor tokens and the compact art window

Characters on the positioned game map are drawn as a round frame with the face in the
middle instead of a small full-body sprite. Tapping a character opens a compact art
window over the map. This is presentation only: positions, footprints, occupancy,
movement rules and server authorization are unchanged.

## Map token

- Ring colour shows the role: you (gold), other players (teal), NPCs (violet).
- With an authorized portrait (`entity:<id>:portrait`) the token shows that portrait,
  cover-cropped to a square (centred horizontally, biased to the upper part for tall
  images). Without one it shows a neutral bust in the role colour.
- Players' hero portraits are not in the pinned art manifest unless the hero has a visual
  character package. A plain saved portrait is fetched from the authorized per-actor
  endpoint (`/api/v1/game/campaigns/<id>/actors/<actorId>/portrait`), which the server
  checks for membership, actor visibility and takedown on every request. The renderer
  decodes it into a small bounded canvas, rechecks it every 60 s so a withdrawn portrait
  or revoked access does not linger, and falls back to the bust on 404. The art window
  shows the same endpoint image and falls back to the bust if it fails to load.
- One small canvas texture is created per role and pinned portrait revision, and is
  destroyed with the renderer. Pinned manifest portraits pass the existing texture budget
  (bounded concurrent decodes, 8 megapixels, 512 px display side); endpoint portraits are
  limited to four concurrent requests and a 256 px decoded side.
- The frame is drawn and hit-tested 1.3 times larger than its cell around the same
  centre (`TOKEN_DISPLAY_SCALE`). The server footprint is not changed. This is the
  tuning knob if tokens should be larger or smaller; map zoom is separate.
- Full-body bound sprites and walk animations are no longer used for actors on the
  map. Items, doors and exits are unchanged.

## Art window

- Tapping an NPC, another player, or your own token opens the window. Items and exits
  still open the action menu; the right-click and the "…" actions menu are unchanged.
- It shows the authorized portrait (or the bust), the name and role, and for an NPC
  who can act, **Talk** and **Inspect**. Inspect opens the existing full card; Talk does
  what the card's Talk button does (selects the recipient in legacy/location mode and
  focuses the composer).
- Tapping an NPC no longer opens the full inspection card by itself in turn mode, so
  the story feed and composer stay available. The window closes with its close button,
  Escape, a tap elsewhere on the map, opening the actions menu, or opening the card.
- Tapping your own token only shows your art; it never moves you.
- Hidden or absent actors never get a window or portrait: the portrait slot is admitted
  only for actors present in the current projection (`art-visibility.ts`).

## Verification

Run locally on 2026-11-07 against a throwaway local PostgreSQL cluster (no production
data or credentials):

- New unit tests `tests/game/actor-token.test.mjs`, updated `assets-ui.test.mjs`
  (portrait admitted only for visible actors), plus the related UI, geometry and
  locale tests, strict web typecheck, ESLint and Prettier.
- New browser spec `tests/e2e/game-actor-art.spec.ts` (legacy and turn mode, and a
  touch tap on a 390 px screen) and the updated location-art spec, run in Chromium.
- Contact-sheet and in-game screenshots were inspected by eye.

Not verified: a real uploaded portrait inside the live Pixi canvas (the synthetic
portrait was only drawn in an isolated page), production deployment, other browsers.
Final exact-head CI is still required.
