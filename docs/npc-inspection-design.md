# Public NPC inspection, reference 58

## Scope and visible differences

The approved 1536 x 1024 reference places the NPC portrait, name, public role, description and Talk action in the right column above the existing story composer. Current main instead renders a small 72 x 88 portrait with text beneath or over the map, omits the public role and has no direct Talk action in inspection.

This local presentation candidate moves inspection into the story history region, preserving its dimensions and mounted contents underneath an opaque, independently scrollable card. Closing restores the same history and reading anchor. The composer, recipients, whisper setting, confirmations and draft remain mounted. The normal Story heading remains above inspection; this deliberately preserves the existing panel structure rather than claiming full reference parity.

Only the current visible NPC projection is used. Role comes from publicProfile.role or supportingNpc.roleLabel; missing role is omitted. Description and appearance retain the existing public fallbacks. Portraits still require the exact authorized immutable binding. Missing portraits stay absent; no generated illustration, inferred identity, private source data or invented fallback image is added. Large real portraits use bounded cover cropping, which needs visual review on representative art.

Talk revalidates the visible NPC and changes only the existing recipient selection. It does not send a message, request a quote, change channel, fill text, start generation or move the actor. Existing draft/quote invalidation and queued submission identities remain unchanged. During some queued states local selection remains possible, as with map selection, but the disabled input is not focused. Close and Escape restore focus to history without scrolling the page. Selecting another NPC resets only inspection scrolling.

## Source verification

All seven modified existing source/test files match exact main 8670f1a10d40bee6078994a62bb1166bc5353012 before editing. The CampaignRoom pre-render controller is byte-identical (6,228 bytes), the actual visible-NPC/authorized-portrait derivation is byte-identical (330 bytes), and UnifiedStory's controller is byte-identical (12,199 bytes). Existing immutable-binding adversarial tests are retained; only their presentation assertion follows the extracted component.

Independent source review found a stale image-rendering assertion and retained overlay scroll when changing NPC. Both were corrected and re-reviewed with no remaining source blockers. Source comparison and formatting are not runtime verification.

## Pending acceptance

Prepared browser coverage extends the three RU/EN/UK chat-layout journeys: repeated inspection/Talk, no dispatch, draft and whisper preservation, Close/Escape and focus, incoming history while inspecting, reading-anchor restoration, short viewports with confirmations and mobile layout. Nine new captures are planned (desktop, short+confirmation and mobile for each locale). Existing director integration covers admitted portrait loading; existing assets tests cover denied/missing/mismatched bindings and invisible NPCs.

At the local source-preparation stage, no tests, lint, typecheck, build, browser, database or provider calls were run because the workspace had about 30 MB free. That stage did not commit, push, create a PR, merge or deploy; subsequent publication and remote evidence are recorded below. Full exact-head CI, actual screenshot inspection, queued-target and disappearing-NPC behavior, long public content, light theme and live authorized-data acceptance remain pending. This is not ready to merge and does not complete KAN-17 or KAN-16.

## First remote evidence and correction

Initial PR93 head dc0da471 passed production build, types, lint, unit/source tests, isolated PostgreSQL, browser shards 1 and 3 and automatic Vercel. Shard 2 failed the three extended chat-layout cases: all six attempts saw exactly one pixel of anchor rounding after the newly inserted 1024-to-1440 viewport roundtrip. The existing baseline already accounts for one-pixel reflow rounding in its resize section. The correction changes no tolerance: it removes only the redundant early resize, leaving exact inspection-only anchor checks and the complete original resize matrix (now also with inspection and confirmation open).

Actual admitted-portrait screenshot review also found the Talk action partly clipped at 1440 x 1000 with ordinary public copy. The portrait budget is reduced from 300px to 240px; composer and long-content scrolling remain unchanged. A boundary assertion now checks the full Talk action with at least 8px remaining below it in that real synthetic portrait journey. Both corrections were independently reviewed. Fresh exact-head CI and new rendered evidence are required; old successful checks do not transfer.
