import {
  entityPresentationLabels,
  presentationAliasReferencesValid,
  type PresentationAliases,
} from './presentation-aliases';
import type { GameAction, GameResult, GameState, StoryAttackOutcome } from '@dreamwalk/contracts';
import { visible } from './index';

const normalize = (value: string) =>
  value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
const word = (value: string, alternatives: string) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${alternatives})(?=$|[^\\p{L}\\p{N}_])`, 'u').test(value);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** A deliberately bounded self-attempt grammar. Speech, orders, negations and
 * uncertain pronouns do not trigger this fast path. Other prose is left to the director. */
export function parseStoryAttackAttempt(
  state: GameState,
  actorId: string,
  text: string,
  presentationAliases?: PresentationAliases,
): { kind: 'hit' | 'push'; targetId: string } | null {
  const actor = state.entities[actorId],
    value = normalize(text);
  if (
    actor?.kind !== 'player' ||
    !presentationAliasReferencesValid(state, actorId, text, presentationAliases) ||
    !value ||
    value.length > 1000 ||
    /["«»“”]/u.test(value) ||
    word(
      value,
      "not|never|don't|dont|doesn't|doesnt|would|could|might|want|wish|if|or|не|нет|хочу|хочет|хотел|хотела|если|бы|мог|могла|или|ні|хоче|хотів|якщо|би|або|says?|said|asks?|asked|говорит|сказал|сказала|спрашивает|каже|сказав|питає",
    )
  )
    return null;
  const verbs: [RegExp, 'hit' | 'push'][] = [
    [
      /^(?:hit|hits|strike|strikes|punch|punches|ударить|ударил|ударила|ударяю|ударяет|бью|вдарити|вдарив|вдарила|вдаряю|б'ю|б’ю)\s+(.+)$/u,
      'hit',
    ],
    [
      /^(?:push|pushes|shove|shoves|толкнуть|толкнул|толкнула|толкаю|толкает|штовхнути|штовхнув|штовхнула|штовхаю|штовхає)\s+(.+)$/u,
      'push',
    ],
  ];
  const names = [actor.id, actor.label ?? '', ...Object.values(actor.labelTranslations ?? {})]
    .map(normalize)
    .filter(Boolean)
    .map(escape)
    .join('|');
  const self = value.replace(
    new RegExp(
      `^(?:(?:i|я|${names})\\s+)?(?:(?:carefully|slowly|осторожно|аккуратно|обережно)\\s+)?`,
      'u',
    ),
    '',
  );
  for (const [pattern, kind] of verbs) {
    const match = pattern.exec(self);
    if (!match) continue;
    // Bind the target to this verb, never a later clause or an incidental mention.
    const clause = match[1]
      .split(/[,;.!?]|\s+(?:and|but|и|а|но|і|та|але)\s+/u)[0]
      .replace(/^(?:at\s+|the\s+|в\s+|у\s+|по\s+)/u, '');
    const candidates = Object.values(state.entities).filter(
      (target) =>
        target.id !== actorId &&
        ['player', 'npc'].includes(target.kind) &&
        visible(state, actor, target) &&
        entityPresentationLabels(state, actorId, target, presentationAliases).some((label) => {
          const name = normalize(label);
          return (
            name.length > 1 &&
            new RegExp(`^${escape(name)}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(clause)
          );
        }),
    );
    return candidates.length === 1 ? { kind, targetId: candidates[0].id } : null;
  }
  return null;
}

export function storyContactAction(
  state: GameState,
  actorId: string,
  text: string,
  presentationAliases?: PresentationAliases,
): GameAction | null {
  const attempt = parseStoryAttackAttempt(state, actorId, text, presentationAliases);
  return attempt;
}

export function storyContactOutcomeCode(result: GameResult): StoryAttackOutcome['code'] {
  if (result.error) return result.error;
  if (result.events.some((event) => event.kind === 'turn.reaction_started'))
    return 'ACTION_PENDING';
  if (result.events.some((event) => event.kind === 'action.push_blocked')) return 'PUSH_BLOCKED';
  return 'ACTION_SUCCEEDED';
}

/** Free-form director turns must not lose semantic terminal outcomes to a
 * limited mechanical keyword recognizer. Explicit action APIs remain unchanged. */
export function isNpcStoryContact(state: GameState, action: GameAction | null): boolean {
  return (
    !!action &&
    ['hit', 'push'].includes(action.kind) &&
    state.entities[action.targetId ?? '']?.kind === 'npc'
  );
}
