# Unified story turns

The normal player composer sends one ordered turn, not a client-side combination of
separate speech and narrative requests. This module is fixture-tested provider
preparation; no live model-quality or paid-call claim follows from a mock test.

## Wire flow

- `GET /game/campaigns/:id/turns/feed`: server-ordered, audience-filtered entries and
  only the requesting player's receipts. Existing projected conversation/notices
  remain read-only historical entries. Their original channel is unknown, so the UI
  does not label historical entries public or whispered.
- `POST .../turns/quote`: operation ID, raw text (1,000 characters), channel,
  optional NPC target, expected canon revision. The operation pins one server turn
  ID and one immutable quote. Repeating changed input conflicts. The quote also binds the provider contract
  version; pre-upgrade or changed-contract quotes fail closed. Quote creation
  changes no world or NPC memory.
- `POST .../turns`: exact quoted input, turn/quote IDs, explicit consent, optional
  confirmation hash for the displayed deterministic action preview.
- `POST .../turns/:turnId/confirm`: a new confirmation operation ID, exact stored
  proposal hash and accept/decline. Confirmation consumes no additional model call.

The server parses at most six ordered segments, including at most two `*attempt*`
segments. `\*` is a literal asterisk. Speech is not HTML and an attempt is not an
assertion that an action succeeded. Unsupported movement composites return
`WALK_FIRST` before charging: click the floor, arrive, then attempt the interaction.
The current bounded immediate catalog includes inspect, take, give, open, close,
unlock and wait; all still pass normal visibility, ownership and range rules.

## One decision and authoritative confirmation

One durable `story_turn` AI job handles the complete turn. Deterministically parsed
attempts include actual success/error previews in its context. An interpreted action
not approved in that preview requires inline confirmation of the stored result.
World changes, the turn receipt, feed entries and financial capture share the normal
single-writer database transaction. Replay cannot create another job. A stale
confirmation is rejected rather than regenerated. Same-turn physical event roots
remain available to deterministic NPC goals but are excluded from extra automatic
provider-plan scheduling. Later independent world observations retain normal bounded
NPC autonomy and its separately authorized budget policy.

## Audience boundary

Targeted turns use the target's perceived, audience-authorized evidence and visible
mechanics, never a union of private NPC memory and shared director knowledge.
Whispers cannot create shared narrative scenes or NPCs. Unsupported extensions ask
for clarification or an explicit public untargeted turn; no silent rerouting or
second charge occurs. Untargeted public turns use the confirmed shared narrative
context. Local speech remains local even though all entries use one feed.

If a newly inferred action fails, dependent success prose is not committed: the
whole proposed result returns a clarification without those effects. A failure
known in the confirmed preview must still match the exact action and outcome.
Generated prose is not proof of ownership or mechanical success. The core validates
typed actions and emits separate authoritative outcome codes. Public outcomes carry
only action kinds, not hidden inventory IDs; full action proposals remain private to
the acting player. OOC chat is a separate existing channel and never provider input.

## Persistence and lifecycle

Migration 029 stores canonical turns, idempotency keys and audience-scoped feed
entries. A server-only turn/segment identity stabilizes admitted speech evidence
across quote, asynchronous execution and confirmation; old tick-rooted speech stays
compatible. All-offline world pause applies to deferred admission and confirmation
simulation deadlines. Provider wall-clock reconciliation remains independent.

Source/member revocation cancels pending consent; reinvitation cannot revive it.
Confirmed account erasure retains opaque operation tombstones but removes raw input,
contexts, proposals and affected derived feed prose. Late jobs cannot reattach an
erased turn. Unknown financial liability is not silently released by erasure.

## Player-facing controls and evidence

The scene and one chronological feed/composer form the normal game screen. Clicking
an NPC selects a recipient without moving or acting. Clicking the floor requests a
server path. WASD and arrow keys no longer move the character; text editing, Tab,
Enter/Space on accessible object/exit controls and Stop remain available. A missing
whisper recipient blocks sending rather than changing the draft to public. Quotes,
clarification and stored-action confirmation stay inline; Group is a separate OOC
tab. Inventory, party and media controls are secondary, not competing chat forms.

Acceptance requires real two-user privacy and ordered effects, one-job/one-charge
replay, restart/offline confirmation, erasure preserving another player's mechanics,
and actual desktop/390px browser captures. Pure fixtures and schema acceptance are
not a new Luna-quality result or permission for another paid request. The exhausted
text evaluation count and the image request's unknown-cost hold remain unchanged.
