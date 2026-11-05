import type { GameResult, GameState, NpcSocialReaction } from '@dreamwalk/contracts';
import { characterRelationshipStage } from './character';
import { npcContextFingerprint } from './living';

/** A private interpretation of heard words, not verification of their truth.
 * Replays, repeated text and old evidence cannot award further social progress.
 * No trust/debt/alertness, permissions, world facts or promises are changed.
 */
export function applyNpcSocialReactions(
  state: GameState,
  npcId: string,
  reactions: NpcSocialReaction[],
): GameResult {
  const memory = state.npcBrains?.[npcId]?.living;
  if (!memory || new Set(reactions.map((r) => r.actorId)).size !== reactions.length)
    return { state, events: [], error: 'FORBIDDEN' };
  for (const reaction of reactions) {
    const source = memory.observations.find((o) => o.id === reaction.observationId);
    if (
      !source ||
      source.actorId !== reaction.actorId ||
      source.actorId === npcId ||
      !['player', 'npc'].includes(state.entities[reaction.actorId]?.kind) ||
      source.kind !== 'said' ||
      source.channel !== 'report' ||
      source.confidence !== 'reported' ||
      source.depth !== 0 ||
      (source.sourceNpcId !== undefined && source.sourceNpcId !== source.actorId) ||
      !source.text?.trim()
    )
      return { state, events: [], error: 'FORBIDDEN' };
  }
  const next = structuredClone(state),
    m = next.npcBrains![npcId].living!;
  let changed = false;
  for (const reaction of reactions) {
    const source = m.observations.find((o) => o.id === reaction.observationId)!;
    const previous = m.relationships[reaction.actorId];
    const textKey = npcContextFingerprint(
      source
        .text!.normalize('NFKC')
        .toLowerCase()
        .replace(/[\p{P}\p{Z}\s]+/gu, ' ')
        .trim(),
    );
    if (
      (!reaction.affinity && !reaction.respect && !reaction.fear) ||
      (previous?.social &&
        (source.tick <= previous.social.lastObservedTick ||
          previous.social.lastChangedTick === state.tick ||
          (state.turnController && previous.social.lastRoundId === state.turnController.roundId) ||
          previous.social.recentTextKeys.includes(textKey))) ||
      previous?.evidenceIds.includes(source.id)
    )
      continue;
    const relation = (m.relationships[reaction.actorId] ??= {
      trust: 0,
      alertness: 0,
      debt: 0,
      evidenceIds: [],
    });
    const character = (relation.character ??= {
      affinity: 0,
      respect: 0,
      fear: 0,
      lastChangedTick: -1,
      stage: 'neutral',
    });
    const bound = (value: number, minimum = -5) => Math.max(minimum, Math.min(5, value));
    character.affinity = bound(character.affinity + reaction.affinity);
    character.respect = bound(character.respect + reaction.respect);
    character.fear = bound(character.fear + reaction.fear, 0);
    // Keep the independent physical-event dedup clock unchanged.
    // A social appraisal must not suppress a later witnessed action in this tick.
    character.stage = characterRelationshipStage(relation);
    relation.evidenceIds = [...new Set([...relation.evidenceIds, source.id])].slice(-32);
    const sourceAudience = source.disclosure === 'public' ? undefined : (source.audienceIds ?? []);
    const previousAudience = relation.social?.audienceIds;
    const audienceIds = previousAudience
      ? sourceAudience
        ? previousAudience.filter((id) => sourceAudience.includes(id))
        : previousAudience
      : sourceAudience;
    relation.social = {
      affinity: bound((relation.social?.affinity ?? 0) + reaction.affinity),
      respect: bound((relation.social?.respect ?? 0) + reaction.respect),
      fear: bound((relation.social?.fear ?? 0) + reaction.fear, 0),
      ...(audienceIds ? { audienceIds: [...audienceIds] } : {}),
      lastObservedTick: source.tick,
      lastChangedTick: state.tick,
      ...(state.turnController ? { lastRoundId: state.turnController.roundId } : {}),
      recentTextKeys: [...(relation.social?.recentTextKeys ?? []), textKey].slice(-32),
    };
    changed = true;
  }
  if (!changed) return { state, events: [] };
  m.knowledgeRevision++;
  m.summary = undefined;
  next.revision++;
  return { state: next, events: [] };
}
