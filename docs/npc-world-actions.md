# NPC actions during world turns

Public NPC reply generation previously admitted items and companionship but no
ordinary one-time movement or inspection. The turn-world executor also skipped
the normal living-NPC policy pass. Thus a reply could promise to approach a window
without an executable action, while another NPC's existing local goal was never
given its ordinary policy opportunity.

Both provider reply routes now accept optional `actionIntent`, containing the
exact current `sourceObservationId` and at most three voluntary NPC actions:
`move_to`, `approach`, `inspect`, `wait`. This controls only the replying NPC, never
the player or another actor. The server admits listed perceived targets/coordinates,
checks the original utterance/attempt source and commits the reply and plan atomically.
Ordinary requests and emotes do not imply NPC consent or a follow agreement.

The world phase runs the existing local policy pass for every NPC, then executes
at most one ordinary action per NPC within existing global/per-actor budgets.
NPCs may remain still or silent. Existing goals, obligations and approved model
plans can act independently of the addressed NPC. This does not generate a new
paid model request for every overheard post or require every character to reply.

Long movement executes a bounded path prefix and retains the remaining destination
for a later world turn. Collisions, encounter membership, map and movement-generation
fences are rechecked. Blocked movement remains pending rather than teleporting or
discarding the entire path merely because it exceeds one turn's movement allowance.
Explicit one-time actions take precedence over companionship for that action; the
existing follow agreement can resume afterward. PR60's footprint/exit guards remain.

Silent unresolved emotes are now `attempted` observations and modality-marked private
transcript entries, not spoken `said` claims. Only NPCs that see the player receive
these visual attempts. Their damage/contact is unverified. Confirmed text actions
now record all committed events into NPC perception, rather than only consume events.
Provider guidance distinguishes attempted acts, reported claims and witnessed harm;
mock transport tests verify the data/instructions, not live model quality.

The End turn button stays visible but disabled outside the player's available turn.
The pending queue is labelled as NPC replies; it is not the complete world-action
roster. A live campaign's missing control or stalled phase still needs its actual
authorized state to diagnose; this change does not bypass pending consent or budgets.

World-phase cleanup also handles a bounded set of orphaned `scheduled` requests
with no job ID. It fails such a request only when there is no matching job,
permit, reservation, hold or accepted world-generation consent. It does not retry
provider work, release money or reset gameplay. Queued consent waits and uncertain
financial/provider outcomes remain protected. This closes a confirmed orphan-wait
code path; it is not evidence of the cause of any particular live campaign's wait.

Focused checks: `core-npc-actions.test.cjs`, `npc-world-actions.test.cjs`,
`turn-controls-render.test.cjs`, and the disposable runner with
`GAME_TEST_FILE=integration-npc-actions.test.mjs`. Existing companionship and turn
regressions remain applicable. No paid calls or CI expansion are required.
