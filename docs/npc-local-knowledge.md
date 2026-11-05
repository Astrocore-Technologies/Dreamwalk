# Grounded local knowledge and individual replies

## Confirmed gaps

Legacy authored NPCs without a character profile can share the operational fallback
`helper`, `kindness`, and `reserved`. These engine settings are not a full character.
Private biographies are deliberately absent from audience-safe speech. A fact existing
only in a biography is not automatically authorized for disclosure.

Default speech selection previously kept the latest sixteen observations, with an
explicit question/topic pinned. An older authored fact could disappear from the primary
reply context after unrelated dialogue, even when this NPC knows it and may disclose it.
The window packer could also protect the last old utterance rather than an explicitly
bound current question, and discard useful authored answers before incidental chatter.
Archived history is a separate, budget-dependent path, not a guarantee that the primary
reply receives the relevant fact.

## Repair

The speech selector now checks disclosure for every listener before ranking. It keeps
the current exchange, explicitly requested permitted facts, up to four relevant known
authored facts, and the latest remaining permitted observations within sixteen records.
Known local facts remain candidates across question languages; an explicit topic can
recall a known place from elsewhere. Packing prefers these selected facts to incidental
chatter, while the current question and required evidence always take precedence.
It never borrows another NPC's facts or treats lexical relevance as permission to reveal
an asked/trusted/never fact. Shared director voices retain their wider audience boundary.

Both planning and speech receive the current public scene name, explicitly scoped to
the scene rather than the token's exact position. Whole-map descriptions, other maps,
private biographies and hidden rooms are not added to this bridge. A scene named after
a building is not proof that the speaker is inside it.

Speech instructions distinguish established public self-knowledge from unknown causes
or procedures. A routine introduction is not itself a threat; an operational helper
fallback is not an instruction to be a generic security officer. Explicit public voice
and public character description remain the source of outward characterization.

The separate author fields `personality` and `greeting` are already public in the
reader publication contract. Compilation now keeps these distinct from private biography
and secrets. Audience-safe identity includes bounded versions as untrusted character data,
not as instructions or proof of historical events. It does not repeat the greeting each turn.

For old campaigns, load can fill missing public fields from the checksum-verified immutable
pinned package, by exact NPC ID only. It does not overwrite an existing field, guess an alias
from a name, read mutable author records, or split the private combined biography. This
restored public presentation is included in the next normal checkpoint; no database migration,
paid generation, relationship reset, or source publication rewrite is performed.

Knowledge selection and scene context remain read-time projections; remembered history
and character profiles are not rewritten, and no automatic generation or summary is added.
An actually empty character remains incomplete: do not invent an authoritative past,
local expertise, or personality from its name, appearance, gender or opaque ID.

## Verification

Targeted synthetic tests cover an old local fact surviving intervening dialogue through
an actual story reply, whole-audience disclosure, asked/trusted/never boundaries,
private-data noninterference, restart, no cross-NPC knowledge and saved-state immutability.
Prompt assertions test intended guidance, not literary quality.

A separately approved live evaluation should use an isolated story with three explicit
character profiles, contrasting public voices and motives, public local facts and distinct
private lore. Test introductions, directions, a new topic after a warning, refusal,
follow-through, a rumor, an unknown fact, a private exchange and save/reconnect. Observe
both dialogue and committed world results, and account for every provider request.
Never report mock passage as proof that real model prose or production gameplay passed.
