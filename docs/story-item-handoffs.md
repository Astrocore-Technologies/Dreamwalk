# Existing-item handoffs in roleplay

A free-form player attempt may hand an existing carried item to another visible actor.
The director selects the existing `give` action semantically; the player does not need
an imperative command or a fixed verb. The old free parser remains only a preview.

The director receives a per-attempt capability containing only actor-owned items named
in that attempt (IDs or current/localized labels) and visible conscious recipients.
Unmentioned inventory, other actors' inventory and item definitions are excluded.
The capability is private director context, not NPC knowledge or public narration.
References, item revisions and recipient eligibility participate in the context hash.
Ambiguous or ungrounded references should remain an attempt or request clarification.

Admission checks the exact segment, current ownership, recipient visibility, distance,
capacity and the original player's remaining round resources. The normal ordered
reducer performs the transfer. Every action, observation and narrative entry is staged
until the whole proposal succeeds; a later failure rolls everything back. A stale or
replayed proposal cannot transfer the same object twice.

A small RU/UK/EN consistency backstop rejects recognized completed-handoff prose about
these referenced tracked objects when no matching successful `give` exists. This is
not a complete natural-language truth classifier and does not authorize any action.
Provider instructions additionally require all completed tracked transfers to carry
the typed effect. Ordinary gestures, handling an owned object and untracked everyday
RP remain narrative, with no forced inventory materialization or technical disclaimer.

Validation uses synthetic core and injected-provider tests only. No live campaign,
provider call, image generation, payment or new model pass is required.

## Current outcomes and historical prose

Director narration is a candidate post-admission result, not a report emitted before
admission. A selected supported inline give may describe the transfer completing:
the engine publishes the effect and narration together only after required admission
and confirmation. Failed admission publishes neither. Current known failures and
pending reactions remain authoritative; travel intent and queued paths do not inherit
this immediate-effect rule.

The pre-admission RP label is normalized on quote, rebuild, forecast and provider
serialization. It cannot permanently classify a newly selected typed effect as an
unresolved gesture. Historical canon citations describe earlier turns, not the status
of the current retry or current custody. Old history remains unchanged and audience
filters are unchanged. No prose rewriting, extra provider pass or new RP restriction
is introduced; synthetic tests verify the request contract, not future live wording.

## NPC custody and voluntary returns

Private NPC planning receives checked self-inventory identities, labels and revisions.
Speech keeps the existing, possibly non-exhaustive owned-item capability, adding item
revisions without exposing taboo or legacy private holdings. A currently listed object
outweighs older uncertainty about present possession. It does not prove legal ownership,
who gave it, or an obligation to hand it over. Omitted capability entries imply no absence.
Voluntary returns use `give_existing` with the same object ID; refusal and ordinary
untracked roleplay remain valid. Speech and mechanical effects retain atomic admission.

New committed transfers also produce an `item_given` observation with a snapshotted
item identity, revision and recognized participants. The recipient's existing `helped`
observation and relation effects remain intact. Perception uses actor contact rather
than a carried item's stale position, including location-only scenes. Full-audience
ACL checks protect provenance, including participants who did not recognize each other;
retellings and data erasure retain the same causal root. No old history is backfilled.

Core and injected-provider regressions cover custody, voluntary return/refusal, replay,
stale revisions, witness recognition, audience widening and erasure. They verify the
contract and admission, not that a future real-model reply will always be correct.
