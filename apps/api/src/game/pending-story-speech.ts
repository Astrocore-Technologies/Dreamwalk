import { z } from 'zod';
import { deferredTurnSpeechSchema, isActorConscious, type GameState } from '@dreamwalk/contracts';
import {
  admittedNpcSpeechObservationId,
  applyNpcSpeech,
  recordNpcEvents,
  npcReplyObservation,
} from '@dreamwalk/game-core';
const sourceSchema = z
  .object({
    actorId: z.string(),
    text: z.string().min(1).max(1000),
    channel: z.enum(['say', 'whisper']),
    identity: z.object({ turnId: z.uuid(), segmentIndex: z.number().int().min(0).max(5) }).strict(),
  })
  .strict();
export const pendingStorySpeechSchema = z
  .object({
    sources: z.array(sourceSchema).min(1).max(6),
    reference: deferredTurnSpeechSchema
      .extend({
        actorId: z.string(),
        sequence: z.number().int().nonnegative(),
        roundId: z.string(),
        phaseEpoch: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
/** Price a possible reply without admitting the user's future words into live memory.
 * This virtual view is allowed only while the server's pending reference exists. */
export function previewPendingStorySpeech(
  state: GameState,
  npcId: string,
  context: Record<string, unknown>,
): GameState {
  const ref = state.turnController?.deferredSpeech.find(
    (entry) => entry.id === context.deferredSpeechId,
  );
  if (!ref?.pendingStoryTurnId) return state;
  const parsed = pendingStorySpeechSchema.safeParse(context.pendingStorySpeech);
  if (
    !parsed.success ||
    parsed.data.reference.id !== ref.id ||
    parsed.data.reference.recipientId !== npcId ||
    parsed.data.sources.some(
      (source) =>
        source.identity.turnId !== ref.pendingStoryTurnId || source.actorId !== ref.actorId,
    ) ||
    !isActorConscious(state.entities[npcId]) ||
    Number(context.lifeRevision ?? 0) !== (state.entities[npcId].lifeRevision ?? 0)
  )
    throw new Error('STALE_STATE');
  let virtual = structuredClone(state);
  for (const source of parsed.data.sources) {
    const speech = { channel: source.channel, text: source.text };
    if (admittedNpcSpeechObservationId(virtual, source.actorId, npcId, speech, source.identity))
      continue;
    const result = applyNpcSpeech(virtual, source.actorId, undefined, speech, {
      suppressReply: true,
      identity: source.identity,
    });
    if (result.error) throw new Error(result.error);
    virtual = recordNpcEvents(
      virtual,
      result.state,
      result.events,
      `pending:${source.identity.turnId}:${source.identity.segmentIndex}`,
    ).state;
  }
  const admitted = virtual.turnController!.deferredSpeech.find((entry) => entry.id === ref.id)!;
  delete admitted.pendingStoryTurnId;
  return virtual;
}
/** Run after the ordered director outcome. Missing or incapacitated listeners
 * never gain a source/reference merely because their reply was forecast. */
export function settlePendingStorySpeech(state: GameState, turnId: string): GameState {
  if (!state.turnController?.deferredSpeech.some((ref) => ref.pendingStoryTurnId === turnId))
    return state;
  const next = structuredClone(state);
  next.turnController!.deferredSpeech = next.turnController!.deferredSpeech.flatMap((ref) => {
    if (ref.pendingStoryTurnId !== turnId) return [ref];
    if (
      !isActorConscious(next.entities[ref.recipientId]) ||
      !npcReplyObservation(next, ref.actorId, ref.recipientId, ref.utteranceId)
    )
      return [];
    const admitted = { ...ref };
    delete admitted.pendingStoryTurnId;
    return [admitted];
  });
  next.revision++;
  return next;
}
