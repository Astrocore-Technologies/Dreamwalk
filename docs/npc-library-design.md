# NPC library and editor design alignment

## Scope

Aligns the NPC library and editor with selected desktop references 23 and 24. The
actual authenticated audit confirmed an empty library without the selected
illustrated header. Populated cards and the editor were not inspected in production
because creating an NPC would mutate real data. This change does not add sample NPCs
or invent saved portraits, secrets, balances or save states.

The library now has a decorative observatory banner, a compact Studio navigation and
create row, portrait-led cards, explicit missing-portrait placeholders and the real
empty/error/loading states. The editor has a large uncropped portrait beside identity
fields, grouped personality/biography/speech controls, a separate private-secret
column and an actual autosave status. The in-world appearance controls remain in an
expandable section with the same quote, consent and admission behavior.

Only the NPC components and their local helpers were extracted from `studio.tsx`.
Studio routes inject the existing navigation, avoiding a circular dependency. The
shared Studio dashboard, story editor, shell and asset library are not redesigned
here. The original story dirty-navigation hook remains in place. NPC server routes,
ownership, validation, revision checks, private fields, templates, upload/removal,
delete confirmation and manual save remain unchanged.

The design intentionally retains product features beyond the reference: source
language, adult-age validation, structured profile/package values, honest autosave
errors/conflicts, explicit portrait upload/remove, and separately consented in-world
art generation. The reference's sample identities and status text are not real data.

## Decorative art provenance

`apps/web/public/images/npc-library-observatory.webp` is original built-in image
creation output, generated under the owner's image-generation authorization. It is
2172 × 724 and 176,394 bytes. It is CSS-only decorative art, never an NPC portrait,
asset-library entry, provider request or campaign state.

Prompt: “Use case: illustration-story. Asset type: ultra-wide website banner art for
Dreamwalk's private NPC library. Create an original premium anime fantasy
illustration, landscape 3:1 composition. A serene observatory library at night,
richly painted wood shelves and antique books, golden brass armillary sphere at
center-right, tall arched window showing a violet starry sky and distant magical
castle, one adult silver-haired elf scholar wearing a dark indigo robe with delicate
gold stars, resting chin on hand at a desk on the far right, a small sleeping white
cat nearby. Warm lantern light, rich deep plum shadows, violet and muted golden
palette. Leave left 45% dark and visually quiet for white UI heading text. Art must
extend edge-to-edge, not a screenshot or mockup. No text, letters, symbols resembling
text, logos, borders, buttons, or interface. This is decorative site art only and not
an actual user NPC portrait.”

## Verification

- Passed locally: contracts and game-core TypeScript builds, web typecheck, focused
  ESLint (including repository-wide lint), formatting and 36 NPC-template, autosave, character, story-NPC and private
  authoring regression tests. New source/copy/art safeguards run in the existing
  NPC-authoring CI gate.
- Browser tests use intercepted synthetic accounts, NPCs and clearly labelled
  schematic portraits. They do not create accounts, upload files, call providers or
  mutate production. Coverage includes empty/populated/new/existing screens, RU/EN/UK,
  dark/light, 1536/1165/390 px, secret exclusion from cards, section switching, no
  writes on open/cancel, autosave revision/profile preservation, conflict retention,
  discard cancellation, delete cancellation and browser Back/Forward.
- Browser captures wait for fonts and decorative/portrait image decoding.
  Browser execution and screenshot review remain pending CI. Local Chromium is
  unavailable in this executor; no bypass or claim of a local browser pass is made.
- Full platform CI remains required. Deployment/merge is not part of this change;
  preview quota failures must not be retried or bypassed.
