# Library and wallet composition alignment

Reference pixels inspected: selected desktop 05, 06 and 12, plus authenticated audit screenshots library/library-own/wallet/wallet-history from 2026-11-03. This slice only changes Library and Wallet UI. Shared shell, Heroes and Studio remain separate work.

- Library retains all six functional categories, counts, loading/error/empty states and explicit invitation responses. Tabs use a unified band with a separate discovery action row. Private-world invitations show only authorized invitation metadata: the current contract has no cover/avatar, so neither is fabricated or fetched before acceptance.
- Owned story cards use an actual uploaded cover when available; without one they use a neutral icon, never a generated representation of the story. Existing localized titles, badges and Studio links remain intact.
- Both actual Dreams and Sparks balances and reservations appear before either history. A newly generated silver-haired observatory guide holding a golden spark is purely decorative, generated using the authorized built-in image tool. The two Dreams presentations share one fetched state, preventing a separately polled balance/history disagreement. Exact accounting values, signs, unavailable placeholders and pending reconciliation labels are unchanged. No payment, grant, generation or implicit invitation action is added.
- Separate histories keep real ledger kinds. No completed-status column or transaction portrait is invented because the source does not provide them.

## Validation

Focused wallet/locale tests: 16 passed. Aggregate typecheck/lint attempts were killed by the environment (exit137); the earlier dependency-link issue was corrected using this worktree's own workspace package links. Focused web TypeScript check and ESLint on both changed TSX files and the new browser suite passed. Full API/database integration was not rerun for this UI-only slice.

The synthetic Playwright suite covers RU/UK/EN, 1536/390, light/dark, screenshots, six reachable tabs, both balances before histories, exact ledger precision, no writes while browsing, explicit accept and unavailable balances. Local Chromium could not start because Unix sockets were restricted; the escalation bootstrap itself failed on a read-only runtime mount. No browser screenshot or pixel-parity pass is claimed. CI runs the suite and uploads screenshots with existing artifacts.

## Remaining parity gaps

This is composition alignment, not pixel-identical reproduction. Six live tabs differ from the reference's five. Genuine empty states replace fictional reference content. Invitation imagery is unavailable in the invitation contract. Wallet retains two currencies rather than the reference's one, and uses an original decorative character banner rather than pretending this is a user avatar. Shared shell is intentionally untouched. No preview retry, quota bypass, paid upgrade, merge or deployment is performed.

## Decorative artwork provenance

`apps/web/public/images/wallet-starlight.webp` was generated on 2026-11-03 with the built-in image generation tool, then encoded as WebP. No runtime provider call or paid API was used. Original generation output: `exec-58fac1cc-ed9d-4d3d-b465-38bbb2494853.png`.

Prompt: polished hand-drawn anime fantasy decorative wallet banner, silver-haired adult elf scholar in midnight-violet gold-embroidered celestial cloak holding a tiny luminous golden diamond spark, ancient observatory arches and brass astrolabe, distant castle beneath a violet starry sky, autumn vines. Character on far right, quiet dark plum negative space across left two-thirds for real balance columns. Warm gold lighting, crisp linework, painterly finish, wide cinematic framing. No text, numbers, UI, logo or border. Fictional decorative guide, not a user portrait or story cover.
