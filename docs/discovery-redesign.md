# Discovery redesign — local review candidate

The owner approved a redesign of home, catalog and story detail after comparison with Isekai Zero. The owner subsequently authorized inclusion in the full follow-up PR after final checks. This document does not itself assert remote publication or deployment.

## What changed

- Home features an actual published story, author, synopsis and its real safe NPC names. The Observatory is editorially selected when present; otherwise the first available public story is used. No invented popularity or continuation state.
- Catalog has one search, compact genre/sort controls and four character-led portrait cards on desktop (two on narrow screens). No duplicate marketing intro. Filters expose their selected state.
- Story detail puts cover, synopsis and preparation/save actions first. NPC introductions precede world text, sections use simple dividers, and version history is a native collapsed disclosure.
- Plum, pearl and gold remain, with the existing light-theme tokens. UI text is present in Ukrainian, English and Russian. Authored content uses revision-aware metadata/fallback logic. A subsequent owner request adds translated controlled/custom tags and NPC public text: names, roles, descriptions and greetings. Curated demo variants are stored, while missing/stale custom translations fall back to original text. No automatic translation provider is falsely claimed.
- Gameplay remains explicitly disabled. Private notices, invitation/owner actions, report handling, favorite persistence and asset URLs are preserved.
- Original conceptual poster artwork applies only to four seeded story slugs when no uploaded cover is set. Existing images are retained, and library/creator cards keep their previous appearance. See `discovery-art.md` for provenance.

## Verification

Actual managed CUA browser, same local preview and preserved development database:

- Desktop around 1165 px: home, catalog, detail; light Russian detail; English and Ukrainian interface and metadata.
- Separate native browser window, content width 491 px: all three discovery screens, no document horizontal overflow. No device emulation or alternate browser.
- Query → empty state → reset; genre filter; sort control; featured-story link; favorite add → reload persisted → remove; report dialog open → Cancel; versions expand; mobile drawer open → Escape → navigation.
- Found and corrected a narrow synopsis/cover overlap during visual QA.
- Production build, strict typecheck and 24 contract/config/locale unit checks passed. Focused ESLint on modified TSX passed. Full workspace lint initially reported an unrelated in-progress data-request test import; final aggregate status belongs to the platform lead.
- The visual redesign itself does not change backend ACLs. The subsequent localization addition uses shared safe selectors and backend snapshot revisions implemented by the platform team. The platform lead runs the combined API/database regression suite alongside remaining platform work. No claim of browser invitation re-authentication or public deployment is made here.

Screenshots are local QA artifacts outside published source, in sibling directory `dreamwalk-redesign-evidence/`: desktop home/catalog/detail, narrow home/catalog/detail, and light detail. They show a disposable synthetic QA account, not production user data.

## Additional localization integration

`selectNpcText` is used in featured cast, story detail, Studio NPC selection/library and administrator reader. Original NPC editor fields remain original, with source-language selection and an optional public description; no mandatory manual translations. Detail tags use `selectAdventureTags` with current controlled tag definitions. These changes use server-provided safe metadata and do not expose NPC secrets. Final combined checks and post-migration browser evidence are recorded by the platform lead.
