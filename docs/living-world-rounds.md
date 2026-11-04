# Living world rounds

End turn freezes the actual roster on player-occupied maps. Every active NPC is
considered once per round. There is no numerical NPC roster cap. Individual
provider output, action and concurrency limits still apply. A durable roster and
request identity prevent heartbeat, reload and process-restart duplication.

NPCs on other maps retain their positions and compact textual memory without
running background generation or actions. Entering a map makes its existing NPCs
eligible again; it does not recreate them or grant knowledge of distant events.
An already-consented companion can finish a witnessed player crossing through its
known exit as a free mechanical continuation. This does not run off-map cognition
or bypass doors, occupancy, movement budgets or destination checks.

## Decisions and actions

Private decisions use each NPC's own personality, observations, beliefs and prior
fictional state. They are never combined into a scene prompt containing all NPC
secrets. A bounded `cognition` output records motive, belief, intent and a short
in-world inner thought. These are authored character fiction, not provider hidden
reasoning and not mechanically verified facts.

Plans pass existing ownership, visibility, target, map, movement-generation and
round checks. Each admitted NPC has its normal individual action budget; the total
world budget scales with the frozen roster rather than excluding later NPCs. A
failed action remains failed and its private outcome informs reconsideration.
Continuations are free only within an explicit round window with unchanged
knowledge and no recorded blocker. Advancing wall-clock ticks is not required.

Current visible map imagery and the NPC's own numbered marker ground descriptive
reaction. Painted water, walls or cliffs can motivate caution, but cannot declare
collision, a fall, damage or successful movement. Engine geometry remains the
mechanical authority. Player and AI coordinates use the same zero-based x/y grid.

## Spatial conversation

Speech needs no selected NPC. Normal speech reaches three cells, spoken text
containing `!` reaches six, and whispers reach one. The acoustic path uses occupied
cell Manhattan distance with the existing wall/door and map boundaries. An
exclamation mark in an emote does not turn separate speech into a shout.

Every listener receives the original observation and can choose a response.
Silence is allowed. A player utterance appears once, even when many NPCs hear it.
Whispers are private to everyone actually in their one-cell audience, not merely
to a selected recipient. NPC reply audiences cannot expand beyond the context
whose disclosure was approved, and are narrowed to the actual reply's audibility.

## One world estimate

Turn-based composer mechanics are resolved without a paid reply. The world phase
prepares the full set of private decisions, audience-safe optional replies and any
necessary director request before showing one aggregate quote. Plain area speech
does not need a redundant director call. Private planning and public speech remain
separate when merging them would disclose private knowledge.

The estimate sums the exact native prepared requests, including map input,
input/output/cache pricing and wallet reserve. Dreams-first funding and two Sparks
per cent remain unchanged. The user confirms the complete finite batch once.
No new body or newly arrived NPC can silently enter an accepted batch.

The short quote deadline is the deadline to accept, not an artificial cap on how
many approved NPCs can finish. Durable consent remains bound to the original
request identities, contexts, quotes, policy and world fence. Current access,
funds and provider guards are still rechecked. Unknown provider liability is never
retried or discarded: demonstrably unpaid work stops, and the world can finish
without trapping the player or selling replacement work automatically.

## Reading thoughts safely

The inspection panel requests thoughts only when opened, through a separate
authenticated no-store endpoint. Ordinary state, feeds and sockets contain no
private thought, motive or belief fields. Closing or changing identity/selection
discards the local response.

A thought inherits the intersection of all source audiences, including archived
episodes, summary evidence and prior cognition. Mixed private conversations can
make a thought unavailable to every player. Private biography, goals and authored
facts additionally require current source-author access. Owning a campaign made
from someone else's story does not grant that access. Source authors never bypass
another player's whisper audience. Missing legacy ACLs fail closed.

Account erasure clears generated cognition conservatively even when it paraphrases
the erased player without literal identifiers. No model may supply reader ACLs.

## Verification boundary

Tests use synthetic providers and disposable databases. No development step needs
a paid provider request or changes an existing player's campaign or balance. Mock
tests prove admission, privacy, billing and engine behavior, not the literary
quality of live model roleplay. Production quality evaluation needs separately
authorized spending and a defined scenario.

## Deployment order

Vercel Git deployment creation is disabled for every branch, including main.
Do not enable automatic Git builds or trigger a deployment for a pending or failed
GitHub check suite. The connected deployment operator must first verify all
non-Vercel checks, including every browser shard and the aggregate gate, are green
for the exact candidate SHA. Then create one manual preview for that SHA, verify
its build and readback, and merge only after review. After merge, wait for all
checks on the exact main SHA before creating a production deployment. Verify the
canonical production alias and API release before reporting deployment complete.
No new access token is needed for the existing connected deployment operator.
