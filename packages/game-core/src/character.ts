import type {
  LivingNpcMemory,
  NpcCharacterization,
  NpcObservation,
  NpcRelationship,
} from '@dreamwalk/contracts';
import { isUnestablishedStoryPickup } from './item-observations';

type Trigger = NpcCharacterization['reactions'][number]['trigger'];
type Response = NpcCharacterization['reactions'][number]['response'];
type Stance = NpcCharacterization['reactions'][number]['publicStance'];

export function characterTrigger(observation: NpcObservation, npcId?: string): Trigger | undefined {
  if (['harmed', 'pushed'].includes(observation.kind)) return 'threat';
  if (observation.kind === 'helped') return 'help';
  if (
    observation.kind === 'item_taken' &&
    observation.confidence === 'witnessed' &&
    !isUnestablishedStoryPickup(observation)
  )
    return 'betrayal';
  if (
    observation.kind === 'addressed' ||
    (observation.kind === 'said' && npcId && observation.addressedNpcId === npcId)
  )
    return 'request';
  if (['noise', 'claim', 'item_missing'].includes(observation.kind)) return 'uncertainty';
  return undefined;
}

/** Fictional, evidence-backed intent, NOT a model's hidden reasoning transcript.
 * Derived from persisted character/evidence so it cannot drift as a second state store.
 */
export function characterAppraisal(
  memory: LivingNpcMemory,
  observation?: NpcObservation,
  npcId?: string,
) {
  const profile = memory.personality.characterization;
  if (!profile) return undefined;
  const source =
    observation ??
    [...memory.observations]
      .filter((o) => characterTrigger(o, npcId))
      .sort((a, b) => b.tick - a.tick || b.id.localeCompare(a.id))[0];
  const trigger = source && characterTrigger(source, npcId);
  const relevance = (kind: NpcCharacterization['motives'][number]['kind']) =>
    trigger === 'threat' && ['protect', 'duty'].includes(kind)
      ? 3
      : trigger === 'betrayal' && ['protect', 'prosper'].includes(kind)
        ? 2
        : trigger === 'uncertainty' && kind === 'discover'
          ? 2
          : (trigger === 'request' || trigger === 'help') && ['care', 'belong'].includes(kind)
            ? 1
            : 0;
  const motive = [...profile.motives].sort(
    (a, b) =>
      b.priority + relevance(b.kind) - (a.priority + relevance(a.kind)) ||
      a.kind.localeCompare(b.kind),
  )[0];
  const authored = profile.reactions.find((r) => r.trigger === trigger);
  const relation = source?.actorId ? memory.relationships[source.actorId] : undefined;
  let response: Response = 'observe';
  let stance: Stance = 'reserved';
  if (trigger === 'request') {
    response = ['care', 'belong'].includes(motive.kind)
      ? 'assist'
      : motive.kind === 'prosper'
        ? 'refuse'
        : 'observe';
    stance = response === 'assist' ? 'friendly' : response === 'refuse' ? 'firm' : 'reserved';
  } else if (trigger === 'threat' || trigger === 'betrayal') {
    response = ['protect', 'duty'].includes(motive.kind) ? 'warn' : 'withdraw';
    stance = 'guarded';
  } else if (trigger === 'help') {
    stance = relation && relation.trust < 0 ? 'reserved' : 'friendly';
  } else if (trigger === 'uncertainty') {
    response = motive.kind === 'discover' ? 'observe' : 'warn';
    stance = 'guarded';
  }
  if (authored) ({ response, publicStance: stance } = authored);
  // Serious accumulated conflict is not erased by one pleasing utterance.
  if (relation && relation.trust <= -2 && stance === 'friendly') stance = 'reserved';
  if (
    !authored &&
    trigger === 'request' &&
    relation?.character?.stage === 'hostile' &&
    response === 'assist'
  ) {
    response = 'observe';
    stance = 'guarded';
  }
  return {
    version: 1 as const,
    motive: motive.kind,
    trigger: trigger ?? 'routine',
    response,
    publicStance: stance,
    evidenceIds: source ? [source.id] : [],
    certainty: source?.confidence ?? 'uncertain',
  };
}

/** No free author text, motive, private evidence, relationship numbers or raw thoughts. */
export function characterPerformance(
  memory: LivingNpcMemory,
  observations: NpcObservation[],
  npcId: string,
) {
  const profile = memory.personality.characterization;
  if (!profile) return undefined;
  // Select the latest admitted interaction, not the first old trigger in a
  // relevance-packed claim list. New unclassified speech/gestures must not keep
  // replaying an earlier warning. Self-quotes and passive perception are not a
  // new social stimulus. Ties use retained source order, never opaque ID sorting.
  const sourceOrder = new Map(memory.observations.map((o, index) => [o.id, index]));
  const relevant = [...observations]
    .filter(
      (o) =>
        (o.kind === 'said' && o.actorId !== npcId) ||
        o.kind === 'attempted' ||
        o.kind === 'item_taken' ||
        !!characterTrigger(o, npcId),
    )
    .sort(
      (a, b) => b.tick - a.tick || (sourceOrder.get(b.id) ?? -1) - (sourceOrder.get(a.id) ?? -1),
    )[0];
  // Only the admitted speech evidence may select a dynamic performance. A private
  // unrelated event must not leak through a changed stance in another conversation.
  const appraisal =
    relevant && characterTrigger(relevant, npcId)
      ? characterAppraisal(memory, relevant, npcId)
      : undefined;
  return {
    version: 1 as const,
    ...profile.publicVoice,
    stance: appraisal?.publicStance ?? 'reserved',
    agency: 'npc_only' as const,
    claimScope: 'provided_evidence_only' as const,
  };
}

const bound = (n: number, minimum = -5) => Math.max(minimum, Math.min(5, n));
export function characterRelationshipStage(r: NpcRelationship) {
  if (r.trust <= -3 || (r.character?.affinity ?? 0) <= -3) return 'hostile' as const;
  if (r.trust < 0 || (r.character?.fear ?? 0) >= 2) return 'wary' as const;
  if (r.trust >= 3 && (r.character?.respect ?? 0) >= 2) return 'trusted' as const;
  if (r.trust >= 1 && (r.character?.affinity ?? 0) >= 1) return 'cooperative' as const;
  return 'neutral' as const;
}

/** Called only after root-event dedup and authoritative direct perception. No text
 * sentiment and no unverified allegation can award relationship progress.
 */
export function updateCharacterRelationship(memory: LivingNpcMemory, o: NpcObservation) {
  if (
    !memory.personality.characterization ||
    isUnestablishedStoryPickup(o) ||
    !o.actorId ||
    o.channel !== 'direct' ||
    o.confidence !== 'witnessed' ||
    !['helped', 'harmed', 'pushed', 'item_taken'].includes(o.kind)
  )
    return;
  const relation = (memory.relationships[o.actorId] ??= {
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
  // A burst within one simulation turn cannot farm several steps of affinity.
  if (character.lastChangedTick === o.tick) return;
  if (o.kind === 'helped') {
    character.affinity = bound(character.affinity + 1);
    character.respect = bound(character.respect + 1);
    character.fear = bound(character.fear - 1, 0);
  } else if (o.kind === 'harmed' || o.kind === 'pushed') {
    relation.trust = bound(relation.trust - 1);
    relation.alertness = bound(relation.alertness + 1, 0);
    character.affinity = bound(character.affinity - 1);
    character.fear = bound(character.fear + 1, 0);
  } else if (memory.personality.role === 'guard') {
    character.affinity = bound(character.affinity - 1);
    character.respect = bound(character.respect - 1);
  }
  character.lastChangedTick = o.tick;
  character.stage = characterRelationshipStage(relation);
  relation.evidenceIds = [...new Set([...relation.evidenceIds, o.id])].slice(-32);
}
