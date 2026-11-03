# KAN-11: selected-language story and game views

## Delivery boundary

This draft prepares automatic **read-side localization**, not a production paid
translation rollout. The runtime currently uses previously saved translations and
original-text fallback. It does not create external translation jobs, charge a
wallet, or inherit permission to translate from the existing NPC/OpenAI key.
The only dispatcher accepted by this implementation is a synthetic, non-external
test dispatcher. `translationDefinition` prepares a strict translation task for the
existing bounded text provider, but no production transport is connected to it.

The owner requested automatic translation into the selected language. The payer
and permission for automatic paid dispatch remain unresolved in KAN-11. Do not
close the issue or describe full live translation as enabled until that remaining
work has been implemented and verified.

## Read surfaces

- Public catalog, story detail, creator stories and non-editable library cards:
  title and synopsis are added to the selected-language metadata variant. Current
  curated variants win per field. Source title, synopsis and source revision are
  never rewritten. Author drafts and Studio endpoints are excluded.
- Authorized campaign snapshots: map/exits/NPC/item labels, visible descriptions,
  supporting NPC cards, revealed objectives/epilogues and NPC utterances.
- Authorized story feed: visible entries and NPC speaker labels. The original
  submission receipts, action previews and confirmation hashes stay unchanged.
- HTTP reads follow the selected `Accept-Language`; WebSocket connections carry a
  validated locale because browser sockets cannot set custom headers. Changing
  language refreshes read resources and reconnects the localized game stream.
  The normal UI locale dictionaries and generation `replyLocale` remain intact.

There is no new translation button or extra explanatory text in the player UI.
Missing translations keep the original text visible. Translation/storage failure
never blocks story reading or authoritative gameplay.

## Safety and persistence

The interceptor runs only after ordinary controller authorization and safe DTO
projection. It never queries original private lore or an NPC's private model
context. The socket also obtains a fresh authorized snapshot before localization.
Selection is an explicit list of display fields, not a recursive walk through
arbitrary object keys. Private author notes, knowledge, credentials, IDs, control
fields and financial values are not translation inputs.

Each phrase cache key binds the resource, viewer, target locale, source text,
source revision, maximum output length and translation protocol version. Public
anonymous and authenticated/private viewers are distinct scopes. There is no
endpoint to read a cache key directly. A revoked/archived/private resource cannot
be recovered through its saved translation. Edits and source revisions cannot
reuse stale translations, while unchanged phrases can be reused across movement,
feed growth, reloads and process restarts.

The database stores derived translations only, not source prompts. Unique durable
claims prevent duplicate generation by concurrent service replicas. Pending and
failed claims are never automatically retried. Output must contain exactly the
requested identifiers once, bounded plain text and no added object properties.
Catalog work, text count, UTF-8 request size, response text and execution time are
bounded. Originals and canon are never modified. Account erasure clears viewer,
authored-adventure and participated-campaign caches; foreign keys also cascade on
hard deletion of a viewer or source.

## Required next decision and integration

1. Decide the payer and eligibility: reader, author or a specifically funded
   platform/sponsor policy, including anonymous reads and private content.
2. Define the automatic consent/data-sharing scope and bounded spend allowance.
   An existing generation key or a language selection is not that approval.
3. Add a production dispatcher using the existing generation authority, durable
   quote/reserve/settlement and unknown-result reconciliation. Preserve cache-hit
   zero cost, cross-process deduplication, kill switch and no automatic retries.
4. Verify the approved external provider with an explicitly bounded live test.
   Reassess response latency before putting live dispatch on any gameplay read.

No production activation configuration is added by this PR. No deployment, merge,
real-provider request or payment test was performed.

## Verification

- `node --test tests/game/automatic-translation.test.cjs`
- `node --test tests/game/automatic-translation.integration.test.cjs`
- `tests/platform-translation.test.mjs` runs in `npm run test:integration` against
  real local HTTP and PostgreSQL, including authorization and stale-source checks.
- `tests/e2e/automatic-translation.spec.ts` uses synthetic API responses to test
  live language changes, late responses and reload without an extra button.

The static, PostgreSQL, platform and browser suites include these regressions.
Synthetic translation verifies the pipeline, not actual linguistic quality.
