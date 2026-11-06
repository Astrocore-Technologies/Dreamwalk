# KAN-11: selected-language story and game views

## Delivery boundary

The owner approved platform-funded translation of story titles and descriptions
on the site, including released private stories read by their owner or an accepted
invitee. Translate each source field once per selected language, save it, and
translate again only when that source text changes. This is not authorization to
translate gameplay, draft content, private lore, or personal account fields.

`PlatformMetadataTranslations` now provides that production dispatcher in the
existing `GENERATION_MODE=release`. It uses the existing bounded text adapter,
reviewed model/pricing and release deployment authority. It creates no player
Sparks/Dreams charge, fake player account, separate activation flag or new spending
ceiling. The current owner-approved `allowance=unlimited` release policy also makes
the dedicated platform scope unlimited. If an operator later changes the release
policy, admission fails closed rather than silently overriding that policy.
Mock, disabled and owner-test modes do not dispatch platform translations.
The existing `NPC_AI_KILL_SWITCH` stops new admissions/dispatches; saved safe text
and outstanding financial receipts remain readable/reconcilable.

Gameplay translations still use only the saved cache and original fallback.
Their payer/data-sharing policy is a separate decision. Do not describe this
metadata implementation as a paid gameplay translation rollout.

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

Released metadata keys bind adventure, visibility, source language, target
language, field name, exact source text, maximum output length and protocol version.
They exclude reader identity and unrelated edit revisions: all permitted readers
reuse a translation, and changing only a title does not retranslate its description.
Curated current translations win per field. Source text and canon are unchanged.
Private/public keys are separate. The generic gameplay cache retains its existing
viewer/revision-bound identities and has no production paid dispatcher.

The platform service rechecks the released snapshot and ACL during cache reads,
admission, final dispatch and completion. User/adventure/invitation share locks
remain held through the corresponding database transition. Contention with
revocation or erasure fails fast without an external request. There is no direct
cache-key endpoint, and no private cache is exposed through a public namespace.

Durable field claims and job dispatch transitions deduplicate concurrent readers,
replicas and restarts. A pending job stores only title/description inputs, then
clears them on completion; source prose is not retained in financial records.
The existing shared reservation ledger records actual platform cost with a null
player/quote identity. Unknown outcomes retain held exposure and never automatically
redispatch. A late response to a still-running worker settles that same reservation
once, including after erasure. A receipt already durably saved as `result_received`
can finish settlement after restart without another provider call. If the process
lost a response before saving it, the hold stays unknown for explicit reconciliation;
this implementation does not query the provider for a missing receipt.
Invalid output still settles known usage but never
becomes visible. The provider enforces request/output bounds and execution timeout;
these are technical request safety bounds, not a total platform spending cap.

Account erasure clears derived text and queued/in-flight input/results. A late
provider response may settle its known cost but cannot resurrect erased prose.
At completion, unchanged fields are committed independently: an edit to the title
while a request is in flight cannot poison the unchanged description's cache.

HTTP never waits for a model response. Original text remains visible while an
admitted job is pending. A response header asks catalog/detail/creator/library
resources to refresh after 1.5 seconds until ready. Ready, failed or unknown work
stops refresh. Language changes and navigation cancel the old refresh context,
so slow responses cannot overwrite the new language. No extra button is required.

## Release and verification boundary

Apply migration `068_platform_metadata_translation.sql` with the normal release.
No credentials or production settings are changed by this implementation. The
shared active release/configuration/pricing checks still gate every admission and
dispatch. A new release does not reuse a queued request prepared under a different
provider/configuration snapshot. Financial holds are never cleared just because
a worker timed out or restarted.

Local tests use an injected synthetic provider and disposable PostgreSQL, not real
OpenAI requests. Linguistic quality and the deployed end-to-end path still require
an authorized live acceptance check; source tests alone do not close KAN-11.

## Verification

- `node --test tests/game/automatic-translation.test.cjs`
- `node --test --test-concurrency=1 tests/game/automatic-translation.integration.test.cjs tests/game/platform-metadata.integration.test.cjs`
  is included in the normal PostgreSQL CI gate. It covers deduplication, field
  invalidation, private ACL/revocation barriers, restart recovery, erasure and
  late-receipt settlement without charging a player.
- `tests/platform-translation.test.mjs` runs in `npm run test:integration` against
  real local HTTP and PostgreSQL, including authorization and stale-source checks.
- `tests/e2e/automatic-translation.spec.ts` uses synthetic API responses to test
  pending-to-ready refresh, language changes, navigation cancellation, late
  responses and reload without an extra button.

The static, PostgreSQL, platform and browser suites include these regressions.
Synthetic translation verifies the pipeline, not actual linguistic quality.
