# Natural roleplay inventory

A narrated pickup must correspond to a persistent item and committed custody change.
The shared director can materialize one ordinary prop in `narrative.newItem` and
reference it as `new_item` in a matching explicit pickup/pocket attempt. The server
assigns its ID, current scene, location, quantity and inert item properties. The
proposal cannot provide an owner, monetary value, power, consumable effect or key
capability. A prior owner remains unknown unless independently established.

Existing items are reused, not recreated. Bounded multilingual action recognition
supports natural pickup and pocket descriptions in RU/UK/EN. The item label must be
named in the acquisition clause, not a later observation or speech clause. Wishes,
negations, ambiguous targets and quoted instructions do not acquire items. This is
not a general natural-language proof system; unsupported wording can still clarify.
The attempt must have implicit self or an explicit first-person subject. Another
named character taking an item, or an instruction to that character, is not the
player acquiring it. A preceding self gesture can still lead into a pickup.

The normal visibility, range, custody, inventory capacity and world item limits
apply. In turn-based play the current fenced world reply may resolve this specific
pickup using the actor's remaining additional action, without moving the actor,
advancing another player or resetting resources. Repeating a pocket description for
an already carried item does not create a duplicate. Ordinary validated pickup
interpretation needs no additional confirmation button or second generation.

Item creation, pickup, narration, observation events and canon remain in one atomic
story proposal. Admission failure preserves the original state and cannot publish
its dependent success narration. Actual witnesses receive the normal `item_taken`
evidence; they do not receive omniscient narrator memory. Only a referenced carried
item enters the player's director context, never another character's inventory.
The first pickup in the admitted prop's own turn carries a server-stamped
`itemOwnershipContext: unestablished` on that witnessed observation. It records
unknown prior ownership, not permission or legal title. This narrow event does not
automatically create betrayal, alarm, relationship penalties or an investigation.
The observation and factual custody belief remain available; authorized reports
preserve the marker and downgrade confidence. Existing items and later reacquisition
retain their prior semantics. Speech/model inputs cannot assign the marker.
Account erasure removes generated item prose while preserving shared custody and IDs.

Verification covers the reported RU phrasing, strict synthetic provider transport,
existing and new items, ownership/capacity/budget rejection, atomic rollback, replay,
projection privacy, and real isolated PostgreSQL persistence and reload. No real
campaign changes or paid provider calls are part of these tests.
