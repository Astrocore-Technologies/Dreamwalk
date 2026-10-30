import {
  npcPlanProposalSchema,
  type GameAction,
  type GameEntity,
  type GameEvent,
  type GameResult,
  type GameState,
} from '@dreamwalk/contracts';
import { applyAction, findPath, visible, walkable } from './index';
const result = (state: GameState, events: GameEvent[] = []): GameResult => ({ state, events });
const near = (a: GameEntity, b: GameEntity) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= 1;
/** Deterministic free provider. Inputs contain observed facts, never arbitrary code/tools. */
export function createMockNpcPlan(state: GameState, id: string): unknown {
  const npc = state.entities[id],
    brain = state.npcBrains?.[id];
  if (!npc || !brain) return null;
  const actions: GameAction[] = [];
  const recipient = Object.values(state.entities)
    .filter(
      (e) =>
        e.kind === 'player' &&
        visible(state, npc, e) &&
        !brain.facts.some((f) => f.kind === 'helped' && f.targetId === e.id),
    )
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (brain.goal === 'help' && recipient && npc.inventory?.length) {
    if (!near(npc, recipient)) {
      const target = [
        { x: recipient.x - 1, y: recipient.y },
        { x: recipient.x + 1, y: recipient.y },
        { x: recipient.x, y: recipient.y - 1 },
        { x: recipient.x, y: recipient.y + 1 },
      ].find((p) => walkable(state, npc.mapId, p, id) && findPath(state, npc.mapId, npc, p, id));
      if (target) actions.push({ kind: 'move_to', target });
    }
    actions.push({ kind: 'give', targetId: recipient.id, itemId: npc.inventory[0] });
  }
  actions.push({ kind: 'move_to', target: brain.patrolTarget });
  const targetRevisions: Record<string, number> = {};
  for (const action of actions)
    if (action.targetId)
      targetRevisions[action.targetId] = state.entities[action.targetId].revision;
  return {
    contextRevision: state.revision,
    mapRevision: state.maps[npc.mapId].revision,
    entityRevision: npc.revision,
    brainGeneration: brain.generation,
    deadlineTick: state.tick + 160,
    actions: actions.slice(0, 3),
    targetRevisions,
  };
}
export function acceptNpcPlan(state: GameState, id: string, input: unknown): GameResult {
  const npc = state.entities[id],
    brain = state.npcBrains?.[id];
  if (npc?.kind !== 'npc' || !brain) return { ...result(state), error: 'FORBIDDEN' };
  const parsed = npcPlanProposalSchema.safeParse(input);
  if (!parsed.success) return { ...result(state), error: 'INVALID_ACTION' };
  const p = parsed.data;
  if (npc.encounterId || brain.cursor < brain.plan.length || state.tick < brain.nextDecisionTick)
    return { ...result(state), error: 'WRONG_MODE' };
  if (
    p.contextRevision > state.revision ||
    p.mapRevision !== state.maps[npc.mapId].revision ||
    p.entityRevision !== npc.revision ||
    p.brainGeneration !== brain.generation ||
    p.deadlineTick < state.tick
  )
    return { ...result(state), error: 'STALE_STATE' };
  for (const a of p.actions) {
    if (!['move_to', 'wait', 'inspect', 'give'].includes(a.kind))
      return { ...result(state), error: 'INVALID_ACTION' };
    if (a.targetId) {
      const target = state.entities[a.targetId];
      if (!target || !visible(state, npc, target))
        return { ...result(state), error: 'TARGET_UNAVAILABLE' };
      if (p.targetRevisions[a.targetId] !== target.revision)
        return { ...result(state), error: 'STALE_STATE' };
    }
    if (a.itemId && state.entities[a.itemId]?.ownerId !== id)
      return { ...result(state), error: 'FORBIDDEN' };
  }
  const s = structuredClone(state),
    b = s.npcBrains![id];
  b.plan = structuredClone(p.actions);
  b.cursor = 0;
  b.waitingForPath = false;
  b.planMapId = npc.mapId;
  b.movementGeneration = npc.movementGeneration ?? 0;
  b.generation++;
  b.nextDecisionTick = s.tick + 20;
  s.revision++;
  return result(s, [{ kind: 'npc.plan_accepted', actorId: id, mapId: npc.mapId }]);
}
export function stepNpcPlan(state: GameState, id: string): GameResult {
  const npc = state.entities[id],
    brain = state.npcBrains?.[id];
  if (!npc || !brain || brain.cursor >= brain.plan.length) return result(state);
  const abort = (code: 'STALE_STATE' | 'PATH_BLOCKED' | 'WRONG_MODE'): GameResult => {
    const s = structuredClone(state),
      b = s.npcBrains![id];
    b.plan = [];
    b.cursor = 0;
    b.waitingForPath = false;
    b.nextDecisionTick = s.tick + 20;
    s.entities[id].path = [];
    s.revision++;
    return result(s, [{ kind: 'npc.plan_stopped', actorId: id, mapId: npc.mapId, code }]);
  };
  if (
    npc.encounterId ||
    npc.mapId !== brain.planMapId ||
    (npc.movementGeneration ?? 0) !== brain.movementGeneration
  )
    return abort('STALE_STATE');
  const action = brain.plan[brain.cursor];
  if (brain.waitingForPath) {
    if (npc.path?.length) return result(state);
    if (
      action.kind !== 'move_to' ||
      !action.target ||
      npc.x !== action.target.x ||
      npc.y !== action.target.y
    )
      return abort('PATH_BLOCKED');
    const s = structuredClone(state);
    s.npcBrains![id].cursor++;
    s.npcBrains![id].waitingForPath = false;
    s.revision++;
    return result(s, [{ kind: 'npc.plan_step', actorId: id, mapId: npc.mapId }]);
  }
  const applied = applyAction(state, id, action);
  if (applied.error)
    return abort(applied.error === 'PATH_BLOCKED' ? 'PATH_BLOCKED' : 'STALE_STATE');
  const s = structuredClone(applied.state),
    b = s.npcBrains![id];
  if (action.kind === 'move_to') b.waitingForPath = true;
  else b.cursor++;
  s.revision++;
  return result(s, applied.events);
}
/** Remember only committed, perceived consequences. Caller supplies durable operation/event identity. */
export function recordNpcEvents(
  before: GameState,
  after: GameState,
  events: GameEvent[],
  operationId: string,
): GameResult {
  if (!after.npcBrains || !events.length) return result(after);
  const s = structuredClone(after);
  let changed = false;
  for (const [id, brain] of Object.entries(s.npcBrains!)) {
    const observer = before.entities[id];
    if (!observer) continue;
    for (let i = 0; i < events.length; i++) {
      const e = events[i],
        eventId = `${operationId}:${i}`;
      if (brain.facts.some((f) => f.eventId === eventId)) continue;
      const subject = e.targetId
        ? before.entities[e.targetId]
        : e.actorId
          ? before.entities[e.actorId]
          : undefined;
      if (e.actorId !== id && (!subject || !visible(before, observer, subject))) continue;
      const kind =
        e.kind === 'action.pick_up'
          ? 'item_taken'
          : e.kind === 'action.give'
            ? 'helped'
            : ['action.open', 'action.close', 'action.unlock'].includes(e.kind)
              ? 'door_changed'
              : e.kind === 'actor.moved'
                ? 'actor_seen'
                : null;
      if (!kind) continue;
      brain.facts.push({ eventId, kind, targetId: e.targetId ?? e.actorId, tick: after.tick });
      brain.facts = brain.facts.slice(-16);
      changed = true;
    }
  }
  if (changed) s.revision++;
  return result(changed ? s : after);
}
