# Gameplay builder review presentation

The standalone `/studio/gameplay/[id]` page follows selected reference 26: a five-stage
progress rail, durable status band, wide real map preview beside the prepared world's
locations/characters/objects, and a separate review/apply row. RU, UK and EN copy is
complete, with the existing light/dark palette and a stacked narrow-screen layout.

All build state, restore/epoch, operation identity, pending locks, stale-source checks,
quote expiry, cost/receipt notices, explicit generation consent and reviewed image-reuse
application remain unchanged. The canvas is the same disabled real projection. Sidebar
labels, dimensions and public roles come only from the returned draft, using authored
label variants when present. No secret personality/knowledge fields, invented portraits,
reference world names, fake charges, generation calls or new API requests are introduced.
Back to editor is ordinary navigation; apply still neither publishes nor changes games.

This is a presentation slice, not complete 1:1 acceptance. The source response has no
reusable image bindings for sidebar thumbnails; neutral icons stay honest. The existing
canvas remains geometry-driven and is never replaced by decorative reference imagery.
Map editor, workshop, gameplay inspection and live-data acceptance remain separate.

The source contract suite is now wired into CI. Nine synthetic browser cases cover seven
RU/UK/EN desktop-dark/mobile-light and Russian tablet review captures plus loading, read failure/retry,
empty preparation, stale input, quote/explicit consent, unresolved outcome/reload,
review checkbox, repeated apply, source-bound payload and durable applied status.
All API responses in these browser cases are intercepted; there are no real paid calls.
Local formatting and source comparison only: no local test/build/type/lint/browser or
API/database execution. Fresh exact-head CI, Vercel and actual screenshot review are
required before merge. Disk capacity precludes local builds or full artifact extraction.

First exact-head CI rendered all nine new cases successfully. Actual screenshots found
that the standalone route lacked the shared heading's locale wrapper marker and that
repreparation became a full-width primary action in the new grid. The follow-up adds
the existing locale marker and groups unchanged reprepare/refresh controls as secondary
status actions. New heading-position and bounded secondary-action assertions retain
all previous coverage. Fresh full CI and screenshots are required after this correction.

## Consolidated continuation, November 5

The builder and character/location workshop presentations are combined with the
private-release test teardown repair on main `41d35bfb8f327072b5097f1a0b27d3198f9e5de3`.
The previously reviewed workshop correction uses the exact textbox role/name for
the retained brief assertions. The teardown waits for PostgreSQL client end events
after `pool.end()` and before stopping the disposable cluster, without swallowing
errors or changing assertions, retries or timeouts.

Integration retains the current main map-planning errors, unresolved financial-state
guards, exact accepted known-cost policy, explicit dispatch consent and settlement
refresh handler. Both current-main component controllers remain byte-identical;
all 12 builder and 42 workshop event-handler ASTs are unchanged. Every current-main
source-contract assertion is retained alongside the presentation checks.

The nine builder source-contract tests, changed JavaScript/TypeScript lint and all
13 changed files' repository-configured formatting pass locally. TypeScript syntax
parsing finds no errors in the two components. These bounded checks do not establish
full type/build, PostgreSQL or browser success. Current-head CI, Vercel and fresh
rendered evidence are still required; no paid call or manual deployment was made.

Independent integration review caught the newly available embedded Studio preview:
its builder must not add a second page-level heading, a link back to the same editor,
or the shared shell's desktop heading reserve. An explicit presentation-only embedded
mode keeps an h2 and a local header, while the standalone route retains its h1 and
Back link. Source coverage preserves autosave flush/apply callbacks; the existing
Studio browser journey now checks both 1536px and 390px and captures each header.
