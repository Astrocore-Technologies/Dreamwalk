# Closed-test legal reading layout

Presentation-only adaptation of desktop references 51 (Terms) and 52 (Privacy).
The references contain placeholder copy that is not authority to replace the reviewed
closed-test drafts. The existing document titles, draft label and every paragraph in
all three locales remain sourced verbatim from `closed-test-legal-copy.ts`. No operator,
contact, dates, agreement, consent or new policy claims are introduced.

Terms uses an illustrated introductory notice and illustrated reading rows. Privacy
uses one inset panel, a prominent introductory notice and icon-led reading sections.
Native expandable contents, focusable anchor targets, a return-to-top link and links
between the documents add navigation without adding legal content. `/content-policy`
continues to alias `/terms`. Help, About and fallback rendering remain untouched.

The longer reviewed paragraphs deliberately make these documents taller than the
reference placeholders. Existing original city/observatory/forest art is reused;
it is not an exact recreation of the reference's telescope, books or terrace art.
The shared shell is outside this change. Do not call this pixel-perfect parity.

## Verification

- All four closed-test legal source checks passed, including new LegalPage wiring,
  escaped-text rendering and no consent or side-effect handlers.
- Browser preference setup supports both visible controls and the shared mobile drawer.
- Focused ESLint passed for both changed TSX components and the browser spec.
- Prettier passed on changed files.
- Playwright discovers four tests. The byte-for-byte source assertion passed locally.
- Source SHA-256: `bd0eed2e38d3b4795c1b6a5a7b642ad437844f9adfe4f13315632697b6457435`.
- Three synthetic guest browser scenarios cover RU/UK/EN, light/dark, 1536/390 widths,
  every rendered paragraph, long text overflow, native TOC keyboard focus, fragment
  back/forward, document navigation and the content-policy alias. Each scenario
  prepares image/font-ready full-page captures (24 total across the matrix).
- Browser rendering is pending exact-head CI; these captures have not yet been made
  or inspected. Local browser execution was not retried because the executor's
  existing browser limitation was already established by the parent task.
- Full type/build/API/database suites were not run locally for this presentation-only
  change; the shared executor is resource constrained. CI remains the acceptance gate.

When integrating Help/About PR75, update its content-policy assertion from the old
`.static-prose` selector to `[data-legal-page="/terms"]`. Keeping that legacy CSS class
would reapply the old maximum width and paragraph styles to the new layout.

## First exact-head render review

Initial head `0784cdd` passed all four legal browser checks on the first attempt
and produced 24 captures. Full matrix inspection found a light-theme Terms hero
contrast issue from inherited global paragraph color. The legal hero now explicitly
sets its text color, and the browser matrix asserts that foreground in both themes.
Final synchronized-head CI and screenshots must verify this correction. No local
tests were run during or after main integration.
