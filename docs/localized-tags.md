# Controlled and custom adventure tags

`GET /api/v1/tags` returns controlled definitions `{id,labels:{uk,en,ru},aliases}`. Adventure `tags` remains a string array: new controlled selections save stable IDs; historical values resolve through preserved aliases; unknown custom tags remain exact source text. Migration009 converts the existing registry without removing existing custom values. Curated labels cover historical first-party tags in all three languages. Legacy administrator-defined terms retain their original text until an administrator supplies localized labels, rather than pretending machine translation ran.

Administrators edit all three labels, add new definitions with stable IDs, and cannot remove existing IDs or aliases that old content may use. IDs and aliases cannot ambiguously resolve to different tags. Changing a display label does not rewrite authored or published story content.

Optional custom tag corrections use the existing owner-only `PATCH /studio/adventures/:id/translations/:locale` with `{expectedSourceRevision,tags:{"original custom tag":"translated label"}}`. Keys must be exact current custom source tags, never controlled tags; up to12 bounded labels are allowed. Authors write once; translation is not a required wizard step, and no automatic translator is connected. Source tag changes increment the same metadata revision as title/synopsis changes. Stale translations stay in author storage but are excluded from reader DTOs and display. A partial correction never silently reconfirms other stale fields.

The shared `selectAdventureTags(adventure,locale,definitions)` resolves controlled labels and valid per-story custom translations with per-tag original fallback. Approved public snapshots remain unchanged until a new moderation approval; moderators can inspect both original custom tags and submitted localized alternatives.

Tests: shared contract cases and `tests/platform-tags.test.mjs` cover IDs/aliases, original fallback, stale revisions, key validation, ownership-protected correction routes, public snapshot isolation and registry collision/removal rejection.
