import type { GameState } from '@dreamwalk/contracts';

/** Retain exact admitted sources until their finite reply work is resolved or cancelled.
 * These IDs only prevent memory eviction; they never grant read or disclosure rights. */
export function synchronizePendingSpeechEvidence(state: GameState): void {
  const pending = new Map<string, Set<string>>();
  for (const speech of state.turnController?.deferredSpeech ?? []) {
    const ids = pending.get(speech.recipientId) ?? new Set<string>();
    ids.add(speech.utteranceId);
    pending.set(speech.recipientId, ids);
  }
  for (const [npcId, brain] of Object.entries(state.npcBrains ?? {})) {
    if (!brain.living) continue;
    const ids = pending.get(npcId);
    if (ids?.size) brain.living.pendingSpeechObservationIds = [...ids];
    else delete brain.living.pendingSpeechObservationIds;
  }
}
