# Help and About visual alignment

Scope: public `/help`, its `/support` alias, and `/about`. No account, authentication,
admin, story content, runtime provider or deployment changes.

References: owner-selected `53-help.png` and `50-about.png`, inspected as actual
1536 × 1024 images. New decorative artwork was generated with the built-in image
tool on 2026-11-03 using those references, then inspected and resized to WebP.
No paid runtime provider was used. Assets are decorative, not real users or stories.

## Artwork prompts and outputs

All prompts requested polished drawn fantasy illustration, violet/plum shadows,
ambre/gold light, no UI, lettering, watermark or frame.

- `help-library.webp`: 3:1 panoramic magical library, dark negative space left,
  arched starry window, floating castles, lantern, open book, quill and armillary
  to the right. Reference: Help hero.
- `about-observatory.webp`: 3:1 observatory panorama, ivy arches left, distant
  bridge and floating castle, Milky Way, lavender moon, brass telescope near
  center-right, curved glass roof, armillary, lanterns and books. Reference: About hero.
- `about-stories.webp`: square white cat on moss-covered arch in sunlit ancient
  ruins, red maple leaves, gold archway, ivy columns and turquoise foliage.
  Reference: About left editorial image.
- `about-authors.webp`: square author desk with character sketchbook, quill,
  glowing lantern, stacked books, ivy and window to violet sunset castle.
  Reference: About right editorial image.

Source PNGs remain in the task workspace. Delivered assets live under
`apps/web/public/images/`. No reference screenshot or generated interface is used
as a replacement for live semantic controls.

The existing closed-test paragraphs, AI caveats, publication/rights cautions and
unknown operator statement remain verbatim in all locales. They make About taller
than the illustrative reference. Help destinations and support limitations remain
unchanged. Shared guest shell controls are outside this change.

## Verification

`tests/e2e/help-about-design.spec.ts` runs automatically in the existing CI browser
shards, covering guest routes, all three locales, both themes, 1536 × 1024 and
390 × 1024, image decoding, overflow, minimum link height, editorial arrangement,
legal-route navigation/back and screenshots (24 total). CI evidence is required
before declaring verification complete. This is not a pixel-perfect parity claim.
