# Fixed battlemaps and creature footprints

New story plans, newly introduced narrative scenes, author templates and workshop
plans use **24 × 24 movement cells**, 48 world-render units per cell. This is the
same existing movement coordinate system, not a new D&D ruleset. The full extent
is 1152 × 1152 engine units, independent of viewport size and zoom. The current
square **1024 × 1024** provider profile remains sufficient; no new model, quality
level or cost profile is selected here.

Small places occupy part of that extent rather than being enlarged: for example,
a lake at the center with surrounding cave. Grounded generation prompts describe
that composition. The renderer draws a straight mandatory grid independently of
terrain/art visibility, beneath characters. There is no disable option. Raster
art always preserves aspect ratio. Pictures do not define collision: validated
spatial plans and engine geometry remain authoritative for walls, doors and exits.

## Creature sizes

| Size                    | Occupied cells | Maximum visual extent (cells) |
| ----------------------- | -------------- | ----------------------------- |
| Tiny                    | 1 × 1          | 0.4                           |
| Small                   | 1 × 1          | 0.6                           |
| Medium / legacy default | 1 × 1          | 0.85                          |
| Large                   | 2 × 2          | 1.7                           |
| Huge                    | 3 × 3          | 2.55                          |

Validated `tokenSize` is independent of image pixel dimensions. It is proposed by
the story/NPC planner from public appearance and editable in the playable NPC
editor. An unspecified size defaults to medium; portrait/sprite and existing
avatar fallbacks share the same bounded layout and hit testing. The entity anchor
is the top-left occupied cell; art is centered within its complete footprint.

Pathfinding, movement, wall/door collision, spawn and destination checks, door
closing, contact range and pushes respect occupied cells. Large creatures cannot
fit through one-cell corridors. Contact distance is between nearest occupied
cells. Coordination regions expand to contain complete intersecting creatures.
Damage, action budgets, initiative and turn timing do not change. Acoustic reach
keeps its existing topology-based six-cell rule and anchor origin; this change
does not introduce a new sound radius.

## Existing saves and artwork

The author-save API enforces the fixed extent for new and resized map IDs; a
legacy map may keep its existing dimensions while its other content is edited.
Existing saved maps, coordinates, topology and immutable versions are not resized
or migrated. Legacy maps up to 24 cells are displayed on the standard extent;
rare older maps larger than 24 retain enough display extent to avoid clipping.
Existing raster assets are contained without distortion, and cannot invent missing
surroundings. A newly built plan uses the fixed map policy; legacy author `mapIntent`
remains readable as focal-location context rather than a canvas-size override.

No provider calls, production updates, paid generation or deployment are performed
by this change. Tests use synthetic transports and isolated local databases.
