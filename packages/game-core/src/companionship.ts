import {
  adjacentFootprintAnchors,
  footprintDistance,
  type GameAction,
  type GameState,
} from '@dreamwalk/contracts';
import { findPath, visible } from './index';

/** A deterministic proposal only. Execution still passes through the ordinary action reducer. */
export function companionAction(state: GameState, npcId: string): GameAction | undefined {
  const npc = state.entities[npcId];
  const agreement = state.npcBrains?.[npcId]?.living?.companionship;
  if (!npc || !agreement) return undefined;
  const leader = state.entities[agreement.actorId];
  if (!leader || leader.kind !== 'player' || npc.encounterId || leader.encounterId)
    return { kind: 'wait' };
  const crossing = agreement.crossings[0];
  const exit =
    leader.mapId !== npc.mapId && crossing?.mapId === npc.mapId
      ? state.maps[npc.mapId]?.exits.find(
          (e) => e.id === crossing.exitId && e.destinationMapId === crossing.destinationMapId,
        )
      : undefined;
  if (leader.mapId !== npc.mapId && !exit) return { kind: 'wait' };
  if (!exit && (!visible(state, npc, leader) || footprintDistance(npc, leader) <= 1))
    return { kind: 'wait' };
  if (exit && footprintDistance(npc, exit) <= 1) return { kind: 'transition', targetId: exit.id };
  const target = exit ?? leader;
  const paths = adjacentFootprintAnchors(npc, target)
    .map((point) => findPath(state, npc.mapId, npc, point, npcId, true))
    .filter((path) => path && path.length > 0)
    .sort((a, b) => a!.length - b!.length);
  const path = paths[0];
  if (!path) return { kind: 'wait' };
  const limit = state.turnController?.ruleset.movement ?? 1;
  return { kind: 'move_to', target: path[Math.min(path.length, limit) - 1] };
}
