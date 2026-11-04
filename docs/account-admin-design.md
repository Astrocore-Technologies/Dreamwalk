# Account and admin visual alignment

First scoped implementation from the authenticated production audit of 2026-11-03.
References: selected desktop account31–34 and admin41 mockups. New decorative art
was generated with the built-in image tool using those approved mockups as reference,
then saved as WebP. It is never used as a user's avatar or authored story content.

Assets: account-castle (moonlit bridge/castle), account-observatory (telescope terrace),
account-envelope (verification letter/arches), admin-library (fictional scholar),
admin-explorer (fictional explorer). All assets are bundled locally, with no runtime
external image provider calls. Original prompts requested standalone illustration,
matching the reference palette/composition, with no UI/text/buttons.

Account layout now includes the selected illustrated side panels and verification
banner, larger fields/type, icon tabs, readable browser/platform labels, and responsive
stacking. Profile initials remain truthful for accounts without uploaded avatars.
Privacy export/deletion and security actions retain their original handlers and guards.
Admin overview restores two illustrated cards. Shared visual adjustments are scoped to
account/admin, leaving authoring/gameplay controls and AdminDirector behavior intact.

This is a bounded alignment pass, not a claim that all authenticated screens are1:1.
Admin review/table/taxonomy interaction redesign, authoring, heroes, library, wallet,
notifications and gameplay remain separate audit items. Different real data and empty
states must not be replaced by mockup fiction.

Validation: added screenshot/overflow/navigation/image-load coverage in RU/UK/EN,
1536px/390px and dark/light. Per owner's instruction, local tests were not run;
exact-head CI and image review are required before readiness is claimed.

## Screenshot review follow-up

CI run 41703850810 passed every job on e60854e. Twenty actual synthetic RU
screenshots at 1536/390px, dark/light were inspected alongside the five selected
references. The first result exposed a light-theme email-status contrast issue,
unfilled admin action buttons, small preference copy, inline upload hints and an
unintended privacy-image right gutter. Follow-up source fixes include explicit
banner text color, primary action classes, readable toggle text, block hints and
`max-width: none` for the intentionally expanded privacy image. Browser checks
assert the banner color, primary action presence and the image's right edge.
Fresh exact-head CI/screenshots are required for these fixes.

The wider 1:1 goal remains open: the shared header/search/rail shifts content down
and narrows it relative to the references; profile avatar/action scale, preference
row density, privacy data-row hierarchy and security field/session composition
still need a measured second pass. Preserve search, utility, export, deletion and
session functionality during that work. Reference email verification and real
account states may differ; do not replace genuine data with mockup examples.
