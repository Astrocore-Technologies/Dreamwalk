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
