import { transitionNpcLifeState } from './lifecycle';
import { isActorConscious } from '@dreamwalk/contracts';
import {
  footprintDistance,
  footprintCells,
  turnRulesSchema,
  turnFenceSchema,
  deferredTurnSpeechSchema,
  gameActionSchema,
  type GameState,
  type GameResult,
  type GameAction,
  type GamePoint,
  type GameError,
  type TurnRules,
  type TurnResources,
  type TurnFence,
  type DeferredTurnSpeechInput,
  type TurnProjection,
} from '@dreamwalk/contracts';
import { applyUnbudgetedAction, findPath, visible, walkable } from './index';
import { npcReplyObservation } from './living';
import { npcActionAllowed } from './living-policy';
import { companionAction } from './companionship';

const clone = <T>(value: T): T => structuredClone(value);
const done = (state: GameState, events: GameResult['events'] = []): GameResult => ({
  state,
  events,
});
const fail = (state: GameState, error: GameError): GameResult => ({ state, events: [], error });
const distance = (a: GamePoint, b: GamePoint) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const fullResources = (rules: TurnRules): TurnResources => ({
  movement: rules.movement,
  main: rules.main,
  additional: rules.additional,
  reaction: rules.reaction,
});
const noResources = (): TurnResources => ({ movement: 0, main: 0, additional: 0, reaction: 0 });

/** Opt-in only. A live legacy path/encounter must first be checkpointed by an explicit conversion. */
export function initializeTurnController(
  state: GameState,
  actorIds: string[],
  input: Partial<TurnRules> = {},
): GameResult {
  const parsed = turnRulesSchema.safeParse(input);
  if (
    !parsed.success ||
    !actorIds.length ||
    actorIds.length > 4 ||
    new Set(actorIds).size !== actorIds.length ||
    actorIds.some((id) => state.entities[id]?.kind !== 'player')
  )
    return fail(state, 'INVALID_ACTION');
  if (state.turnController)
    return JSON.stringify(state.turnController.ruleset) === JSON.stringify(parsed.data) &&
      actorIds.every((id) => state.turnController!.actorOrder.includes(id))
      ? done(state)
      : fail(state, 'STALE_STATE');
  if (
    Object.values(state.entities).some((e) => e.path?.length) ||
    Object.values(state.encounters).some((e) => e.phase === 'planning')
  )
    return fail(state, 'WRONG_MODE');
  const next = clone(state),
    rules = parsed.data;
  next.turnController = {
    version: 1,
    ruleset: rules,
    roundId: 'round-1',
    roundNumber: 1,
    phase: 'player',
    phaseEpoch: 1,
    activeActorId: actorIds[0],
    actorOrder: [...actorIds],
    actorIndex: 0,
    resources: Object.fromEntries(actorIds.map((id) => [id, fullResources(rules)])),
    deferredSpeech: [],
    nextSpeechSequence: 1,
    worldActions: 0,
    worldNpcActions: {},
  };
  for (const entity of Object.values(next.entities))
    if (entity.kind === 'player' || entity.kind === 'npc') {
      entity.maxVitality ??= rules.vitality;
      entity.vitality ??= entity.maxVitality;
    }
  next.revision++;
  return done(next, [{ kind: 'turn.initialized', actorId: actorIds[0] }]);
}
export function registerTurnParticipant(state: GameState, actorId: string): GameResult {
  if (!state.turnController) return done(state);
  if (state.entities[actorId]?.kind !== 'player') return fail(state, 'FORBIDDEN');
  if (state.turnController.actorOrder.includes(actorId)) return done(state);
  if (state.turnController.actorOrder.length >= 4) return fail(state, 'FORBIDDEN');
  const next = clone(state),
    turn = next.turnController!;
  turn.actorOrder.push(actorId);
  turn.resources[actorId] = fullResources(turn.ruleset);
  next.entities[actorId].maxVitality ??= turn.ruleset.vitality;
  next.entities[actorId].vitality ??= turn.ruleset.vitality;
  next.revision++;
  return done(next, [{ kind: 'turn.participant_joined', actorId }]);
}
export function turnFence(state: GameState): TurnFence | null {
  const turn = state.turnController;
  return turn
    ? { roundId: turn.roundId, phaseEpoch: turn.phaseEpoch, rulesetVersion: turn.ruleset.version }
    : null;
}
export function matchesTurnFence(state: GameState, input: unknown): input is TurnFence {
  const parsed = turnFenceSchema.safeParse(input),
    current = turnFence(state);
  return (
    !!current &&
    parsed.success &&
    current.roundId === parsed.data.roundId &&
    current.phaseEpoch === parsed.data.phaseEpoch &&
    current.rulesetVersion === parsed.data.rulesetVersion
  );
}
function playerGate(state: GameState, actorId: string, fence: TurnFence): GameError | undefined {
  const turn = state.turnController;
  if (!turn || !matchesTurnFence(state, fence)) return 'STALE_STATE';
  if (state.entities[actorId]?.kind !== 'player' || !turn.actorOrder.includes(actorId))
    return 'FORBIDDEN';
  if (turn.phase !== 'player' || turn.activeActorId !== actorId) return 'WRONG_MODE';
  if (turn.pendingResolution || turn.reaction) return 'ROUND_LOCKED';
  if (state.entities[actorId].encounterId) return 'WRONG_MODE';
  return undefined;
}
export function projectTurnController(
  state: GameState,
  viewerId: string,
): TurnProjection | undefined {
  const turn = state.turnController;
  if (!turn) return undefined;
  const pending = new Map<string, number>();
  for (const speech of turn.deferredSpeech)
    if (speech.actorId === viewerId || speech.audienceIds.includes(viewerId))
      pending.set(speech.recipientId, (pending.get(speech.recipientId) ?? 0) + 1);
  return {
    version: 1,
    ruleset: clone(turn.ruleset),
    roundId: turn.roundId,
    roundNumber: turn.roundNumber,
    phase: turn.phase,
    phaseEpoch: turn.phaseEpoch,
    activeActorId: turn.activeActorId,
    actorOrder: [...turn.actorOrder],
    resources: clone(turn.resources[viewerId] ?? noResources()),
    ownTurn: turn.activeActorId === viewerId && turn.phase === 'player',
    pendingResolution: !!turn.pendingResolution,
    pendingNpcReplies: [...pending].map(([npcId, count]) => ({ npcId, count })),
    ...(turn.reaction
      ? {
          reaction: {
            id: turn.reaction.id,
            reactorId: turn.reaction.reactorId,
            causeActorId: turn.reaction.causeActorId,
            depth: turn.reaction.depth,
          },
        }
      : {}),
  };
}
/** Returns only already committed points. Wall-clock ticks never consume this path. */
export function applyTurnMove(
  state: GameState,
  actorId: string,
  target: GamePoint,
  fence: TurnFence,
): GameResult {
  const gate = playerGate(state, actorId, fence);
  if (gate) return fail(state, gate);
  const actor = state.entities[actorId],
    turn = state.turnController!,
    path = findPath(state, actor.mapId, actor, target, actorId, true);
  if (!path) return fail(state, 'PATH_BLOCKED');
  if (path.length > turn.resources[actorId].movement) return fail(state, 'OUT_OF_RANGE');
  if (!path.length) return done(state);
  const next = clone(state),
    moving = next.entities[actorId],
    points = [{ x: actor.x, y: actor.y }],
    events: GameResult['events'] = [];
  // Validate each step against the authoritative evolving snapshot, rather than trusting a final destination.
  for (const point of path) {
    if (distance(moving, point) !== 1 || !walkable(next, moving.mapId, point, actorId, true))
      return fail(state, 'PATH_BLOCKED');
    moving.x = point.x;
    moving.y = point.y;
    moving.revision++;
    next.turnController!.resources[actorId].movement--;
    next.tick++;
    points.push({ ...point });
    events.push({ kind: 'actor.moved', actorId, mapId: moving.mapId });
  }
  delete moving.path;
  moving.movementGeneration = (moving.movementGeneration ?? 0) + 1;
  next.revision++;
  moving.movementTrace = { sequence: next.revision, points };
  return done(next, events);
}
type Cost = 'main' | 'additional' | null;
export function turnActionCost(action: GameAction): Cost {
  if (['inspect', 'talk', 'communicate', 'travel'].includes(action.kind)) return null;
  if (
    ['pick_up', 'give', 'open', 'close', 'unlock', 'lock', 'knock', 'transition'].includes(
      action.kind,
    )
  )
    return 'additional';
  return 'main';
}
function contactGate(state: GameState, actorId: string, action: GameAction): GameError | undefined {
  const actor = state.entities[actorId],
    target = action.targetId ? state.entities[action.targetId] : undefined;
  if (
    !target ||
    !['player', 'npc'].includes(target.kind) ||
    !isActorConscious(target) ||
    target.id === actorId ||
    !isActorConscious(actor) ||
    target.mapId !== actor.mapId ||
    !visible(state, actor, target)
  )
    return 'TARGET_UNAVAILABLE';
  if (footprintDistance(actor, target) !== 1) return 'OUT_OF_RANGE';
  return undefined;
}
function resolveContact(
  state: GameState,
  actorId: string,
  action: GameAction,
  defended = false,
): GameResult {
  const error = contactGate(state, actorId, action);
  if (error) return fail(state, error);
  const next = clone(state),
    actor = next.entities[actorId],
    target = next.entities[action.targetId!],
    rules = next.turnController!.ruleset;
  // Contact is edge-adjacent, so push away along that edge's axis, never a
  // diagonal introduced solely by differently sized rectangle centers.
  const dx =
    target.x >= actor.x + footprintCells(actor)
      ? 1
      : actor.x >= target.x + footprintCells(target)
        ? -1
        : 0;
  const dy =
    target.y >= actor.y + footprintCells(actor)
      ? 1
      : actor.y >= target.y + footprintCells(target)
        ? -1
        : 0;
  let affected = false;
  if (!defended && action.kind === 'hit') {
    target.maxVitality ??= rules.vitality;
    target.vitality = Math.max(0, (target.vitality ?? target.maxVitality) - rules.hitDamage);
    affected = true;
  }
  const unconscious =
    target.kind === 'npc' && target.vitality === 0 && action.kind === 'hit' && !defended;
  if (unconscious) transitionNpcLifeState(next, target.id, 'unconscious');
  if (!defended && action.kind === 'push') {
    for (let step = 0; step < rules.pushDistance; step++) {
      const point = { x: target.x + dx, y: target.y + dy };
      if (!walkable(next, target.mapId, point, target.id, true)) break;
      target.x = point.x;
      target.y = point.y;
      affected = true;
    }
  }
  next.revision++;
  next.tick++;
  target.revision++;
  target.feedback = { kind: action.kind as 'hit' | 'push', sequence: next.revision, dx, dy };
  delete target.path;
  return done(next, [
    {
      kind: defended
        ? 'action.defended'
        : affected
          ? `action.${action.kind}`
          : 'action.push_blocked',
      actorId,
      targetId: target.id,
      mapId: target.mapId,
    },
    ...(unconscious
      ? [{ kind: 'actor.lost_consciousness', actorId, targetId: target.id, mapId: target.mapId }]
      : []),
  ]);
}
/** Reaction data is a durable pending mechanical resolution, never an NPC social-response table. */
export function beginTurnReaction(
  state: GameState,
  input: {
    id: string;
    reactorId: string;
    causeActorId: string;
    action: { kind: 'hit' | 'push'; targetId: string };
  },
  fence: TurnFence,
): GameResult {
  const turn = state.turnController;
  if (!turn || !matchesTurnFence(state, fence)) return fail(state, 'STALE_STATE');
  if (
    turn.pendingResolution ||
    turn.reaction ||
    (turn.phase !== 'player' && turn.phase !== 'world') ||
    (turn.phase === 'player' && turn.activeActorId !== input.causeActorId)
  )
    return fail(state, 'ROUND_LOCKED');
  const fromWorld = turn.phase === 'world';
  if (
    fromWorld &&
    (state.entities[input.causeActorId]?.kind !== 'npc' ||
      !npcActionAllowed(state, input.causeActorId, input.action))
  )
    return fail(state, 'FORBIDDEN');
  if (fromWorld) {
    const gate = worldTurnActorGate(state, input.causeActorId);
    if (gate) return fail(state, gate);
  }
  const error = contactGate(state, input.causeActorId, input.action);
  if (error) return fail(state, error);
  if (
    input.reactorId !== input.action.targetId ||
    state.entities[input.reactorId]?.kind !== 'player' ||
    !turn.resources[input.reactorId]?.reaction ||
    (!fromWorld && !turn.resources[input.causeActorId]?.main)
  )
    return fail(state, 'FORBIDDEN');
  const depth = 1;
  if (depth > turn.ruleset.maxReactionDepth) return fail(state, 'ROUND_LOCKED');
  const next = clone(state),
    t = next.turnController!;
  t.pendingResolution = {
    id: input.id,
    actorId: input.causeActorId,
    action: clone(input.action),
    actorRevision: state.entities[input.causeActorId].revision,
    targetRevision: state.entities[input.reactorId].revision,
  };
  t.reaction = {
    id: input.id,
    reactorId: input.reactorId,
    causeActorId: input.causeActorId,
    depth,
    resumePhase: fromWorld ? 'world' : 'player',
    resumeActorId: fromWorld ? null : turn.activeActorId,
  };
  t.phase = 'reaction';
  t.activeActorId = input.reactorId;
  t.phaseEpoch++;
  next.revision++;
  return done(next, [
    { kind: 'turn.reaction_started', actorId: input.reactorId, targetId: input.causeActorId },
  ]);
}
export function resolveTurnReaction(
  state: GameState,
  reactorId: string,
  decision: 'defend' | 'decline',
  fence: TurnFence,
): GameResult {
  const turn = state.turnController,
    reaction = turn?.reaction,
    pending = turn?.pendingResolution;
  if (!turn || !matchesTurnFence(state, fence)) return fail(state, 'STALE_STATE');
  if (
    turn.phase !== 'reaction' ||
    !reaction ||
    !pending ||
    reaction.reactorId !== reactorId ||
    turn.activeActorId !== reactorId
  )
    return fail(state, 'FORBIDDEN');
  if (
    !['defend', 'decline'].includes(decision) ||
    (decision === 'defend' && !turn.resources[reactorId]?.reaction)
  )
    return fail(state, 'INVALID_ACTION');
  if (
    state.entities[pending.actorId]?.revision !== pending.actorRevision ||
    state.entities[reactorId]?.revision !== pending.targetRevision
  )
    return fail(state, 'STALE_STATE');
  const resolved = resolveContact(state, pending.actorId, pending.action, decision === 'defend');
  if (resolved.error) return resolved;
  const t = resolved.state.turnController!;
  // Resume location is independent of who owes this contact's action cost.
  // Deferred player RP may await a reaction during world without becoming an NPC.
  if (state.entities[pending.actorId]?.kind === 'npc') {
    t.worldActions++;
    t.worldNpcActions[pending.actorId] = (t.worldNpcActions[pending.actorId] ?? 0) + 1;
  } else t.resources[pending.actorId].main--;
  if (decision === 'defend') t.resources[reactorId].reaction--;
  t.phase = reaction.resumePhase;
  t.activeActorId = reaction.resumeActorId;
  t.phaseEpoch++;
  delete t.pendingResolution;
  delete t.reaction;
  resolved.events.push({
    kind: 'turn.reaction_resolved',
    actorId: reactorId,
    targetId: pending.actorId,
  });
  return resolved;
}
export function applyTurnAction(
  state: GameState,
  actorId: string,
  input: GameAction,
  fence: TurnFence,
): GameResult {
  const gate = playerGate(state, actorId, fence);
  if (gate) return fail(state, gate);
  const parsed = gameActionSchema.safeParse(input);
  if (!parsed.success) return fail(state, 'INVALID_ACTION');
  const action = parsed.data;
  if (action.kind === 'move_to') return applyTurnMove(state, actorId, action.target!, fence);
  const cost = turnActionCost(action),
    turn = state.turnController!;
  if (cost && turn.resources[actorId][cost] <= 0) return fail(state, 'ROUND_LOCKED');
  if (action.kind === 'hit' || action.kind === 'push') {
    const error = contactGate(state, actorId, action);
    if (error) return fail(state, error);
    const target = state.entities[action.targetId!];
    if (target.kind === 'player' && turn.resources[target.id]?.reaction)
      return beginTurnReaction(
        state,
        {
          id: `reaction-${state.revision + 1}`,
          reactorId: target.id,
          causeActorId: actorId,
          action: { kind: action.kind, targetId: target.id },
        },
        fence,
      );
  }
  const resolved =
    action.kind === 'hit' || action.kind === 'push'
      ? resolveContact(state, actorId, action)
      : applyUnbudgetedAction(state, actorId, action);
  if (resolved.error) return resolved;
  const next = resolved.state === state ? clone(state) : resolved.state;
  if (cost) next.turnController!.resources[actorId][cost]--;
  if (next.revision === state.revision) next.revision++;
  // Logical game time advances only on explicit resolved actions, never while reading or typing.
  if (!['hit', 'push', 'inspect', 'talk', 'communicate'].includes(action.kind)) next.tick++;
  return { ...resolved, state: next };
}
export function queueTurnSpeech(
  state: GameState,
  actorId: string,
  input: DeferredTurnSpeechInput,
  fence: TurnFence,
): GameResult {
  const parsed = deferredTurnSpeechSchema.safeParse(input);
  if (!parsed.success) return fail(state, 'INVALID_ACTION');
  const existing = state.turnController?.deferredSpeech.find((s) => s.id === parsed.data.id);
  if (existing)
    return existing.actorId === actorId &&
      JSON.stringify({ ...parsed.data, actorId }) ===
        JSON.stringify({
          id: existing.id,
          recipientId: existing.recipientId,
          utteranceId: existing.utteranceId,
          channel: existing.channel,
          audienceIds: existing.audienceIds,
          actorId: existing.actorId,
        })
      ? done(state)
      : fail(state, 'STALE_STATE');
  const gate = playerGate(state, actorId, fence);
  if (gate) return fail(state, gate);
  const speech = parsed.data,
    npc = state.entities[speech.recipientId],
    turn = state.turnController!,
    observation = npcReplyObservation(state, actorId, speech.recipientId, speech.utteranceId);
  if (
    npc?.kind !== 'npc' ||
    !observation ||
    (speech.channel === 'whisper') !== (observation.disclosure === 'participants') ||
    !speech.audienceIds.includes(actorId) ||
    !speech.audienceIds.includes(npc.id) ||
    new Set(speech.audienceIds).size !== speech.audienceIds.length ||
    speech.audienceIds.length !== observation.audienceIds.length ||
    speech.audienceIds.some((id) => !observation.audienceIds.includes(id))
  )
    return fail(state, 'FORBIDDEN');
  const queued = turn.deferredSpeech.filter(
    (s) => s.actorId === actorId && s.roundId === turn.roundId,
  );
  if (
    queued.some((s) => s.recipientId === speech.recipientId && s.utteranceId === speech.utteranceId)
  )
    return fail(state, 'STALE_STATE');
  // Recipient fan-out shares one admitted utterance budget; NPC count is not a speech cap.
  const roots = new Set(queued.map((s) => s.utteranceId.slice(s.recipientId.length + 1)));
  if (!roots.has(observation.rootId) && roots.size >= turn.ruleset.maxQueuedSpeech)
    return fail(state, 'RATE_LIMITED');
  const next = clone(state),
    t = next.turnController!;
  t.deferredSpeech.push({
    ...speech,
    actorId,
    sequence: t.nextSpeechSequence++,
    roundId: t.roundId,
    phaseEpoch: t.phaseEpoch,
  });
  next.revision++;
  return done(next, [{ kind: 'turn.speech_queued', actorId, targetId: npc.id, mapId: npc.mapId }]);
}
export function endPlayerTurn(state: GameState, actorId: string, fence: TurnFence): GameResult {
  const gate = playerGate(state, actorId, fence);
  if (gate) return fail(state, gate);
  const next = clone(state),
    turn = next.turnController!;
  turn.actorIndex++;
  turn.phaseEpoch++;
  next.revision++;
  if (turn.actorIndex < turn.actorOrder.length)
    turn.activeActorId = turn.actorOrder[turn.actorIndex];
  else {
    turn.phase = 'world';
    turn.activeActorId = null;
    turn.worldActions = 0;
    turn.worldNpcActions = {};
    delete turn.worldActorIds;
  }
  return done(next, [
    {
      kind: turn.phase === 'world' ? 'turn.world_started' : 'turn.player_started',
      actorId: turn.activeActorId ?? actorId,
    },
  ]);
}
export function markTurnSpeechResolved(state: GameState, id: string, fence: TurnFence): GameResult {
  const turn = state.turnController;
  if (!turn || !matchesTurnFence(state, fence)) return fail(state, 'STALE_STATE');
  if (turn.phase !== 'world' || turn.pendingResolution) return fail(state, 'WRONG_MODE');
  if (!turn.deferredSpeech.some((s) => s.id === id)) return done(state);
  const next = clone(state);
  next.turnController!.deferredSpeech = next.turnController!.deferredSpeech.filter(
    (s) => s.id !== id,
  );
  next.revision++;
  return done(next, [{ kind: 'turn.speech_resolved' }]);
}
/** Freeze the finite roster once, before spending any world action budget. */
export function admitWorldTurnActors(
  state: GameState,
  npcIds: string[],
  fence: TurnFence,
): GameResult {
  const turn = state.turnController;
  if (!turn || !matchesTurnFence(state, fence)) return fail(state, 'STALE_STATE');
  if (turn.phase !== 'world' || turn.pendingResolution || turn.reaction)
    return fail(state, 'WRONG_MODE');
  if (turn.worldActorIds)
    return turn.worldActorIds.length === npcIds.length &&
      turn.worldActorIds.every((id, i) => id === npcIds[i])
      ? done(state)
      : fail(state, 'STALE_STATE');
  if (turn.worldActions || Object.keys(turn.worldNpcActions).length)
    return fail(state, 'ROUND_LOCKED');
  if (
    new Set(npcIds).size !== npcIds.length ||
    npcIds.some((id) => !isActiveWorldNpc(state, id) && !worldTurnCompanionContinuation(state, id))
  )
    return fail(state, 'FORBIDDEN');
  const next = clone(state);
  next.turnController!.worldActorIds = [...npcIds];
  next.revision++;
  return done(next);
}
function isActiveWorldNpc(state: GameState, npcId: string): boolean {
  const npc = state.entities[npcId];
  return (
    npc?.kind === 'npc' &&
    !!state.npcBrains?.[npcId]?.living &&
    !npc.encounterId &&
    isActorConscious(npc) &&
    !!state.turnController?.actorOrder.some((id) => {
      const player = state.entities[id];
      return player?.kind === 'player' && player.mapId === npc.mapId;
    })
  );
}
/** Continue only an already-consented, witnessed departure; never run off-map cognition. */
export function worldTurnCompanionContinuation(
  state: GameState,
  npcId: string,
): GameAction | undefined {
  const npc = state.entities[npcId];
  const agreement = state.npcBrains?.[npcId]?.living?.companionship;
  const leader = agreement && state.entities[agreement.actorId];
  const crossing = agreement?.crossings[0];
  if (
    !npc ||
    npc.kind !== 'npc' ||
    !leader ||
    leader.kind !== 'player' ||
    !state.turnController?.actorOrder.includes(leader.id) ||
    npc.mapId === leader.mapId ||
    npc.encounterId ||
    leader.encounterId ||
    !isActorConscious(npc) ||
    !crossing ||
    crossing.mapId !== npc.mapId ||
    crossing.destinationMapId !== leader.mapId ||
    !state.maps[npc.mapId]?.exits.some(
      (exit) => exit.id === crossing.exitId && exit.destinationMapId === crossing.destinationMapId,
    )
  )
    return undefined;
  const action = companionAction(state, npcId);
  return action?.kind === 'move_to' || action?.kind === 'transition' ? action : undefined;
}
function matchesCompanionContinuation(
  state: GameState,
  npcId: string,
  action?: GameAction,
): boolean {
  const expected = worldTurnCompanionContinuation(state, npcId);
  if (!expected || !action || expected.kind !== action.kind) return false;
  return expected.kind === 'transition'
    ? expected.targetId === action.targetId
    : expected.target?.x === action.target?.x && expected.target?.y === action.target?.y;
}
/** Shared gate for mechanical actions, reactions, and materialized item actions. */
export function worldTurnActorGate(
  state: GameState,
  npcId: string,
  action?: GameAction,
): GameError | undefined {
  const turn = state.turnController;
  if (!turn || turn.phase !== 'world' || turn.pendingResolution || turn.reaction)
    return 'WRONG_MODE';
  if (
    (!isActiveWorldNpc(state, npcId) && !matchesCompanionContinuation(state, npcId, action)) ||
    (turn.worldActorIds && !turn.worldActorIds.includes(npcId))
  )
    return 'FORBIDDEN';
  const limit = turn.worldActorIds
    ? turn.worldActorIds.length * turn.ruleset.maxNpcActions
    : turn.ruleset.maxWorldActions;
  if (
    turn.worldActions >= limit ||
    (turn.worldNpcActions[npcId] ?? 0) >= turn.ruleset.maxNpcActions
  )
    return 'ROUND_LOCKED';
  return undefined;
}
export function applyWorldTurnAction(
  state: GameState,
  npcId: string,
  input: GameAction,
  fence: TurnFence,
): GameResult {
  const turn = state.turnController;
  if (!turn || !matchesTurnFence(state, fence)) return fail(state, 'STALE_STATE');
  if (turn.phase !== 'world' || turn.pendingResolution || state.entities[npcId]?.kind !== 'npc')
    return fail(state, 'WRONG_MODE');
  const gate = worldTurnActorGate(state, npcId, input);
  if (gate) return fail(state, gate);
  const parsed = gameActionSchema.safeParse(input);
  if (!parsed.success) return fail(state, 'INVALID_ACTION');
  const action = parsed.data;
  if (!npcActionAllowed(state, npcId, action)) return fail(state, 'FORBIDDEN');
  if (action.kind === 'hit' || action.kind === 'push') {
    const contactError = contactGate(state, npcId, action);
    if (contactError) return fail(state, contactError);
    const target = state.entities[action.targetId!];
    if (target.kind === 'player' && turn.resources[target.id]?.reaction)
      return beginTurnReaction(
        state,
        {
          id: `reaction-${state.revision + 1}`,
          reactorId: target.id,
          causeActorId: npcId,
          action: { kind: action.kind, targetId: target.id },
        },
        fence,
      );
  }
  let resolved: GameResult;
  if (action.kind === 'move_to') {
    const npc = state.entities[npcId],
      path = findPath(state, npc.mapId, npc, action.target!, npcId, true);
    if (!path) return fail(state, 'PATH_BLOCKED');
    if (path.length > turn.ruleset.movement) return fail(state, 'OUT_OF_RANGE');
    const next = clone(state),
      moving = next.entities[npcId];
    for (const point of path) {
      if (!walkable(next, moving.mapId, point, npcId, true)) return fail(state, 'PATH_BLOCKED');
      moving.x = point.x;
      moving.y = point.y;
      moving.revision++;
    }
    delete moving.path;
    next.revision++;
    resolved = done(
      next,
      path.map(() => ({ kind: 'actor.moved', actorId: npcId, mapId: npc.mapId })),
    );
  } else
    resolved =
      action.kind === 'hit' || action.kind === 'push'
        ? resolveContact(state, npcId, action)
        : applyUnbudgetedAction(state, npcId, action);
  if (resolved.error) return resolved;
  const next = resolved.state === state ? clone(state) : resolved.state;
  next.turnController!.worldActions++;
  next.turnController!.worldNpcActions[npcId] =
    (next.turnController!.worldNpcActions[npcId] ?? 0) + 1;
  if (next.revision === state.revision) next.revision++;
  next.tick++;
  return { ...resolved, state: next };
}
export function finishWorldPhase(state: GameState, fence: TurnFence): GameResult {
  const turn = state.turnController;
  if (!turn || !matchesTurnFence(state, fence)) return fail(state, 'STALE_STATE');
  if (
    turn.phase !== 'world' ||
    turn.pendingResolution ||
    turn.reaction ||
    turn.deferredSpeech.length
  )
    return fail(state, 'ROUND_LOCKED');
  if (
    !turn.actorOrder.length ||
    turn.actorOrder.some((id) => state.entities[id]?.kind !== 'player')
  )
    return fail(state, 'FORBIDDEN');
  const next = clone(state),
    t = next.turnController!;
  t.roundNumber++;
  t.roundId = `round-${t.roundNumber}`;
  t.phase = 'player';
  t.phaseEpoch++;
  t.actorIndex = 0;
  t.activeActorId = t.actorOrder[0];
  t.resources = Object.fromEntries(t.actorOrder.map((id) => [id, fullResources(t.ruleset)]));
  t.worldActions = 0;
  t.worldNpcActions = {};
  delete t.worldActorIds;
  next.revision++;
  return done(next, [{ kind: 'turn.round_started', actorId: t.activeActorId }]);
}
/** Explicit revocation/erasure only. A disconnected participant is deliberately not removed. */
export function removeTurnParticipant(state: GameState, actorId: string): GameResult {
  const original = state.turnController;
  if (!original || !original.actorOrder.includes(actorId)) return done(state);
  const next = clone(state),
    turn = next.turnController!,
    removedIndex = turn.actorOrder.indexOf(actorId);
  for (const [npcId, brain] of Object.entries(next.npcBrains ?? {})) {
    if (brain.living?.companionship?.actorId === actorId) {
      delete brain.living.companionship;
      brain.plan = [];
      brain.cursor = 0;
      brain.waitingForPath = false;
      if (next.entities[npcId]) next.entities[npcId].path = [];
    }
  }
  const pendingInvolves =
    turn.pendingResolution?.actorId === actorId ||
    turn.pendingResolution?.action.targetId === actorId;
  const resumeActor = pendingInvolves ? turn.reaction?.resumeActorId : turn.activeActorId;
  const resumePhase = pendingInvolves ? (turn.reaction?.resumePhase ?? 'player') : turn.phase;
  turn.actorOrder = turn.actorOrder.filter((id) => id !== actorId);
  delete turn.resources[actorId];
  turn.deferredSpeech = turn.deferredSpeech
    .filter((speech) => speech.actorId !== actorId && speech.recipientId !== actorId)
    .map((speech) => ({
      ...speech,
      audienceIds: speech.audienceIds.filter((id) => id !== actorId),
    }));
  if (removedIndex < turn.actorIndex) turn.actorIndex--;
  if (pendingInvolves) {
    delete turn.pendingResolution;
    delete turn.reaction;
    turn.phase = resumePhase;
    turn.activeActorId = resumeActor ?? null;
  }
  if (
    turn.phase === 'player' &&
    (turn.activeActorId === actorId ||
      !turn.activeActorId ||
      !turn.actorOrder.includes(turn.activeActorId))
  ) {
    if (turn.actorIndex < turn.actorOrder.length)
      turn.activeActorId = turn.actorOrder[turn.actorIndex];
    else {
      turn.phase = 'world';
      turn.activeActorId = null;
      turn.worldActions = 0;
      turn.worldNpcActions = {};
      delete turn.worldActorIds;
    }
  }
  turn.phaseEpoch++;
  next.revision++;
  return done(next, [{ kind: 'turn.participant_removed', actorId }]);
}
