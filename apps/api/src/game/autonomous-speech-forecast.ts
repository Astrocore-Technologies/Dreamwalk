import {
  footprintDistance,
  isActorConscious,
  type GameState,
  type Locale,
} from '@dreamwalk/contracts';
import {
  buildNpcPublicSpeechContext,
  npcContextFingerprint,
  npcSpeechProspectiveListenerIds,
  selectNpcSpeechObservationIds,
  turnFence,
} from '@dreamwalk/game-core';
import { packNpcContext } from './npc-context-budget';
import type { DecisionContext } from '../ai/types';

/** Read-only examples using today's real audience and memories. These are not
 * executable actions or upper bounds on a future post-plan request. Nothing is
 * moved, disclosed outside the server, or shortened to fit a financial target. */
export function autonomousSpeechForecastContexts(
  state: GameState,
  npcId: string,
  maxBytes: number,
  replyLocale: Locale,
): DecisionContext[] {
  const npc = state.entities[npcId],
    brain = state.npcBrains?.[npcId];
  if (npc?.kind !== 'npc' || !brain?.living || !isActorConscious(npc)) return [];
  const result: DecisionContext[] = [];
  for (const channel of ['say', 'whisper'] as const) {
    const audienceIds = npcSpeechProspectiveListenerIds(state, npcId, channel);
    // A deterministic current listener provides a representative addressed
    // context. Planning may choose another recipient, move, or remain silent.
    const recipient = audienceIds
      .map((id) => state.entities[id])
      .filter(
        (entity) =>
          entity &&
          entity.id !== npcId &&
          ['player', 'npc'].includes(entity.kind) &&
          isActorConscious(entity),
      )
      .sort(
        (a, b) =>
          Number(b.kind === 'player') - Number(a.kind === 'player') ||
          footprintDistance(npc, a) - footprintDistance(npc, b) ||
          a.id.localeCompare(b.id),
      )[0];
    if (!recipient) continue;
    const selected = selectNpcSpeechObservationIds(state, npcId, audienceIds);
    const context = buildNpcPublicSpeechContext(
      state,
      npcId,
      audienceIds,
      selected,
      [],
      undefined,
      replyLocale,
      recipient.id,
    );
    result.push(
      packNpcContext(
        {
          ...context,
          recipientId: recipient.id,
          channel,
          observationIds: context.claims.map((claim) => claim.observationId),
          requestedFactIds: [],
          speechHash: npcContextFingerprint(context),
          turnFence: turnFence(state),
          generationPolicy: 'world-batch-v1',
          worldPrepared: true,
          responseOptional: true,
          worldPlanCommunication: {
            sourceRequestId: '00000000-0000-4000-a000-000000000000',
            roundId: state.turnController?.roundId,
            brainGeneration: brain.generation,
            cursor: 0,
          },
        },
        maxBytes,
      ),
    );
  }
  return result;
}
