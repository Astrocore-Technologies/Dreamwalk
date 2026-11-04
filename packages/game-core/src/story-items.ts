import {
  footprintDistance,
  type GameAction,
  type GameEntity,
  type GameResult,
  type GameState,
  type StoryTurnInput,
  type StoryTurnProposal,
} from '@dreamwalk/contracts';
import { applyUnbudgetedAction, visible } from './index';
import { turnActionCost } from './turns';

const normalize = (text: string) =>
  text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
const word = (text: string, expression: string) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${expression})(?=$|[^\\p{L}\\p{N}_])`, 'u').test(text);

/** Only an explicit physical attempt can authorize a pickup, never speech or a wish.
 * Labels remain exact, bounded references: uncertain pronouns/inflections are not guesses. */
export function explicitStoryPickup(text: string, labels: string[]): boolean {
  const value = normalize(text);
  if (
    !value ||
    value.length > 1000 ||
    word(
      value,
      "not|never|don't|dont|would|could|might|want|wish|if|не|нет|хочу|хочет|хотел|хотела|если|бы|мог|могла|ні|хоче|хотів|якщо|би",
    ) ||
    word(
      value,
      'says?|said|asks?|asked|говорит|сказал|сказала|спрашивает|каже|сказав|сказала|питає',
    )
  )
    return false;
  if (/["«»“”]/u.test(value)) return false;
  const verbs =
    'pick(?:s|ed|ing)? up|take|takes|took|taking|grab|grabs|grabbed|pocket|pockets|pocketed|беру|берет|берёт|взял|взяла|возьми|поднимаю|поднимает|поднимают|поднял|подняла|подымает|подымаю|піднімаю|піднімає|підняв|підняла|бере|взяв|візьми|put|puts|putting|place|placed|положил|положила|кладу|кладет|кладёт|поклав|поклала|кладе';
  const match = new RegExp(`(?:^|[^\\p{L}\\p{N}_])(${verbs})(?=$|[^\\p{L}\\p{N}_])`, 'u').exec(
    value,
  );
  if (!match) return false;
  // RP uses implicit self (including third-person gestures), but an explicitly
  // named other subject or an instruction to an NPC cannot move the player's items.
  const prefix = value.slice(0, match.index).trim();
  if (
    prefix &&
    !/^(?:(?:i|я)\s*)?(?:(?:carefully|slowly|осторожно|аккуратно|обережно)\s*)?$/u.test(prefix)
  ) {
    const gestures = prefix.replace(/(?:[,;]\s*|\s+(?:and|и|і|та)\s*)(?:(?:i|я)\s*)?$/u, '');
    if (
      gestures === prefix ||
      !gestures
        .split(/[,;]|\s+(?:and|и|і|та)\s+/u)
        .every((clause) =>
          /^(?:(?:i|я)\s+)?(?:look|looks|looked|crouch|crouches|crouched|смотрю|смотрит|посмотрел|посмотрела|нагнулся|нагнулась|наклоняется|дивлюся|дивиться|подивився|подивилась)(?=$|[^\p{L}\p{N}_])/u.test(
            clause.trim(),
          ),
        )
    )
      return false;
  }
  // Bind the named object to this acquisition clause, not a later look/speech clause.
  const clause = value
    .slice(match.index + match[0].length)
    .split(/[,;.!?]|\s+(?:and|but|и|а|но|і|та|але)\s+/u)[0];
  if (
    word(
      match[1],
      'put|puts|putting|place|placed|положил|положила|кладу|кладет|кладёт|поклав|поклала|кладе',
    ) &&
    !word(clause, 'pocket|bag|backpack|карман|кармане|сумку|рюкзак|кишеню|кишені|торбу|наплічник')
  )
    return false;
  return labels.some((label) => {
    const name = normalize(label),
      position = clause.indexOf(name);
    return (
      name.length > 1 &&
      position >= 0 &&
      (position === 0 || !/[\p{L}\p{N}_]/u.test(clause[position - 1])) &&
      (position + name.length === clause.length ||
        !/[\p{L}\p{N}_]/u.test(clause[position + name.length]))
    );
  });
}

export function parseStoryItemAction(
  state: GameState,
  actorId: string,
  text: string,
): GameAction | null {
  const actor = state.entities[actorId];
  if (actor?.kind !== 'player') return null;
  const candidates = Object.values(state.entities).filter(
    (item) =>
      item.kind === 'item' &&
      (visible(state, actor, item) ||
        (item.ownerId === actorId && actor.inventory?.includes(item.id))) &&
      explicitStoryPickup(text, [
        item.id,
        item.label ?? '',
        ...Object.values(item.labelTranslations ?? {}),
      ]),
  );
  return candidates.length === 1 ? { kind: 'pick_up', targetId: candidates[0].id } : null;
}

const fail = (state: GameState, error: GameResult['error']): GameResult => ({
  state,
  events: [],
  error,
});

/** A new prop has no powers, monetary value, lock capability, stock or alleged prior owner. */
export function materializeStoryItem(
  state: GameState,
  actorId: string,
  turnId: string,
  proposal: NonNullable<StoryTurnProposal['narrative']>['newItem'],
): GameResult {
  if (!proposal) return { state, events: [] };
  const actor = state.entities[actorId];
  if (actor?.kind !== 'player' || actor.encounterId) return fail(state, 'FORBIDDEN');
  const id = `prop-${turnId}`;
  if (
    state.entities[id] ||
    Object.values(state.entities).some((entity) =>
      [entity.id, entity.label ?? '', ...Object.values(entity.labelTranslations ?? {})].some(
        (label) => normalize(label) === normalize(proposal.name),
      ),
    )
  )
    return fail(state, 'INVALID_ACTION');
  if (
    Object.values(state.entities).filter((entity) => entity.kind === 'item').length >=
    (state.worldItemRules?.maxWorldItems ?? 64)
  )
    return fail(state, 'RATE_LIMITED');
  const next = structuredClone(state);
  next.entities[id] = {
    id,
    kind: 'item',
    label: proposal.name,
    mapId: actor.mapId,
    x: actor.x,
    y: actor.y,
    revision: 0,
    item: {
      definitionId: id,
      quantity: 1,
      portable: true,
      edible: false,
      restoreVitality: 0,
      visual: 'object',
    },
  };
  next.revision++;
  return {
    state: next,
    events: [{ kind: 'narrative.item_created', actorId, targetId: id, mapId: actor.mapId }],
  };
}

/** Resolve the current explicit RP pickup, including a deferred same-round world reply.
 * Normal visibility, ownership, capacity and action budgets still apply. */
export function applyStoryPickup(
  state: GameState,
  actorId: string,
  itemId: string,
  text: string,
  input: StoryTurnInput,
): GameResult {
  const actor = state.entities[actorId],
    item: GameEntity | undefined = state.entities[itemId];
  if (
    actor?.kind !== 'player' ||
    item?.kind !== 'item' ||
    !explicitStoryPickup(text, [
      item.id,
      item.label ?? '',
      ...Object.values(item.labelTranslations ?? {}),
    ])
  )
    return fail(state, 'FORBIDDEN');
  const turn = state.turnController;
  if (
    turn &&
    (turn.phase !== 'world' ||
      turn.pendingResolution ||
      !input.turnFence ||
      input.turnFence.roundId !== turn.roundId ||
      input.turnFence.phaseEpoch !== turn.phaseEpoch ||
      input.turnFence.rulesetVersion !== turn.ruleset.version)
  )
    return fail(state, 'STALE_STATE');
  if (item.ownerId === actorId && actor.inventory?.includes(item.id)) return { state, events: [] };
  if (item.ownerId || !visible(state, actor, item)) return fail(state, 'TARGET_UNAVAILABLE');
  if (footprintDistance(actor, item) > 1) return fail(state, 'OUT_OF_RANGE');
  const action: GameAction = { kind: 'pick_up', targetId: itemId },
    cost = turnActionCost(action);
  if (turn && cost && (turn.resources[actorId]?.[cost] ?? 0) <= 0)
    return fail(state, 'ROUND_LOCKED');
  const result = applyUnbudgetedAction(state, actorId, action);
  if (result.error) return result;
  if (turn && cost) {
    result.state.turnController!.resources[actorId][cost]--;
    result.state.tick++;
  }
  return result;
}
