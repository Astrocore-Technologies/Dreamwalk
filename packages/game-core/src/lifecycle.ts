import { actorLifeState, type ActorLifeState, type GameState } from '@dreamwalk/contracts';

/** Mutate only an isolated reducer draft. Identity, body, inventory and memories
 * stay in the world; stale intentions and automatic continuations do not. */
export function transitionNpcLifeState(
  state: GameState,
  npcId: string,
  lifeState: ActorLifeState,
): boolean {
  const npc = state.entities[npcId];
  if (npc?.kind !== 'npc' || (npc.lifeState === lifeState && actorLifeState(npc) === lifeState))
    return false;
  npc.lifeState = lifeState;
  npc.lifeRevision = (npc.lifeRevision ?? 0) + 1;
  npc.revision++;
  npc.movementGeneration = (npc.movementGeneration ?? 0) + 1;
  delete npc.path;
  delete npc.movementTrace;
  if (lifeState !== 'conscious') {
    for (const encounter of Object.values(state.encounters)) {
      if (encounter.phase !== 'planning') continue;
      encounter.participants = encounter.participants.filter((id) => id !== npcId);
      delete encounter.intents[npcId];
      if (encounter.pendingJoinIds)
        encounter.pendingJoinIds = encounter.pendingJoinIds.filter((id) => id !== npcId);
      if (encounter.endVotes) encounter.endVotes = encounter.endVotes.filter((id) => id !== npcId);
      if (encounter.coordinatorId === npcId)
        encounter.coordinatorId = encounter.participants.find(
          (id) => state.entities[id]?.kind === 'player',
        );
    }
    delete npc.encounterId;
  }
  const brain = state.npcBrains?.[npcId];
  if (brain) {
    brain.generation++;
    brain.plan = [];
    brain.cursor = 0;
    brain.waitingForPath = false;
    delete brain.planSource;
    if (brain.living) {
      brain.living.knowledgeRevision++;
      delete brain.living.summary;
      delete brain.living.companionship;
      delete brain.living.continuationOpportunity;
      brain.living.causes = [];
      // Death cancels obligations without pretending they were fulfilled or broken.
      if (lifeState === 'dead')
        for (const obligation of brain.living.obligations)
          if (['accepted', 'proposed'].includes(obligation.status)) obligation.status = 'cancelled';
    }
  }
  if (state.turnController) {
    state.turnController.deferredSpeech = state.turnController.deferredSpeech.filter(
      (speech) => speech.recipientId !== npcId && speech.actorId !== npcId,
    );
  }
  return true;
}
