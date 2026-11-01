# Cloud UI refinement — 2026-11-01

This is the isolated auth/profile/home/catalog/admin tranche, not completion of the broader Studio and gameplay request.

## Delivered behavior

- Registration asks for login, email and password. Existing registration storage receives `name = handle` for new accounts; historical names and handle URLs are not migrated. Profile/onboarding no longer request a separate display name; public identity uses handles.
- Home/catalog hide only the known bundled editorial stories by author-handle plus slug, without deleting fixture data or blocking direct URLs. User stories and story creation remain.
- Sidebar author promotion, NEW badge and Prototype navigation item removed. Footer slogan and game/save routes remain.
- Visible server-generation panel removed from admin layout. Financial enforcement, provider consent and internal accounting remain untouched.
- Private visibility badges do not claim private release readiness.
- Genre/tag pickers show one selected editor per category. Add is blank, unsaved entries can be discarded, empty searches are explained, existing identities are read-only.
- Genres gain additive IDs and translated labels. Existing genre/filter strings, seeds and custom values remain intact. JSON metadata preserves historical definitions, legacy PATCH bodies, and collision-safe legacy IDs. Metadata writes require a current revision; stale GET/PATCH and concurrent guarded saves are rejected. `/taxonomy` exposes only public taxonomy metadata; localization falls back safely when unavailable.

## Verification

- Workspace typecheck and root ESLint passed after the review fix.
- Production build passed; the review fix affected only API revision validation and was subsequently rebuilt and tested by integration/typecheck.
- Isolated PostgreSQL/API integration: **63 passed**, including legacy taxonomy, custom genres, metadata revision safeguards, concurrent saves, invitation acceptance/revocation and private media access.
- Focused discovery/auth/home/taxonomy/locale tests: **24 passed**. Dedicated taxonomy contract tests: **3 passed**.
- Changed files passed formatting and `git diff --check`.
- Five focused Playwright files discover **19 scenarios**; their automated browser runner was **not executed** in this managed environment. Actual browser QA used the provided cloud browser instead.
- Actual cloud-browser checks: three-field signup → onboarding → home; handle profile/bio save; empty demo-filtered catalog; picker search with no results, Close/reopen, selected genre ID/labels, translation save/reload, blank Add and discard, editable duplicate-ID draft, new genre save in UK/EN/RU, translated genre appearing in catalog filters. Visible missing language labels found during QA were fixed and regression-tested.

No external providers, real credentials, real-user records, invitations, publication visibility, laptop files, merge or deployment were changed. Browser mutations used disposable synthetic accounts/data. Browser screenshots remain internal QA artifacts.

## Explicitly deferred dependencies

- Story-local NPC editing and optional library templates; safe shared Studio handoff and storage/clone semantics required.
- Automatic authored-location-to-playable bridge and removal of manual map controls; gameplay writer owns the dependency.
- Dedicated private playable publication: current compile produces immutable test packages, not a designated released version. Existing ACL remains; an explicit release transaction/read model/launch selection is separate work.
- Sparks pricing: user requested configurable Sparks per million tokens, with rates still to be decided; no invented USD conversion.
- Legal/about/privacy content: separate factual/operator decisions and review.

The patch is prepared for a scoped draft PR only, not merge or deployment.
