# KAN-11: automatic released-content translation

## Current owner-approved boundary (2026-11-06)

Translate released story titles/descriptions, NPC names/descriptions, tags and
reader-visible authored world descriptions into Russian, Ukrainian and English.
The platform pays. Queue the work automatically when a public approval or private
release is created or changed; readers do not press a translation button, give
another confirmation or spend Sparks. Save the variants and reuse exact unchanged
fields. Existing valid curated variants take precedence.

The owner subsequently withdrew both gameplay-message translation and draft
translation. These later instructions override the earlier broader request:

- No draft/Studio/NPC-template/private-test-build translation or backfill.
- No translation of player messages/actions, NPC utterances, narration/director
  text, party chat, thought-reader dialogue, receipts or action previews. The old
  generic cache also excludes these fields, including previously saved variants.
- Do not expose withheld lore, private NPC facts or an unpublished cast through a
  translation DTO. An ordinary story reader still receives the existing safe DTO.
- Static UI, errors, labels and accessibility text use complete RU/UK/EN dictionaries.
  They are not sent to a model on every render.

## Sources and automatic creation

Migration 069 adds a transactional identifier-only outbox. Public approvals,
private releases and changes to the current released snapshot enqueue work in the
same transaction. A draft save cannot enqueue a translation. Existing released
sources are seeded once into the same durable queue; workers consume bounded
windows until it is exhausted. No read request is required to start translation.

Explicit adapters cover released title/synopsis/custom tags and public taxonomy,
and immutable released playable descriptions. Private test packages are not a
release. Playable fields are selected by exact frozen map/entity IDs and source
text, not guessed names. The same released source is freshly authorized before
read, dispatch and completion. A changed runtime description or a newly generated
entity has no proof of that released source and is not admitted by this adapter.

Release metadata intentionally omits unused NPC-cast/duration translation: the
existing story page does not expose those fields. NPC descriptions are served
through the authorized playable projection instead. The private lorebook is not
published as a side effect, and translating a field never changes what a player
is allowed to know.

## Persistent cache and cost

Exact field identity includes its immutable source, semantic path, disclosure
compartment, source text/language, output bound and target locale. A general edit
revision, a page visit or the number of readers is not a reason to translate again.
Per-field human translations win. Long prose is split at sentence/word boundaries
with retained whitespace and a shared field output budget; successful fragments
cannot exceed the consuming field's total limit. Each provider request contains
one source fragment, so private lore cannot contaminate another field in a batch.

The shared platform reservation ledger records actual cost with no player or
Spark-quote identity. Existing release model/pricing/configuration authority and
kill switch are retained. The owner-approved unlimited allowance has no invented
total spending ceiling. Window/concurrency and request/output bounds are technical
scheduling/safety controls, not a product spending cap. A later finite operator
policy is respected without rolling back an already affordable admission prefix.

Durable claims, exact claim IDs and a persistent paid-attempt barrier deduplicate
replicas, concurrent readers, restarts and source A-to-B-to-A reverts. Unknown
provider outcomes retain the same held exposure and never automatically dispatch
again. Known invalid output settles usage but remains unavailable. A late response
to the living worker may settle its original hold once; a durably saved receipt
can finish after restart. A lost receipt is not silently queried or regenerated.

## Authorization, erasure and display

Source/user/adventure/invitation/membership locks and access epochs fence
revocation, erasure and release lifetime changes. Deleting a historical private
release rotates its parent access epoch even while a newer release remains live.
Ordinary content/review edits do
not masquerade as an access revocation. Cache reads happen in the same transaction
as fresh source authorization. There is no public cache-key read endpoint.

Account deletion synchronously removes cache/bindings and scrubs job input,
results and prose-bearing paths. Financial usage/reservations and one-way attempt
identities remain. A late receipt can settle cost but cannot restore erased prose.
Source strings, canonical state, source checksums and action receipts are never
replaced by translations. Ready-cache descriptive names are frozen as explicit
presentation-alias evidence before quote/count, tied to the actor, exact canonical
source label, entity/map ID and locale. Every retry and atomic gameplay admission
reuses the same evidence and revalidates its source/access lifetime. This is an
input-reference aid, never translation of gameplay messages or a change to canon.
An alias cannot grant visibility, revive a revoked source or refresh a paid quote.

Original text remains readable while work is pending or unavailable. The pending
response header refreshes catalog/detail/library/taxonomy views without a button.
Ready/failed work stops refresh; language changes/navigation cancel the old
refresh. Existing game snapshot refresh can pick up ready descriptive variants.

## Verification and release gate

Tests use an injected synthetic provider and disposable PostgreSQL, not paid
requests. The normal CI gates include pure field/allowlist tests, source adapters,
full-schema lifecycle tests, source/ACL lock races, exact cost/unknown outcomes,
erasure and browser language/pending/navigation behavior at 390px and 1536px.

The previous metadata-only PR119 head 319163bb passed all six CI513 checks, but that
head was read-triggered and does not prove this broader creation-triggered work.
This candidate requires new exact-head CI and independent source/privacy review.
Actual linguistic quality, deployed migration/queue behavior and localized-name
interaction still need release acceptance; source tests do not close KAN-11.
