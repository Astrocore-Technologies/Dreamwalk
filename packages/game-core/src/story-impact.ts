import {
  actorLifeState,
  isActorConscious,
  narrativeImpactSchema,
  turnRulesSchema,
  type GameState,
  type GameResult,
  type NarrativeImpact,
  type Locale,
  type StoryTurnInput,
} from '@dreamwalk/contracts';
import { observedVisible } from './observation-visibility';
import { transitionNpcLifeState } from './lifecycle';
import { matchesTurnFence } from './turns';
import { parseStorySegments } from './story-turn';

export function narrativeImpactOutcomeText(
  effect: NarrativeImpact['effect'],
  locale: Locale = 'en',
) {
  const copy: Record<NarrativeImpact['effect'], Record<Locale, string>> = {
    harm: {
      en: 'The attempt causes an injury.',
      ru: 'Попытка приводит к ранению.',
      uk: 'Спроба призводить до поранення.',
    },
    blocked: {
      en: 'The attempt does not affect the target.',
      ru: 'Попытка не меняет состояние цели.',
      uk: 'Спроба не змінює стан цілі.',
    },
    unconscious: {
      en: 'The character loses consciousness.',
      ru: 'Персонаж теряет сознание.',
      uk: 'Персонаж втрачає свідомість.',
    },
    death: { en: 'The character dies.', ru: 'Персонаж погибает.', uk: 'Персонаж гине.' },
    recover: {
      en: 'The character regains consciousness.',
      ru: 'Персонаж приходит в сознание.',
      uk: 'Персонаж приходить до тями.',
    },
    revive: {
      en: 'The character returns to life.',
      ru: 'Персонаж возвращается к жизни.',
      uk: 'Персонаж повертається до життя.',
    },
  };
  return copy[effect][locale];
}

/** The director can adjudicate broad fictional attempts without a command or
 * inventory prerequisite. Lifecycle effects remain explicit, durable and replay-safe. */
export function storyImpactContext(state: GameState, actorId: string) {
  const actor = state.entities[actorId];
  const rules = state.turnController?.ruleset ?? turnRulesSchema.parse({});
  return Object.values(state.entities)
    .filter(
      (target) =>
        actor?.kind === 'player' &&
        isActorConscious(actor) &&
        target.kind === 'npc' &&
        !target.encounterId &&
        observedVisible(state, actor, target),
    )
    .map((target) => {
      const vitality = target.vitality ?? target.maxVitality ?? rules.vitality;
      const lifeState = actorLifeState(target);
      const allowedEffects: NarrativeImpact['effect'][] =
        lifeState === 'dead'
          ? ['blocked', 'revive']
          : lifeState === 'unconscious'
            ? ['blocked', 'death', 'recover', ...(vitality > 0 ? ['harm' as const] : [])]
            : ['blocked', 'harm', 'unconscious', 'death'];
      return {
        lifeState,
        lifeRevision: target.lifeRevision ?? 0,
        allowedEffects,
        targetId: target.id,
        label: target.label,
        revision: target.revision,
        vitality,
        maxDamage: Math.max(0, Math.min(rules.hitDamage, vitality)),
      };
    });
}

export function applyStoryImpact(
  state: GameState,
  actorId: string,
  turnId: string,
  segmentIndex: number,
  raw: NarrativeImpact,
  input: StoryTurnInput,
): GameResult {
  const reject = (error: GameResult['error']): GameResult => ({ state, events: [], error });
  const parsed = narrativeImpactSchema.safeParse(raw);
  const actor = state.entities[actorId],
    turn = state.narrativeCanon?.turns.find((entry) => entry.id === turnId);
  if (
    !parsed.success ||
    actor?.kind !== 'player' ||
    !isActorConscious(actor) ||
    actor.encounterId ||
    !['say', 'whisper'].includes(input.channel) ||
    !turn ||
    turn.actorId !== actorId ||
    parseStorySegments(input.text).segments[segmentIndex]?.kind !== 'attempt'
  )
    return reject('FORBIDDEN');
  const impact = parsed.data;
  if (turn.impact)
    return turn.impact.targetId === impact.targetId &&
      turn.impact.effect === impact.effect &&
      turn.impact.segmentIndex === segmentIndex
      ? { state, events: [] }
      : reject('STALE_STATE');
  const target = storyImpactContext(state, actorId).find(
    (entry) => entry.targetId === impact.targetId,
  );
  if (!target) return reject('TARGET_UNAVAILABLE');
  const controller = state.turnController;
  if (
    controller &&
    (!input.turnFence ||
      !matchesTurnFence(state, input.turnFence) ||
      controller.pendingResolution ||
      controller.phase !== 'world')
  )
    return reject('STALE_STATE');
  if (
    !target.allowedEffects.includes(impact.effect) ||
    (impact.effect === 'harm' && target.maxDamage <= 0)
  )
    return reject('FORBIDDEN');
  const next = structuredClone(state),
    affected = next.entities[impact.targetId];
  const damage =
    impact.effect === 'death' ? target.vitality : impact.effect === 'harm' ? target.maxDamage : 0;
  const vitalityAfter = ['recover', 'revive'].includes(impact.effect)
    ? Math.max(1, target.vitality)
    : target.vitality - damage;
  const lifeStateAfter =
    impact.effect === 'death'
      ? 'dead'
      : impact.effect === 'unconscious' || (impact.effect === 'harm' && vitalityAfter === 0)
        ? 'unconscious'
        : ['recover', 'revive'].includes(impact.effect)
          ? 'conscious'
          : target.lifeState;
  next.narrativeCanon!.turns.find((entry) => entry.id === turnId)!.impact = {
    segmentIndex,
    targetId: impact.targetId,
    effect: impact.effect,
    damage,
    lifeStateBefore: target.lifeState,
    lifeStateAfter,
    vitalityBefore: target.vitality,
    vitalityAfter,
  };
  next.revision++;
  next.tick++;
  const events: GameResult['events'] = [];
  if (impact.effect !== 'blocked') {
    affected.maxVitality ??= controller?.ruleset.vitality ?? turnRulesSchema.parse({}).vitality;
    affected.vitality = vitalityAfter;
    affected.revision++;
    delete affected.path;
  }
  if (damage) {
    affected.feedback = { kind: 'hit', sequence: next.revision, dx: 0, dy: 0 };
    events.push({ kind: 'action.hit', actorId, targetId: affected.id, mapId: affected.mapId });
  }
  if (lifeStateAfter !== target.lifeState) {
    transitionNpcLifeState(next, affected.id, lifeStateAfter);
    const kind =
      lifeStateAfter === 'dead'
        ? 'actor.died'
        : lifeStateAfter === 'unconscious'
          ? 'actor.lost_consciousness'
          : target.lifeState === 'dead'
            ? 'actor.revived'
            : 'actor.regained_consciousness';
    events.push({ kind, actorId, targetId: affected.id, mapId: affected.mapId });
  }
  if (impact.effect === 'blocked')
    events.push({
      kind: 'narrative.impact_blocked',
      actorId,
      targetId: affected.id,
      mapId: affected.mapId,
    });
  return { state: next, events };
}
