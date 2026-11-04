import {
  footprintDistance,
  adjacentFootprintAnchors,
  npcActionIntentSchema,
  type GameAction,
  type GameState,
  type GameResult,
} from '@dreamwalk/contracts';
import { findPath, walkable } from './index';
import { observedVisible } from './observation-visibility';
import { applyWorldTurnAction, turnFence } from './turns';
import { npcActionAllowed } from './living-policy';

/** Public reply context is the intersection of the NPC's and listeners' perception. */
export function npcActionContext(state: GameState, npcId: string, audienceIds: string[]) {
  const npc = state.entities[npcId];
  if (
    !npc ||
    audienceIds.some(
      (id) => !state.entities[id] || !observedVisible(state, state.entities[id], npc),
    )
  )
    return { moveTargets: [], targets: [] };
  const perceived = (target: { x: number; y: number }) => {
    const cell = {
      id: 'action-cell',
      kind: 'item' as const,
      revision: 0,
      mapId: npc.mapId,
      ...target,
    };
    return (
      observedVisible(state, npc, cell) &&
      audienceIds.every(
        (id) => state.entities[id] && observedVisible(state, state.entities[id], cell),
      )
    );
  };
  const moveTargets = [];
  for (let y = npc.y - 9; y <= npc.y + 9; y++)
    for (let x = npc.x - 9; x <= npc.x + 9; x++)
      if (walkable(state, npc.mapId, { x, y }, npcId, true) && perceived({ x, y }))
        moveTargets.push({ x, y });
  moveTargets.sort(
    (a, b) =>
      Math.abs(a.x - npc.x) +
        Math.abs(a.y - npc.y) -
        Math.abs(b.x - npc.x) -
        Math.abs(b.y - npc.y) ||
      a.x - b.x ||
      a.y - b.y,
  );
  return {
    mapId: npc.mapId,
    position: { x: npc.x, y: npc.y },
    moveTargets: moveTargets.slice(0, 128),
    targets: Object.values(state.entities)
      .filter(
        (e) =>
          e.id !== npcId &&
          !e.ownerId &&
          observedVisible(state, npc, e) &&
          audienceIds.every((id) => observedVisible(state, state.entities[id], e)),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 32)
      .map((e) => ({ id: e.id, label: e.label, kind: e.kind, x: e.x, y: e.y })),
  };
}

/** The model chooses only this NPC's voluntary actions; requests are not execution. */
export function prepareNpcActionIntent(
  state: GameState,
  npcId: string,
  audienceIds: string[],
  input: unknown,
): GameAction[] | undefined {
  const parsed = npcActionIntentSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const npc = state.entities[npcId],
    context = npcActionContext(state, npcId, audienceIds);
  const actions: GameAction[] = [];
  let endpoint = { ...npc };
  for (const action of parsed.data.actions) {
    if (action.kind === 'move_to') {
      if (
        !context.moveTargets.some((p) => p.x === action.target.x && p.y === action.target.y) ||
        !findPath(state, npc.mapId, npc, action.target, npcId, true)
      )
        return undefined;
      actions.push(action);
      endpoint = { ...endpoint, ...action.target };
    } else if (action.kind === 'approach') {
      if (!context.targets.some((e) => e.id === action.targetId)) return undefined;
      const target = state.entities[action.targetId];
      const paths = adjacentFootprintAnchors(npc, target)
        .map((p) => findPath(state, npc.mapId, npc, p, npcId, true))
        .filter((p) => p !== null)
        .sort((a, b) => a!.length - b!.length);
      if (!paths.length) return undefined;
      const path = paths[0]!;
      actions.push(path.length ? { kind: 'move_to', target: path.at(-1)! } : { kind: 'wait' });
      if (path.length) endpoint = { ...endpoint, ...path.at(-1)! };
    } else {
      if (action.kind === 'inspect' && !context.targets.some((e) => e.id === action.targetId))
        return undefined;
      if (
        action.kind === 'inspect' &&
        footprintDistance(endpoint, state.entities[action.targetId]) > 1
      )
        return undefined;
      actions.push(action);
    }
    if (!npcActionAllowed(state, npcId, actions.at(-1)!)) return undefined;
  }
  return actions;
}

function withNpcActionOutcome(
  result: GameResult,
  npcId: string,
  actionKind: string,
  status: 'completed' | 'progressed' | 'blocked',
  code?: string,
): GameResult {
  if (!result.state.npcBrains?.[npcId]?.living) return result;
  const state = structuredClone(result.state);
  state.npcBrains![npcId].living!.lastActionOutcome = {
    actionKind,
    status,
    ...(code ? { code } : {}),
    tick: state.tick,
    ...(state.turnController ? { roundId: state.turnController.roundId } : {}),
  };
  state.revision++;
  return { ...result, state };
}

/** One ordinary action per world phase. Long paths continue, with fresh collision checks. */
export function stepWorldNpcPlan(state: GameState, npcId: string): GameResult {
  if (state.turnController?.phase !== 'world') return { state, events: [], error: 'WRONG_MODE' };
  const original = state.npcBrains?.[npcId],
    entity = state.entities[npcId];
  if (!original || entity?.kind !== 'npc')
    return { state, events: [], error: 'TARGET_UNAVAILABLE' };
  if (original.cursor >= original.plan.length) return { state, events: [] };
  if (
    entity.encounterId ||
    (original.planMapId && original.planMapId !== entity.mapId) ||
    (original.movementGeneration !== undefined &&
      original.movementGeneration !== (entity.movementGeneration ?? 0))
  ) {
    const next = structuredClone(state),
      brain = next.npcBrains![npcId];
    brain.plan = [];
    delete brain.planSource;
    brain.cursor = 0;
    brain.waitingForPath = false;
    next.entities[npcId].path = [];
    next.revision++;
    return {
      state: next,
      events: [
        { kind: 'npc.plan_stopped', actorId: npcId, mapId: entity.mapId, code: 'STALE_STATE' },
      ],
    };
  }
  let next = state;
  for (let skipped = 0; skipped < 3; skipped++) {
    const brain = next.npcBrains?.[npcId],
      npc = next.entities[npcId];
    if (!brain || !npc || brain.cursor >= brain.plan.length) return { state: next, events: [] };
    const planned = brain.plan[brain.cursor];
    let action = planned;
    if (planned.kind === 'move_to') {
      const path = findPath(next, npc.mapId, npc, planned.target!, npcId, true);
      if (!path)
        return withNpcActionOutcome(
          { state: next, events: [], error: 'PATH_BLOCKED' },
          npcId,
          planned.kind,
          'blocked',
          'PATH_BLOCKED',
        );
      if (!path.length) {
        next = structuredClone(next);
        next.npcBrains![npcId].cursor++;
        next.revision++;
        continue;
      }
      const limit = next.turnController?.ruleset.movement ?? 1;
      action = { kind: 'move_to', target: path[Math.min(limit, path.length) - 1] };
    }
    const result = applyWorldTurnAction(next, npcId, action, turnFence(next)!);
    if (result.error) {
      if (result.error === 'PATH_BLOCKED' || result.error === 'ROUND_LOCKED')
        return withNpcActionOutcome(result, npcId, planned.kind, 'blocked', result.error);
      const stopped = structuredClone(next),
        brain = stopped.npcBrains![npcId];
      brain.plan = [];
      brain.cursor = 0;
      delete brain.planSource;
      stopped.revision++;
      return withNpcActionOutcome(
        {
          state: stopped,
          events: [
            { kind: 'npc.plan_stopped', actorId: npcId, mapId: npc.mapId, code: result.error },
          ],
        },
        npcId,
        planned.kind,
        'blocked',
        result.error,
      );
    }
    const after = result.state === next ? structuredClone(next) : result.state;
    if (
      planned.kind !== 'move_to' ||
      (after.entities[npcId].x === planned.target!.x &&
        after.entities[npcId].y === planned.target!.y)
    )
      after.npcBrains![npcId].cursor++;
    return withNpcActionOutcome(
      { ...result, state: after },
      npcId,
      planned.kind,
      after.npcBrains![npcId].cursor > brain.cursor ? 'completed' : 'progressed',
    );
  }
  return { state: next, events: [] };
}
