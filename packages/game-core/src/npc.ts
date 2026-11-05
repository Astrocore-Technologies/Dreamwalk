import { isActorConscious } from '@dreamwalk/contracts';
import { footprintDistance, adjacentFootprintAnchors } from '@dreamwalk/contracts';
import { characterAppraisal } from './character';
import { matchesTurnFence, turnFence } from './turns';
import { recordNpcCognition, reviseNpcBelief } from './living-reasoning';
import { npcActionAllowed, npcConditionsMet } from './living-policy';
import {
  recordLivingNpcEvents,
  communicateNpcObservations,
  npcReplyObservation,
  npcContextFingerprint,
} from './living';
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
const near = (a: GameEntity, b: GameEntity) => footprintDistance(a, b) <= 1;
function npcTargetRevisions(state: GameState, actions: GameAction[]): Record<string, number> {
  return Object.fromEntries(
    actions.flatMap((action) =>
      action.kind !== 'transition' && action.targetId && state.entities[action.targetId]
        ? [[action.targetId, state.entities[action.targetId].revision]]
        : [],
    ),
  );
}
/** Shared admission checks for fresh proposals and reconsidered accepted intentions. */
function validateNpcPlanActions(
  state: GameState,
  id: string,
  actions: GameAction[],
  targetRevisions: Record<string, number>,
): GameResult['error'] {
  const npc = state.entities[id];
  for (const a of actions) {
    if (a.kind === 'communicate') {
      const checked = communicateNpcObservations(state, id, a);
      if (checked.error) return checked.error;
    }
    if (!npcActionAllowed(state, id, a)) return 'FORBIDDEN';
    if (
      !(
        state.rulesetVersion === 'hybrid-v3'
          ? [
              'move_to',
              'wait',
              'inspect',
              'give',
              'open',
              'close',
              'lock',
              'unlock',
              'communicate',
              'transition',
              ...(state.turnController?.phase === 'world' ? ['hit', 'push'] : []),
            ]
          : ['move_to', 'wait', 'inspect', 'give']
      ).includes(a.kind)
    )
      return 'INVALID_ACTION';
    if (a.targetId) {
      if (a.kind === 'transition') {
        if (!state.maps[npc.mapId].exits.some((exit) => exit.id === a.targetId))
          return 'TARGET_UNAVAILABLE';
        continue;
      }
      const target = state.entities[a.targetId];
      if (!target || !visible(state, npc, target)) return 'TARGET_UNAVAILABLE';
      if (targetRevisions[a.targetId] !== target.revision) return 'STALE_STATE';
    }
    if (a.itemId && state.entities[a.itemId]?.ownerId !== id) return 'FORBIDDEN';
  }
  return undefined;
}
/** Private historical intent, never authority to bypass a fresh model decision or admission. */
export function currentNpcPlan(state: GameState, id: string) {
  const npc = state.entities[id],
    brain = state.npcBrains?.[id];
  if (
    npc?.kind !== 'npc' ||
    !isActorConscious(npc) ||
    !brain ||
    npc.encounterId ||
    !Array.isArray(brain.plan) ||
    !Number.isInteger(brain.cursor) ||
    brain.cursor < 0 ||
    brain.cursor >= brain.plan.length ||
    (brain.planMapId !== undefined && brain.planMapId !== npc.mapId) ||
    (brain.movementGeneration !== undefined &&
      brain.movementGeneration !== (npc.movementGeneration ?? 0))
  )
    return null;
  if (brain.planSource) {
    const source = npcReplyObservation(
      state,
      brain.planSource.actorId,
      id,
      brain.planSource.sourceObservationId,
    );
    if (!source || !['said', 'attempted'].includes(source.kind) || source.mapId !== npc.mapId)
      return null;
  }
  const parsed = npcPlanProposalSchema.shape.actions.safeParse(brain.plan.slice(brain.cursor));
  if (
    !parsed.success ||
    validateNpcPlanActions(state, id, parsed.data, npcTargetRevisions(state, parsed.data))
  )
    return null;
  return {
    actions: structuredClone(parsed.data),
    ...(brain.planSource ? { source: structuredClone(brain.planSource) } : {}),
  };
}
/** Deterministic free provider. Inputs contain observed facts, never arbitrary code/tools. */
export function createMockNpcPlan(state: GameState, id: string): unknown {
  const npc = state.entities[id],
    brain = state.npcBrains?.[id];
  if (!npc || !brain) return null;
  // Each world round still invokes the provider. The mock deliberately continues a
  // valid unfinished choice instead of replacing every accepted intention with patrol.
  const actions: GameAction[] =
    state.turnController?.phase === 'world' ? (currentNpcPlan(state, id)?.actions ?? []) : [];
  if (!actions.length && state.turnController?.phase === 'world' && brain.living) {
    const memory = brain.living;
    const obligations = memory.obligations
      .filter(
        (obligation) =>
          obligation.status === 'accepted' &&
          obligation.dueTick > state.tick &&
          obligation.evidenceIds.every((evidenceId) =>
            memory.observations.some((observation) => observation.id === evidenceId),
          ) &&
          npcConditionsMet(
            state,
            id,
            obligation.conditions ?? [],
            obligation.toActorId,
            obligation.createdTick,
          ),
      )
      .sort(
        (a, b) =>
          (memory.personality.habits?.includes('keep_promises') ? a.dueTick - b.dueTick : 0) ||
          a.createdTick - b.createdTick ||
          a.id.localeCompare(b.id),
      );
    for (const obligation of obligations) {
      const target = state.entities[obligation.promisedAction?.targetId ?? obligation.toActorId];
      if (!target || !visible(state, npc, target)) continue;
      const candidate: GameAction[] = [];
      if (!near(npc, target)) {
        const destination = adjacentFootprintAnchors(npc, target).find(
          (point) =>
            walkable(state, npc.mapId, point, id, true) &&
            findPath(state, npc.mapId, npc, point, id, true),
        );
        if (!destination) continue;
        candidate.push({ kind: 'move_to', target: destination });
      }
      candidate.push(
        obligation.promisedAction ?? {
          kind: 'give',
          targetId: target.id,
          itemId: obligation.itemId,
        },
      );
      if (
        !npcPlanProposalSchema.shape.actions.safeParse(candidate).success ||
        validateNpcPlanActions(state, id, candidate, npcTargetRevisions(state, candidate))
      )
        continue;
      actions.push(...candidate);
      break;
    }
  }
  const continuing = actions.length > 0;
  const recipient = Object.values(state.entities)
    .filter(
      (e) =>
        e.kind === 'player' &&
        visible(state, npc, e) &&
        !brain.facts.some((f) => f.kind === 'helped' && f.targetId === e.id),
    )
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  const appraisal = brain.living && characterAppraisal(brain.living, undefined, id);
  if (
    !actions.length &&
    (appraisal ? appraisal.response === 'assist' : brain.goal === 'help') &&
    recipient &&
    npc.inventory?.length
  ) {
    if (!near(npc, recipient)) {
      const target = adjacentFootprintAnchors(npc, recipient).find(
        (p) => walkable(state, npc.mapId, p, id) && findPath(state, npc.mapId, npc, p, id),
      );
      if (target) actions.push({ kind: 'move_to', target });
    }
    actions.push({ kind: 'give', targetId: recipient.id, itemId: npc.inventory[0] });
  }
  if (!continuing && brain.patrolTarget)
    actions.push({ kind: 'move_to', target: brain.patrolTarget });
  if (validateNpcPlanActions(state, id, actions, npcTargetRevisions(state, actions)))
    actions.splice(0, actions.length, { kind: 'wait' });
  const targetRevisions = npcTargetRevisions(state, actions);
  return {
    ...(state.turnController?.phase === 'world' ? { turnFence: turnFence(state)! } : {}),
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
  if (npc?.kind !== 'npc' || !isActorConscious(npc) || !brain)
    return { ...result(state), error: 'FORBIDDEN' };
  const parsed = npcPlanProposalSchema.safeParse(input);
  if (!parsed.success) return { ...result(state), error: 'INVALID_ACTION' };
  const p = parsed.data;
  const worldDecision = p.turnFence !== undefined;
  if (
    worldDecision &&
    (state.turnController?.phase !== 'world' || !matchesTurnFence(state, p.turnFence))
  )
    return { ...result(state), error: 'STALE_STATE' };
  if (
    npc.encounterId ||
    (!worldDecision && (brain.cursor < brain.plan.length || state.tick < brain.nextDecisionTick))
  )
    return { ...result(state), error: 'WRONG_MODE' };
  if (
    p.contextRevision > state.revision ||
    p.mapRevision !== state.maps[npc.mapId].revision ||
    p.entityRevision !== npc.revision ||
    p.brainGeneration !== brain.generation ||
    p.deadlineTick < state.tick
  )
    return { ...result(state), error: 'STALE_STATE' };
  const actionError = validateNpcPlanActions(state, id, p.actions, p.targetRevisions);
  if (actionError) return { ...result(state), error: actionError };
  if (
    p.cognition &&
    (p.knowledgeRevision === undefined ||
      !brain.living ||
      p.knowledgeRevision > brain.living.knowledgeRevision ||
      (!worldDecision && p.knowledgeRevision !== brain.living.knowledgeRevision))
  )
    return { ...result(state), error: 'STALE_STATE' };
  let revised = state;
  if (p.beliefRevisions?.length) {
    if (p.knowledgeRevision !== brain.living?.knowledgeRevision)
      return { ...result(state), error: 'STALE_STATE' };
    for (const update of p.beliefRevisions) {
      const r = reviseNpcBelief(revised, id, update);
      if (r.error) return { ...result(state), error: r.error };
      revised = r.state;
    }
  }
  if (p.cognition) {
    const thought = recordNpcCognition(revised, id, p.cognition, {
      knowledgeRevision: revised.npcBrains![id].living!.knowledgeRevision,
      turnFence: p.turnFence,
    });
    if (thought.error) return { ...result(state), error: thought.error };
    revised = thought.state;
    // Frozen round decisions retain their original knowledge provenance. Later
    // observations remain in memory and can prompt a fresh decision next round.
    revised.npcBrains![id].living!.cognition!.knowledgeRevision = p.knowledgeRevision!;
  }
  const s = structuredClone(revised),
    b = s.npcBrains![id];
  const previous = worldDecision ? currentNpcPlan(state, id) : null;
  b.plan = structuredClone(p.actions);
  if (
    previous?.source &&
    npcContextFingerprint(previous.actions) === npcContextFingerprint(p.actions)
  )
    b.planSource = previous.source;
  else delete b.planSource;
  b.cursor = 0;
  b.waitingForPath = false;
  b.planMapId = npc.mapId;
  if (worldDecision) {
    s.entities[id].path = [];
    s.entities[id].movementGeneration = (npc.movementGeneration ?? 0) + 1;
  }
  b.movementGeneration = s.entities[id].movementGeneration ?? 0;
  b.generation++;
  b.nextDecisionTick = s.tick + 20;
  s.revision++;
  return result(s, [{ kind: 'npc.plan_accepted', actorId: id, mapId: npc.mapId }]);
}
export function stepNpcPlan(state: GameState, id: string): GameResult {
  if (state.turnController && state.turnController.phase !== 'world') return result(state);
  const npc = state.entities[id],
    brain = state.npcBrains?.[id];
  if (!npc || !isActorConscious(npc) || !brain || brain.cursor >= brain.plan.length)
    return result(state);
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
  if (!npcActionAllowed(state, id, action)) return abort('STALE_STATE');
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
  if (after.rulesetVersion === 'hybrid-v3')
    return recordLivingNpcEvents(before, after, events, operationId);
  if (!after.npcBrains || !events.length) return result(after);
  const s = structuredClone(after);
  let changed = false;
  for (const [id, brain] of Object.entries(s.npcBrains!)) {
    const observer = before.entities[id];
    if (!observer || !isActorConscious(observer)) continue;
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
