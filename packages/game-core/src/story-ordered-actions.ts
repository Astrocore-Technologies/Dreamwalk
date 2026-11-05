import { hasPosition } from '@dreamwalk/contracts';
import type { GameAction, GameResult, GameState, StoryTurnInput } from '@dreamwalk/contracts';
import { applyAction } from './index';
import { applyTurnAction, matchesTurnFence } from './turns';

/** Finish an already submitted, ordered player attempt during its director phase.
 * This is the ordinary reducer with the original player's remaining resources,
 * not another world-NPC action or a general budget bypass. */
export function applyStoryOrderedAction(
  state: GameState,
  actorId: string,
  action: GameAction,
  input: StoryTurnInput,
): GameResult {
  if (!hasPosition(state.entities[actorId]) && action.kind !== 'wait')
    return { state, events: [], error: 'WRONG_MODE' };
  const turn = state.turnController;
  if (!turn) return applyAction(state, actorId, action);
  if (turn.phase === 'player' && input.turnFence)
    return applyTurnAction(state, actorId, action, input.turnFence);
  if (
    turn.phase !== 'world' ||
    turn.pendingResolution ||
    !input.turnFence ||
    !matchesTurnFence(state, input.turnFence) ||
    !turn.actorOrder.includes(actorId)
  )
    return { state, events: [], error: 'STALE_STATE' };
  const staged = structuredClone(state);
  staged.turnController!.phase = 'player';
  staged.turnController!.activeActorId = actorId;
  const result = applyTurnAction(staged, actorId, action, input.turnFence);
  if (result.error) return { ...result, state };
  const after = result.state.turnController!;
  if (after.phase === 'reaction' && after.reaction) {
    after.reaction.resumePhase = 'world';
    after.reaction.resumeActorId = turn.activeActorId;
  } else {
    after.phase = turn.phase;
    after.activeActorId = turn.activeActorId;
  }
  return result;
}
