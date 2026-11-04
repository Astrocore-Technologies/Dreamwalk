# NPC dialogue and fictional thought repair

## Confirmed failure modes

- Legacy compiled NPCs can all have `helper` / `kindness` / `reserved`, with no typed characterization. A private prose biography does not change these typed defaults.
- Safe speech previously received only the character name and role. Existing public description and appearance were omitted. Private biography and fictional thoughts are deliberately not speech evidence.
- The legacy `reserved` style was projected as `terse`, encouraging identical clipped replies.
- Fictional `innerThought` was instructed to be brief and capped at 480 characters. This was an output policy, not a reader truncation problem.
- For characters with an explicit characterization, the first recognized trigger in a relevance-packed evidence list could preserve an older warning even after a new interaction.

## Bounded repair

- Project already-public name, role, description (1200 characters) and appearance (800 characters) into the character's decision context and whole-audience-safe speech context. Keep the existing visibility and disclosure checks. Do not copy biography, secrets, private examples or prior thoughts into speech.
- Interpret legacy `reserved` as neutral rather than imposing terse cadence. Explicit authored public style and typed voice retain precedence.
- Expose retained order only among admitted observations, plus self-attribution for previous speech. Do not expose absolute timing or the number/order of private events. A reconstructed queued turn remains semantically stable across background ticks.
- Choose performance from the latest admitted interaction. A new ordinary utterance/gesture supersedes an old classified trigger without awarding trust or creating an event.
- Ask for a character-specific, coherent fictional thought paragraph, normally 3–6 sentences, with a 1400-character schema ceiling. This is authored fiction, not a provider reasoning trace, and it has no mechanical authority.
- Speech guidance follows the current beat, distinguishes addressee and bystanders, allows silence, avoids repeated autonomy lectures, and separates object identity from unproven ownership.

## Existing saves and future authoring

The public-profile bridge is a read-time projection. Existing saves benefit without rewriting their pinned source, biography, relationships, memories, inventory or goals. No database migration or paid regeneration is required. Existing hidden/private evidence remains hidden.

A genuinely empty character cannot be recovered from a name alone. Do not manufacture an authoritative biography or infer personality from the name, appearance, gender or random ID. Missing detail should remain modest until the author explicitly supplies or approves a new profile.

The existing versioned `characterProfile` supports private motives/reactions, bounded public voice, examples, goals and promise templates. Use explicit authoring for those fields, and apply them through a new authored publication. Do not hot-load a mutable current draft into an old campaign. A separate in-campaign recharacterization feature would need an explicit versioned operation, preview/approval and a narrowly defined merge that preserves accumulated gameplay state; this repair does not implement or run it.

## Research alignment and verification limits

The supplied research excerpts recommend persistent character cards, relevant authorized memory, distinct character interests, fictional inner life rather than analytical moral auditing, and avoiding recursive repetition. This repair addresses the missing public character context and repetitive response cues without weakening the knowledge boundary. Reading excerpts is not verification of every claim or recommendation in the full original research.

Regression tests establish context contents, privacy, saved-state immutability, ordering, stale-state behavior, thought bounds and prompt contracts. They do not establish the literary quality of a real provider response. No new paid provider call is included; live comparison requires the separately authorized evaluation budget.
