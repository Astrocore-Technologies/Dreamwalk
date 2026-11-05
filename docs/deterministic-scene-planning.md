# Deterministic location-only scene planning

Uncertain or unanalysed pinned map images remain the original game maps. The compiler
builds their encounter membership from typed author scene participants; the model no
longer needs to construct scene IDs, entry IDs, or participant groupings.

- The authored opening is preserved. Other locations receive an empty arrival scene.
- An explicit author participant stays in an authored encounter at the assigned location.
- An NPC without typed membership receives a distinct offstage scene, never an inferred
  shared encounter based on prose, name, picture, or location alone.
- No unresolved-encounter eligibility is added. Typed membership removes any contradictory
  model eligibility flag. Existing explicit absence/separation is not turned into contact.
- Foreign or duplicate NPC identities, source mismatch, conflicting authored locations,
  image identity mismatch, and unsafe confident geometry still fail closed.
- New scene construction neither fabricates coordinates nor changes existing campaigns.
- Fixed failure categories preserve diagnosis without recording source prose or SQL details.

The regression reproduces three imaged locations with one untyped opening. It proves
successful compilation without model scene metadata and isolation of unintroduced NPCs.
It also proves that malformed model grouping cannot grant contacts. This addresses a
reproducible failure class; it does not establish the exact cause of historical jobs whose
proposal was already discarded.
