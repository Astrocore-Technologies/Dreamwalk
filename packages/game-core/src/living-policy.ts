import {
  npcConditionSchema,
  type GameAction,
  type GameState,
  type GameResult,
  type NpcCondition,
  type NpcGoalDefinition,
} from '@dreamwalk/contracts';
import { findPath, visible, walkable } from './index';
import { acceptNpcPlan } from './npc';
import { npcContextFingerprint, proposeNpcObligation, proposeNpcActionObligation } from './living';
const near = (
  a: { mapId: string; x: number; y: number },
  b: { mapId: string; x: number; y: number },
) => a.mapId === b.mapId && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= 1;
export function npcConditionsMet(
  s: GameState,
  npcId: string,
  conditions: NpcCondition[],
  recipientId?: string,
  startedTick = 0,
): boolean {
  const npc = s.entities[npcId],
    m = s.npcBrains?.[npcId]?.living,
    recipient = recipientId ? s.entities[recipientId] : undefined;
  if (!npc || !m || conditions.length > 4) return false;
  return conditions.every((c) => {
    if (!npcConditionSchema.safeParse(c).success) return false;
    switch (c.kind) {
      case 'always':
        return true;
      case 'elapsed':
        return s.tick - startedTick >= c.ticks;
      case 'recipient_near':
        return !!recipient && near(npc, recipient) && visible(s, npc, recipient);
      case 'trust_at_least':
        return !!recipientId && (m.relationships[recipientId]?.trust ?? 0) >= c.minimum;
      case 'owns_item':
        return s.entities[c.itemId]?.ownerId === npcId && !!npc.inventory?.includes(c.itemId);
      case 'near_entity': {
        const t = s.entities[c.entityId];
        return !!t && visible(s, npc, t) && near(npc, t);
      }
      case 'observed':
        return m.observations.some(
          (o) =>
            o.tick >= startedTick &&
            o.kind === c.event &&
            (!c.targetId || o.targetId === c.targetId) &&
            (!recipientId || !o.actorId || o.actorId === recipientId),
        );
    }
  });
}
/** Taboo policy is additional to ordinary engine authority, never a permission grant. */
export function npcActionAllowed(s: GameState, npcId: string, a: GameAction): boolean {
  const npc = s.entities[npcId],
    m = s.npcBrains?.[npcId]?.living;
  if (!npc || !m) return true;
  const taboo = m.personality.taboos;
  if (a.kind === 'give' && a.itemId) {
    const reserved = m.obligations.filter(
      (o) => o.itemId === a.itemId && ['proposed', 'accepted'].includes(o.status),
    );
    if (
      reserved.some(
        (o) =>
          o.status !== 'accepted' ||
          o.toActorId !== a.targetId ||
          o.dueTick <= s.tick ||
          !npcConditionsMet(s, npcId, o.conditions ?? [], o.toActorId, o.createdTick),
      )
    )
      return false;
  }

  const reservedActions = m.obligations.filter(
    (o) =>
      o.promisedAction?.kind === a.kind &&
      o.promisedAction.targetId === a.targetId &&
      ['proposed', 'accepted'].includes(o.status),
  );
  if (
    reservedActions.some(
      (o) =>
        o.status !== 'accepted' ||
        o.dueTick <= s.tick ||
        !npcConditionsMet(s, npcId, o.conditions ?? [], o.toActorId, o.createdTick),
    )
  )
    return false;
  if (taboo.includes('steal') && a.kind === 'pick_up') return false;
  if (taboo.includes('give_valuables') && a.kind === 'give') return false;
  if (taboo.includes('lock_doors') && a.kind === 'lock') return false;
  if (taboo.includes('harm') && a.kind === 'lock') {
    const door = a.targetId ? s.entities[a.targetId] : undefined;
    if (
      door &&
      Object.values(s.entities).some(
        (e) => e.id !== npcId && ['player', 'npc'].includes(e.kind) && near(e, door),
      )
    )
      return false;
  }
  return true;
}
export function updateNpcAffect(s: GameState, npcId: string): boolean {
  const m = s.npcBrains?.[npcId]?.living,
    n = s.entities[npcId];
  if (!m || !n) return false;
  if (!m.affect) {
    m.affect = { fatigue: 0, attention: 100, alertness: 0, mood: 'calm', lastUpdatedTick: s.tick };
    return true;
  }
  const elapsed = Math.floor((s.tick - m.affect.lastUpdatedTick) / 20);
  if (elapsed <= 0) return false;
  m.affect.lastUpdatedTick += elapsed * 20;
  m.affect.fatigue = Math.max(
    0,
    Math.min(100, m.affect.fatigue + (n.path?.length ? elapsed * 3 : -elapsed * 2)),
  );
  m.affect.alertness = Math.max(0, m.affect.alertness - elapsed);
  m.affect.attention = Math.max(
    20,
    100 - Math.floor(m.affect.fatigue / 2) - (m.distractedUntilTick > s.tick ? 50 : 0),
  );
  if (m.affect.alertness === 0) m.affect.mood = 'calm';
  return true;
}
export function defaultNpcGoalPolicy(s: GameState, npcId: string): void {
  const m = s.npcBrains![npcId].living!;
  if (m.goalPolicy && m.goalPolicy.goalRevision === m.goal.revision) return;
  m.goalPolicy = {
    goalRevision: m.goal.revision,
    motivation:
      m.goal.kind === 'assist' ? 'kindness' : m.goal.kind === 'patrol' ? 'routine' : 'duty',
    priority: m.goal.kind === 'assist' ? 3 : m.goal.kind === 'patrol' ? 1 : 2,
    risk: m.personality.behaviorProfile === 'green-apple' ? 'cautious' : 'balanced',
    replans: 0,
    startedTick: s.tick,
    holdUntilTick: s.tick + 20,
    success: [],
    cancelWhen: [],
    status: 'active',
  };
}
function acceptActions(s: GameState, npcId: string, actions: GameAction[]): GameResult {
  const n = s.entities[npcId],
    b = s.npcBrains![npcId];
  return acceptNpcPlan(s, npcId, {
    contextRevision: s.revision,
    mapRevision: s.maps[n.mapId].revision,
    entityRevision: n.revision,
    brainGeneration: b.generation,
    deadlineTick: s.tick + 160,
    actions: actions.slice(0, 3),
    targetRevisions: Object.fromEntries(
      actions
        .filter((a) => a.targetId)
        .map((a) => [a.targetId!, s.entities[a.targetId!]?.revision ?? -1]),
    ),
  });
}
function actionsForGoal(s: GameState, npcId: string, d: NpcGoalDefinition): GameAction[] | null {
  const n = s.entities[npcId],
    b = s.npcBrains![npcId],
    target = d.targetId ? s.entities[d.targetId] : undefined;
  if (d.kind === 'patrol') return [{ kind: 'move_to', target: b.patrolTarget }];
  if (!target || !visible(s, n, target)) return null;
  if (
    d.risk === 'cautious' &&
    Object.values(s.entities).some(
      (e) =>
        e.id !== npcId &&
        near(e, target) &&
        (s.npcBrains![npcId].living!.relationships[e.id]?.alertness ?? 0) >= 3,
    )
  )
    return null;
  const actions: GameAction[] = [];
  if (!near(n, target)) {
    const adjacent = [
      { x: target.x - 1, y: target.y },
      { x: target.x + 1, y: target.y },
      { x: target.x, y: target.y - 1 },
      { x: target.x, y: target.y + 1 },
    ].find(
      (p) => walkable(s, n.mapId, p, npcId, true) && findPath(s, n.mapId, n, p, npcId) !== null,
    );
    if (!adjacent) return null;
    actions.push({ kind: 'move_to', target: adjacent });
  }
  if (d.kind === 'assist' && d.itemId)
    actions.push({ kind: 'give', targetId: target.id, itemId: d.itemId });
  else if (d.kind === 'guard' && target.kind === 'door' && target.open)
    actions.push({ kind: 'close', targetId: target.id });
  else actions.push({ kind: 'inspect', targetId: target.id });
  return actions;
}

function defaultGoalSuccess(s: GameState, npcId: string, d: NpcGoalDefinition): boolean {
  const n = s.entities[npcId],
    b = s.npcBrains![npcId],
    target = d.targetId ? s.entities[d.targetId] : undefined;
  if (d.kind === 'patrol') return n.x === b.patrolTarget.x && n.y === b.patrolTarget.y;
  if (d.kind === 'assist') return !!d.itemId && s.entities[d.itemId]?.ownerId === d.targetId;
  if (!target || !visible(s, n, target) || !near(n, target)) return false;
  return d.kind === 'guard' ? target.kind === 'door' && !target.open : true;
}

/** Bounded authored conditions and game-time needs; never consult hidden player intentions. */
export function stepNpcAuthoredPolicy(
  state: GameState,
  npcId: string,
  options: { deferPlanning?: boolean } = {},
): GameResult {
  const old = state.npcBrains?.[npcId]?.living;
  if (!old) return { state, events: [] };
  let s = structuredClone(state),
    m = s.npcBrains![npcId].living!;
  const events: GameResult['events'] = [];
  let changed = updateNpcAffect(s, npcId);
  defaultNpcGoalPolicy(s, npcId);
  const n = s.entities[npcId];
  if (n.encounterId) return { state: changed ? s : state, events };
  for (const t of options.deferPlanning ? [] : (m.promiseTemplates ?? [])) {
    const evidence = [...m.observations]
      .reverse()
      .find(
        (o) =>
          (o.kind === t.offerOn ||
            (t.offerOn === 'addressed' && o.kind === 'said' && o.addressedNpcId === npcId)) &&
          o.actorId &&
          s.entities[o.actorId]?.kind === 'player',
      );
    if (!evidence?.actorId) continue;
    const cause = `${t.id}:${evidence.id}`;
    if (m.offeredCauseIds?.includes(cause)) continue;
    const r = t.promisedAction
      ? proposeNpcActionObligation(
          s,
          npcId,
          evidence.actorId,
          t.promisedAction,
          [evidence.id],
          t.conditions,
          t.dueTicks,
        )
      : proposeNpcObligation(
          s,
          npcId,
          evidence.actorId,
          t.itemId!,
          [evidence.id],
          t.conditions,
          t.dueTicks,
        );
    if (r.error) continue;
    s = r.state;
    m = s.npcBrains![npcId].living!;
    const obligation = m.obligations.find(
      (o) =>
        (t.itemId
          ? o.itemId === t.itemId
          : o.promisedAction?.kind === t.promisedAction?.kind &&
            o.promisedAction?.targetId === t.promisedAction?.targetId) &&
        o.toActorId === evidence.actorId &&
        o.status === 'proposed',
    );
    if (obligation) {
      obligation.templateId = t.id;
      obligation.alternativeGoalId = t.alternativeGoalId;
      if (!t.requiresAcceptance) {
        obligation.status = 'accepted';
        obligation.acceptedTick = s.tick;
      }
    }
    m.offeredCauseIds = [...(m.offeredCauseIds ?? []), cause].slice(-128);
    events.push(...r.events);
    changed = true;
  }
  const b = s.npcBrains![npcId];
  m = b.living!;
  const policy = m.goalPolicy!;
  const current = policy.definitionId
    ? m.goalDefinitions?.find((d) => d.id === policy.definitionId)
    : undefined;
  if (current && policy.status === 'active') {
    const cancel =
      current.cancelWhen.length > 0 &&
      npcConditionsMet(s, npcId, current.cancelWhen, undefined, policy.startedTick);
    const success =
      current.success.length > 0
        ? npcConditionsMet(s, npcId, current.success, undefined, policy.startedTick)
        : defaultGoalSuccess(s, npcId, current);
    const blocked =
      !options.deferPlanning &&
      !success &&
      !cancel &&
      b.plan.length === 0 &&
      s.tick > policy.startedTick;
    if (blocked && s.tick < b.nextDecisionTick) return { state: changed ? s : state, events };
    if (blocked && (policy.replans ?? 0) < 1 && s.tick >= b.nextDecisionTick) {
      policy.replans = (policy.replans ?? 0) + 1;
      const actions = actionsForGoal(s, npcId, current),
        retry = actions ? acceptActions(s, npcId, actions) : undefined;
      if (retry && !retry.error) {
        s = retry.state;
        return { state: s, events: [...events, ...retry.events] };
      }
    }
    if (blocked) {
      policy.status = 'blocked';
      (m.goalOutcomes ??= {})[current.id] = { status: 'blocked', tick: s.tick };
      changed = true;
    }
    if (cancel || success) {
      policy.status = cancel ? 'cancelled' : 'succeeded';
      (m.goalOutcomes ??= {})[current.id] = { status: policy.status, tick: s.tick };
      changed = true;
      if (cancel) {
        b.plan = [];
        b.cursor = 0;
        b.waitingForPath = false;
        n.path = [];
        n.movementGeneration = (n.movementGeneration ?? 0) + 1;
      }
    }
  }
  if (options.deferPlanning || b.cursor < b.plan.length || s.tick < b.nextDecisionTick)
    return { state: changed ? s : state, events };
  const definitions = m.goalDefinitions ?? [];
  const fallback =
    current && ['cancelled', 'blocked'].includes(policy.status)
      ? definitions.find((d) => d.id === current.fallbackGoalId)
      : undefined;
  const choices = definitions
    .filter((d) => !m.goalOutcomes?.[d.id] && npcConditionsMet(s, npcId, d.when))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const alternative = m.obligations.find(
    (o) =>
      ['broken', 'cancelled'].includes(o.status) && o.alternativeGoalId && !o.alternativeHandled,
  );
  const alternativeGoal = alternative
    ? definitions.find((d) => d.id === alternative.alternativeGoalId)
    : undefined;
  const next = alternativeGoal ?? fallback ?? choices[0];
  if (alternative && alternativeGoal) {
    alternative.alternativeHandled = true;
    changed = true;
  }
  if (
    next &&
    (alternativeGoal ||
      !current ||
      policy.status !== 'active' ||
      (s.tick >= policy.holdUntilTick && next.priority > policy.priority))
  ) {
    m.goal = {
      kind: next.kind === 'guard' ? 'investigate' : next.kind,
      revision: m.goal.revision + 1,
      evidenceIds: [],
      targetId: next.targetId,
    };
    m.goalPolicy = {
      motivation: next.motivation,
      risk: next.risk ?? 'balanced',
      replans: 0,
      goalRevision: m.goal.revision,
      priority: next.priority,
      startedTick: s.tick,
      holdUntilTick: s.tick + next.holdTicks,
      success: structuredClone(next.success),
      cancelWhen: structuredClone(next.cancelWhen),
      definitionId: next.id,
      status: 'active',
    };
    const actions = actionsForGoal(s, npcId, next),
      r = actions ? acceptActions(s, npcId, actions) : undefined;
    if (r && !r.error) {
      s = r.state;
      events.push(...r.events);
    } else {
      m.goalPolicy.status = 'blocked';
      (m.goalOutcomes ??= {})[next.id] = { status: 'blocked', tick: s.tick };
      b.nextDecisionTick = s.tick + 20;
    }
    changed = true;
  }
  if (changed) s.revision++;
  return { state: changed ? s : state, events };
}
export function npcDialogueDecisionTrigger(state: GameState, npcId: string) {
  const m = state.npcBrains?.[npcId]?.living;
  if (!m) return null;
  const last = [...m.observations]
    .reverse()
    .find((o) => o.kind === 'said' || o.kind === 'addressed');
  return last
    ? {
        causeObservationId: last.id,
        actorId: last.actorId,
        contextRevision: m.knowledgeRevision,
        key: npcContextFingerprint([npcId, last.id, m.goal.revision]),
      }
    : null;
}
