# Reviewed design integration, November 3

Combines the independently source-reviewed account/admin, heroes, authentication,
Help/About, Studio hierarchy, Library/Wallet, navigation, NPC library, admin review,
catalog/creator, legal and admin-tool slices. Notifications/missing-page PR85 is
already merged in main 1c38bd6. Original draft PRs stay open until the combined result
is independently checked and all exact-head checks, including Vercel, succeed.

Integration preserves both imports and locale entries, separate hero/wallet CSS
modules, the shared AuthMark, NPC extraction, genuine data fields and legal copy.
The Help content-policy check follows the new Terms root. Mobile design suites use
actual drawer preferences, close the drawer, and assert its closed state before
capturing the page. No API/provider/payment/security or deployment change.

## CI scheduling

PR87 run 41731720347 completed 107 shard 2 tests successfully in 17.3 minutes. Its job
was cancelled after 20 minutes 6 seconds while uploading/cleaning up; timeout is inferred
from the boundary, not explicitly logged. Shard 1 completed 71 tests in about 8 minutes.
Prior scheduling weights undercounted several slow files and new screenshot matrices.

Three isolated browser shards are the minimum under updated conservative scheduling
estimates: approximately 1025/1010/1020 seconds before the new Studio-inner suite,
versus 1530/1525 for two. Four shards would add unnecessary setup cost before measuring
this result. New matrix timing estimates are explicitly provisional. Existing test
and job timeouts/retries, one worker, isolated PostgreSQL/assets, every discovered
file exactly once and the all-success aggregate remain intact. Skipped/cancelled/
missing checks cannot pass. First actual combined CI must validate runtime headroom.

The workflow received independent source review. Seven local hosting tests verify
partition coverage, isolation, build mode, unchanged ceilings and aggregate gating.
No browser tests were executed locally; no production build was attempted here.
Web TypeScript was killed by this executor. Focused source/lint checks are not a
replacement for full exact-head CI and actual combined screenshot review.

## Still unverified or unfinished

This integration is not sitewide 1:1 acceptance. Ref59 expanded hero selection and
Studio inner NPC/lore are now included after independent source review; their fresh
browser/render checks are still required. Workshop/map and gameplay surfaces remain
separate work.
Real authored content cannot exactly match illustrative mockups and is never replaced
with invented story data. Empty states and unavailable metadata remain honest.

## Local final checks before the first integration run

The combined checkout discovers 231 browser tests in 61 files. All changed JavaScript
and TypeScript files pass ESLint. Fifty-seven applicable source/hosting checks pass
with no skips. The separate synthetic authoring browser harness was also attempted
but refused to run without disposable local services; its database/browser checks
remain CI work, not a local pass. Full web typecheck was killed with exit 137.
New Studio and story-detail source fixes received independent review before inclusion.

## First combined run and reviewed follow-ons

Run 41736837819 at head 1b24332b passed production build, all type/lint/source checks,
isolated PostgreSQL, and browser shards 1 and 3. Browser totals were 229 passed and
2 failed. The failures were a real missing report-focus restoration and a test race:
a global alert matched Next's route announcer before the intended API error arrived.
The retry label was correct. Scope error assertions and the retry action to the main
content error box; preserve all timeouts, assertions and launch behavior.

Actual browser durations were 11.4, 14.3 and 12.6 minutes. Entire jobs completed in
14.0, 17.0 and 15.4 minutes respectively, including the two failing test retries.
This supports three shards without increasing ceilings or reducing the suite.

Combined pixel inspection found an untranslated INVALID_DRAFT error after the
existing invalid-save journey. The fix leaves that case to the existing localized
autosave status and invalid-item markers; ordinary errors still surface. A test
executes the actual save handler, and all inner-editor captures now reject the
translation-missing placeholder. New exact-head captures are required.

Independently reviewed follow-ons add owned hero selection cards with actual
localized story summary and an accessible focus fallback, plus story NPC/lore
master-detail presentation. The authoritative launch controller, private NPC fields,
complete editor drafts, schema validation, CAS writer and paid consent remain intact.
Hero selection only changes selection and closes; it does not start or dispatch.

After combining these fixes and slices, 77 focused source tests pass with no skips;
changed files pass lint/format checks. Playwright discovers 239 cases in 62 files.
Browser execution and full types/build remain exact-head CI work, not a local pass.

Independent combined screenshot review also caught model-save feedback below the
long dialog viewport after a guarded Close action, and an untranslated known genre
in admin content rows. The local fixes focus/reveal only the model error and use the
existing taxonomy helper; new viewport and locale assertions retain draft/payload
checks. No schema, access, provider, payment or deployment behavior changed.
