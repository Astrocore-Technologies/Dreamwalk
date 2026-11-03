# Narrative-first alignment — 2026-10-31

## Product invariant

The player and AI coauthor an evolving story. The visual game is the confirmed spatial representation of that story, not a fixed RPG decorated with chatbot replies. Authoring supplies the initial world, tone, protected facts and supported-mechanic constraints; it need not enumerate all future rooms, people or plot branches. The Observatory is an opening/test fixture, not the platform's narrative ceiling.

## Reuse, do not discard

Keep authoritative movement, item ownership, doors, co-op leases, personal NPC perception/memory, immutable campaign source version, event checkpoints, budgets and asset ACLs. Keep fresh supporting-character validation, but remove the mandatory pre-authored role catalog as the universe boundary. Protected identities/roles remain protected; newly proposed secondary roles may be admitted under world constraints.

## Coherent first end-to-end slice

1. A normal story input submits an idempotent NarrativeTurn with current semantic canon revision and explicitly shared audience. Private NPC whispers are not automatically shared with the director or other players.
2. Build bounded context from initial protected canon, confirmed narrative events, current public scene and relevant shared evidence. Player text is untrusted intent, never an authoritative world fact.
3. Existing provider/quote/sponsor machinery returns a strict proposal: narration, supported effects, at most one new bounded location template with valid connection, one fresh supporting NPC, and explicit new public facts with provenance. No executable code, arbitrary mechanics, currency grants or retroactive replacement of protected facts.
4. Validate the entire proposal before commit: current readset, source/member authority, world limits, identifiers, reachability, legal exits/door constraints, duplicate identity, spawn safety and supported actions. Reject unsupported pieces as one bounded operation rather than narrating effects that never occurred.
5. Commit turn, canon delta, map/entities and action effects atomically under the existing campaign writer. Emit the confirmed result to all authorized participants. Replays return the same result; concurrent stale turns must rebase/requote rather than overwrite.
6. Persist a media request specification for the confirmed scene. Search permitted assets first. Render an honest fallback until approved graphics exist. Image generation is a separate quoted/consented operation; no automatic spend or rerender fee on return.
7. Ordinary UI shows the evolving narration, scene and available actions. Technical diagnostics are optional. No Studio visit is required for story progress.

## Acceptance scene

From the Observatory opening, a player investigates an unexplained signal. A deterministic director fixture proposes a reachable maintenance annex and a new assistant with a fresh identity, within the same setting. Two independent players see the same approved extension, enter it, interact using existing mechanics, return and reload. The new NPC retains identity and permitted memory; private old NPC facts never leak into the new actor. A second narrative turn can respond to the first extension rather than returning a fixed scripted ending.

## Failure tests

Malformed/oversized proposal; unsupported mechanic; protected-name replacement; nonexistent or concealed evidence; inaccessible connection; overlapping/blocked spawn; duplicate and concurrent proposal; stale source/canon; revoked membership; crash before/after commit; all players offline; provider refusal/unknown cost; invalid or unapproved media; no second charge on replay. Any narrated world effect must have a corresponding committed event.

## Honest limits

Schema validation can guarantee supported mechanics and explicit fact/reference constraints, not prove all free prose is semantically consistent or compelling. Live-model quality needs the approved secure evaluation. Generated art needs separate cost-risk authorization and actual pixel inspection. Neither code-native placeholders nor mock fixtures constitute a competitive finished visual product.

## Account erasure

Confirmed account erasure preserves shared map topology, item ownership and anonymous
NPC identities so other participants are not stranded. Narrative inputs/receipts/media
preparations are removed through the existing decision-request cascade. Because a
narrator can paraphrase earlier personal input without a complete token-level causal
graph, affected narrative campaigns conservatively redact generated narrative prose,
new scene/NPC labels and flavor, derived NPC episodic text and retained operation
projections. Original authored canon remains unless its source author is erased, in
which case the existing source-tombstone policy applies. Accepted mechanical promises
can remain without their quoted speech. This intentionally sacrifices some shared
narrative memory for privacy rather than claiming that pseudonymization erases prose.
Exports include only the requesting player's own narrative submissions/results.

## Same-turn supporting-character interaction

A shared director turn can now introduce a persistent supporting NPC and let that
character answer the player's speech in the same proposal. The `new_npc` reference
is local to that proposal and resolves only to its admitted `narrative.newNpc` entity.
The character is created through the existing spawn, identity, visibility and canon
validators. The reply enters the ordinary NPC utterance/observation pipeline, so a
report such as “Mira said she knows nothing about the pass” is remembered as the
player's statement, not an authored or independently verified fact. Invalid
placement, unavailable speaker or failed interaction rolls back the entire proposal.
No extra model dispatch or image generation is involved.

Existing speakers require their own `sceneSpeakers` context and matching
`replyContextHash`; their reply may not use narrator-only canon as personal knowledge.
A newborn uses its proposed public identity, current perceptions and the current
attributed statement only. It inherits no other character's private memory. These
contracts validate provenance and state, not the truth or literary quality of every
sentence of free generated text; that still requires a separately authorized live
model evaluation.

For real-time campaigns, an explicit player attempt may propose `approach` to a
visible NPC or `new_npc`. This is a same-map scene cut, limited to eight strictly
walkable cells, respecting footprints and encounter areas. It does not tick or move
other actors. It remains in the existing interpretation-confirmation flow. Cross-map
travel and companion movement are not implied by this action.

In turn-based campaigns unresolved emotes remain unverified player roleplay. The
world-phase director can materialize an adjacent character and answer, but cannot
spend or bypass a player's movement budget. Mixed posts preserve actual dialogue as speech and stage directions as attempt
segments, also separately attributed in `untrustedRoleplay`. Descriptive attempts
have a null action and no mechanical success outcome. World-phase director
proposals cannot contain mechanical actions.
If no valid nearby position exists, the engine must not claim completed contact.
Arbitrary travel, remote summoning and automatic companion arrival remain unsupported
by this bridge. The composer explicitly labels the shared destination as the director;
whisper/selected-character mode does not silently broaden its audience or create a
public scene. Administrative director personas are separate from these permissions.
