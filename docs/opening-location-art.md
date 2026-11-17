# Opening location picture

A story written as a description plus a first message has no author-made locations. At start the
planner gets one generic opening location (`opening`, localized name «Начало истории») and the AI
chooses where the story begins and who is present from the text.

## Picture

The Studio step «Мир и история» shows a card «Картинка стартовой локации». It reuses the existing
Studio location image path unchanged:

1. `POST /image-generation/studio-locations/prepare` with `locationId: "opening"` builds the picture
   brief from the first message (or the description when there is none). The AI never asks the author
   to write a prompt.
2. The author sees the price once and confirms once (quote, explicit consent, durable admission,
   no automatic retry, immutable asset revision with rights) and the result is bound to the opening
   location (`studio_location_images`). Changing the description or first message makes the saved
   picture stale through the source hash.
3. The next story preparation passes the bound picture to the planner as the map image for `opening`.

The brief is a drawn 2D top-down battlemap illustration; it never defines collision or geometry.

## Switch: `STORY_OPENING_ART`

- `off` (default): players start on the temporary placeholder map.
- `required`: starting a description-only story without an opening picture fails with
  `409 OPENING_ART_REQUIRED` before any paid work. Stories with author-made locations and already
  compiled stories are unaffected. `GET /image-generation/config` reports `openingArt` so the Studio
  can tell the author.

## Limits and honesty

- External image dispatch is still disabled by project rules until a defensible request upper bound is
  verified and the owner separately authorizes it; nothing here changes that. Tests use the synthetic
  provider.
- The author pays, once per picture. Provider failures follow the existing recovery rules: an unknown
  outcome holds the reserve and is never retried automatically.
- Turning `required` on while image generation is unavailable makes new-style stories unstartable;
  enable them together.
