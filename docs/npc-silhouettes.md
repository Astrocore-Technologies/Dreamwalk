# Reusable NPC silhouette placeholders

Authored map NPCs have an optional explicit `npcPlaceholder` choice: neutral (default),
male, female, or crowd. This is visual presentation, not gender inference or gameplay
occupancy. Nothing is inferred from a name, role, description, or private character data.
Old saves and newly generated NPCs without the field use the neutral fallback.

Each category has three original bundled vector variants (plain, scarf, hat), selected
deterministically from the immutable NPC ID. Refreshing or renaming does not change the
variant. Twelve small renderer textures are created once and cleaned up on unmount.
No external assets, AI/image calls, new jobs, wallet operations, or migrations are involved.

An available bound portrait/animation overrides the placeholder. NPC names, click targets,
positions, movement, and creature footprint remain governed by existing scene geometry;
a crowd icon does not create multiple actors or enlarge occupancy.

The map editor offers a localized explicit category selector. Unique NPC art generation
is **not implemented by this change** and remains a separate future capability.

## Verification

- Schema/authoring compile, snapshot and public projection roundtrip; legacy default.
- Deterministic category/variant selection and independence from name/appearance.
- All twelve vector command streams are distinct; bound-art precedence and cleanup.
- `node scripts/render-npc-silhouettes.mjs /tmp/npc-silhouettes.png` renders the actual
  shared vector commands through an SVG/Sharp offscreen adapter at detail and actual
  medium/small/tiny token bounds. This is a source-art contact sheet, not a user screenshot
  or a substitute for the full Pixi browser tests.
