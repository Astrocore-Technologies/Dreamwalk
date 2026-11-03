# Anime generation defaults

New image prompts use a shared detailed drawn-2D anime default. Character art uses
clean line art, soft cel shading, expressive faces and painterly lighting. Covers
use cinematic key art and detailed characters with painted scenery, without
lettering. Location/map art uses painterly scenery with clean readable shapes.

The owner's ISEKAI ZERO catalog screenshot (2026-11-03) is the primary visual
reference: richly illustrated anime story covers, detailed costumes and dramatic
lighting. The reference is art direction, not permission to copy characters,
branding, interface, or copyrighted cover images. Public reference checked:
https://www.isekaizero.ai/ and the developer's screenshots at
https://play.google.com/store/apps/details?id=com.isekai.world .

These are editable prompt seeds and fallback styling, not a new mandatory asset
format. Explicit author art styles take precedence. Existing images, references,
asset rights, binding and reuse are unchanged. No default is appended after
quoting or dispatch, so consent and request hashes describe the actual prompt.

Battlemap camera, map framing and authoritative geometry remain unchanged. New
maps remain square 24x24; existing legacy map framing is preserved. The renderer
owns the cell grid, collision, entities and interaction overlays. Anime art does
not turn maps into perspective character illustrations or generate their grids.

`defaultImageStylePrompt` is exported by `@dreamwalk/contracts` for all prompt
builders, including the separately implemented story-cover flow. No provider
call or existing-image regeneration is needed to apply these defaults.
