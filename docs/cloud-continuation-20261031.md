# Turn-based visual authoring and reply-locale verification — 2026-10-31

This source-only continuation preserves the current main integration and its provider
configuration, receipt verification and image-test safeguards. It remains a local/mock
development candidate, not a live-provider or deployment acceptance claim.

## Changes

- The selected `uk`, `en` or `ru` reply language travels from the UI through
  validated input, stored quote, request and provider context. It is pinned per
  post, not reread from a later interface/account preference. Deferred replies
  to different NPCs retain their own language through world-phase refresh and
  restart. Changing the language of an already quoted operation conflicts;
  omitting it during confirmation preserves the stored language.
- Provider instructions explicitly distinguish generated response language from
  authored source content. No paid automatic translation of author content is
  introduced. Presentation language does not change admitted speech identity.
- Isolated browser checks also exposed the mock Keeper returning raw English
  fixture facts. Its exact bundled Observatory fact now has curated three-language
  replies; other author facts remain explicitly marked original-language quotes
  inside localized mock speech. Acknowledgements are stored in the pinned language,
  and bounded original quotes preserve Unicode characters. This is deterministic
  mock behavior, not evidence of live model quality or automatic translation.
- Quote UI shows the pinned language. Recipient UI labels follow the current
  projected label instead of retaining the label from an older interface locale.
- A dirty geometry draft can save a location illustration independently of its
  former map binding. The displayed illustration-only choice now matches the
  submitted operation; no geometry/art revision is silently written. The parent
  refreshes moderation without entering a loading state or remounting the editor,
  so unsaved narrative/geometry and its CAS revision survive save/close/reopen.
- An expired/stopped manual session cannot strand a wholly unapproved world
  request. Cleanup is serialized with consent and proves absence of a permit,
  linked job and ledger reservation before making the request terminal. Active
  consent waiting, dispatched/uncertain jobs and historical liabilities remain
  untouched. There is no mock replacement for failed real-provider work.
- Aggregate image integration now scopes its zero-dispatch assertion to the
  current owner/adventure, rather than incorrectly counting previous fixtures.
- `npm run test:voice` runs the focused manual-provider/world-progress safeguards.
  Reply-locale helper tests are part of `npm run test:game`.

## Verification

All provider transports used for development checks are mock/synthetic. Tests
provision disposable PostgreSQL clusters, not user databases.

| Check                                                               | Executed result                                                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Production candidate build, workspace typecheck, ESLint, formatting | Passed on the implementation candidate. |
| `npm run test:unit`                                                 | Contracts 9/9, game core 161/161, configuration/locales/native-stop guards 22/22.                  |
| `npm run test:game`                                                 | Game core 161/161 plus selected UI/privacy/locale/regression tests 110/110.                        |
| `npm run test:game:integration`                                     | 235/235, including manual-session expiry/race coverage; no failures or skips.                      |
| Platform PostgreSQL integration                                     | 62/62.                                                                                             |
| Image PostgreSQL/config integration                                 | 42/42, plus configuration tests in the runner.                                                     |
| Visual/spatial authoring integration                                | 39/39.                                                                                             |
| Reusable assets, homepage, local SMTP capture                       | 23/23, 4/4 and 1/1 respectively. No external mail.                                                 |
| Manual-provider/world-progress and provider-protocol checks         | 12/12 and 10/10; manual expiry/consent-race PostgreSQL checks also pass 7/7.                       |

Interactive browser checks used the isolated mock API/PostgreSQL,
not intercepted requests:

- Three fresh uk/en/ru posts kept their quote language across interface switches,
  waited until world phase, committed replies in the same order and returned to
  the next round. Reload retained all replies; existing historical English entries
  were not rewritten. Quote Edit dismissed without posting and retained the draft.
- A saved, explicitly synthetic image was reused while the map had an unsaved
  empty name and added wall. Illustration-only save, close, reopen and a second
  close preserved both edits. The temporary synthetic test edits were restored.
  Only one explicitly labelled zero-cost mock raster was created during setup;
  it is not real API art.

Four locale and four image Playwright specifications are supplied/discovered, but
the automated browser runner was **not** part of these interactive checks. The
uncertain-network browser scenario remains unrun; unit request-pinning checks and
durable API replay tests are separate evidence. Browser evidence is not part of
the source change.

The aggregate test pass includes updated exact mock-output expectations: custom
facts are literal original quotations, and acknowledgements are pinned text rather
than a code translated later by the UI. Cold-memory regression separately proves
140 unique player episodes and unique NPC acknowledgement episodes, source
retention, bounded private retrieval and projection secrecy.

## Independent requirement review

| Requirement                                               | Confirmed implementation and boundary                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immediate spatial actions and shared click/text resources | Server-owned movement, main/additional/reaction budgets; durable receipts and replay/fence checks.                                                                                                                                                                                    |
| Deferred multi-recipient replies                          | Distinct ordered sources and audiences persist until the finite world phase; whispers remain scoped.                                                                                                                                                                                  |
| Author-defined rules                                      | Declarative `dreamwalk-base` v1 rules pin into published playable versions and campaigns. Common movement/action/vitality/damage/push values have editor controls; advanced maxima remain schema-configurable, not extra UI sliders. This is not arbitrary executable rule scripting. |
| Personality-driven NPC proposals                          | Values, taboos, goals, relationships and perceived evidence enter private context. Server policy, range, knowledge and phase checks still decide what can commit. Real-model personality quality is unverified.                                                                       |
| Procedural animation                                      | Existing hit/push sprite offsets decay to zero and honor reduced motion; no generated image is needed or dispatched.                                                                                                                                                                  |
| Image/character packages                                  | Immutable library revisions, explicit reuse/binding and separated geometry remain implemented with synthetic acceptance. Real images, likeness and generated animation quality remain unverified.                                                                                     |

## Source-only publication safeguards

Machine-specific setup and private operational history are excluded. The optional
manual launcher requires an explicitly supplied absolute `DREAMWALK_LIVE_SECRET_FILE`
path; it has no machine-specific default or automatic credential discovery. Missing,
relative and malformed paths fail closed. Synthetic loader regression tests cover
these failures without reading real credentials or launching a live provider.

## Running and reviewing this source

Use Node 22+ and the sole root `package-lock.json`. Preserve any existing local
working changes, private configuration, database and uploaded media when updating;
none of those local files is part of this source change. Follow `README.md` for
mock development and the test commands above. This continuation adds no migration
after 035. A source update does not activate a provider, renew a manual grant,
reset historical spend or authorize paid testing.

## Still not verified or authorized

Successful real API image generation, actual model language/personality quality,
photo likeness, generated-animation consistency and a complete real layered
location remain unverified. Mock graphics are fixtures, never proof of generated
art. Real-provider activation/spending, key transfer, deployment and merge were not performed.
