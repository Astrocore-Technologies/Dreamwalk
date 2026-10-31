import {
  npcSpeechSchema,
  type GameAction,
  type GameEntity,
  type GameEvent,
  type GameResult,
  type GameState,
  type LivingNpcMemory,
  type NpcPersonality,
  type NpcObservation,
  type NpcMemorySummary,
  type NpcNotice,
  type NpcObligation,
  type NpcCondition,
  npcPromisedActionSchema,
  npcConditionSchema,
} from '@dreamwalk/contracts';
import { findPath, visible, walkable } from './index';
import { acceptNpcPlan } from './npc';
import {
  npcConditionsMet,
  npcActionAllowed,
  stepNpcAuthoredPolicy,
  defaultNpcGoalPolicy,
} from './living-policy';
const clone = <T>(x: T): T => structuredClone(x);
const result = (
  state: GameState,
  events: GameEvent[] = [],
  error?: GameResult['error'],
): GameResult => ({ state, events, ...(error ? { error } : {}) });
const near = (a: GameEntity, b: GameEntity) =>
  a.mapId === b.mapId && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= 1;
const hash = (value: string) => {
  let a = 2166136261,
    b = 5381;
  for (const c of value) {
    a = Math.imul(a ^ c.charCodeAt(0), 16777619);
    b = Math.imul(b, 33) ^ c.charCodeAt(0);
  }
  return `${a >>> 0}-${b >>> 0}`;
};
const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, stable(v)]),
        )
      : value;
export const npcContextFingerprint = (value: unknown) =>
  hash(JSON.stringify(stable(value)) ?? 'undefined');
export function createLivingMemory(personality?: NpcPersonality): LivingNpcMemory {
  return {
    policyVersion: 1,
    personality: clone(
      personality ?? {
        role: 'guard',
        values: ['duty', 'caution'],
        taboos: ['steal', 'disclose_private'],
        speechStyle: 'reserved',
      },
    ),
    knowledgeRevision: 0,
    affect: { fatigue: 0, attention: 100, alertness: 0, mood: 'calm', lastUpdatedTick: 0 },
    goalPolicy: {
      goalRevision: 0,
      motivation: 'routine',
      priority: 1,
      startedTick: 0,
      holdUntilTick: 20,
      success: [],
      cancelWhen: [],
      status: 'active',
    },
    observations: [],
    beliefs: [],
    relationships: {},
    obligations: [],
    causes: [],
    processedCauses: [],
    nextRoutineTick: 20,
    distractedUntilTick: 0,
    goal: { kind: 'patrol', revision: 0, evidenceIds: [] },
  };
}
/** Acoustic reach uses topology, not sight; opaque walls/closed doors block sound in v1. */
export function canNpcHear(
  state: GameState,
  listener: GameEntity,
  source: GameEntity,
  range = 6,
): boolean {
  if (listener.mapId !== source.mapId) return false;
  const m = state.maps[listener.mapId];
  if (!m) return false;
  const queue = [{ x: source.x, y: source.y, d: 0 }],
    seen = new Set<string>();
  while (queue.length) {
    const p = queue.shift()!;
    const key = `${p.x},${p.y}`;
    if (seen.has(key) || p.d > range) continue;
    seen.add(key);
    if (p.x === listener.x && p.y === listener.y) return true;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const x = p.x + dx,
        y = p.y + dy;
      if (
        x < 0 ||
        y < 0 ||
        x >= m.width ||
        y >= m.height ||
        m.blocked.some((q) => q.x === x && q.y === y)
      )
        continue;
      if (
        Object.values(state.entities).some(
          (e) => e.mapId === m.id && e.kind === 'door' && !e.open && e.x === x && e.y === y,
        )
      )
        continue;
      queue.push({ x, y, d: p.d + 1 });
    }
  }
  return false;
}
function audience(state: GameState, npc: GameEntity): string[] {
  return Object.values(state.entities)
    .filter((e) => e.kind === 'player' && visible(state, e, npc))
    .map((e) => e.id)
    .sort();
}
function notice(
  state: GameState,
  npcId: string,
  kind: NpcNotice['kind'],
  cause: string,
  only?: string[],
) {
  const npc = state.entities[npcId];
  if (!npc) return;
  const id = `notice-${hash(`${npcId}:${kind}:${cause}`)}`;
  if (state.npcNotices?.some((n) => n.id === id)) return;
  (state.npcNotices ??= []).push({
    id,
    npcId,
    kind,
    tick: state.tick,
    mapId: npc.mapId,
    audienceIds: only ?? audience(state, npc),
  });
  state.npcNotices = state.npcNotices.slice(-128);
}
function prune(memory: LivingNpcMemory) {
  const protectedIds = new Set([
    ...memory.observations
      .filter(
        (o) =>
          ['known_entity', 'authored_fact'].includes(o.kind) &&
          (o.eventId.startsWith('initial:') || o.eventId.startsWith('initial-link:')),
      )
      .map((o) => o.id),
    ...memory.obligations
      .filter((o) => ['accepted', 'proposed'].includes(o.status))
      .flatMap((o) => o.evidenceIds),
    ...Object.values(memory.relationships).flatMap((r) => r.evidenceIds),
    ...memory.beliefs.flatMap((b) => b.evidenceIds),
    ...memory.causes.map((c) => c.observationId),
    ...memory.goal.evidenceIds,
  ]);
  const recent = new Set(memory.observations.slice(-128).map((o) => o.id));
  memory.observations = memory.observations.filter(
    (o) => protectedIds.has(o.id) || recent.has(o.id),
  );
  memory.processedCauses = memory.processedCauses.slice(-256);
  // Terminal promises may be archived in durable game_events; active promises are never trimmed.
  const terminal = new Set(
    memory.obligations
      .filter((o) => !['accepted', 'proposed'].includes(o.status))
      .slice(-64)
      .map((o) => o.id),
  );
  memory.obligations = memory.obligations.filter(
    (o) => ['accepted', 'proposed'].includes(o.status) || terminal.has(o.id),
  );
}
function remember(memory: LivingNpcMemory, observation: NpcObservation): boolean {
  // A root event repeated through multiple messengers is not independent evidence.
  if (
    memory.observations.some(
      (o) =>
        o.id === observation.id || (o.rootId === observation.rootId && o.kind === observation.kind),
    )
  )
    return false;
  memory.observations.push(observation);
  memory.knowledgeRevision++;
  memory.affect ??= {
    fatigue: 0,
    attention: 100,
    alertness: 0,
    mood: 'calm',
    lastUpdatedTick: observation.tick,
  };
  if (['item_taken', 'item_missing', 'noise'].includes(observation.kind)) {
    memory.affect.alertness = Math.min(100, memory.affect.alertness + 20);
    memory.affect.mood = 'alarmed';
  }
  if (observation.kind === 'helped') {
    memory.affect.mood = 'grateful';
    memory.affect.alertness = Math.max(0, memory.affect.alertness - 10);
  }
  const kind = observation.kind;
  if (['item_taken', 'item_missing', 'noise', 'addressed', 'claim'].includes(kind)) {
    const c = {
      id: observation.id,
      observationId: observation.id,
      priority: kind === 'addressed' ? 3 : kind === 'item_taken' ? 2 : 1,
      notBeforeTick: observation.tick,
    };
    if (memory.causes.length >= 32) {
      const score = (x: typeof c) =>
        x.priority + Math.floor((observation.tick - x.notBeforeTick) / 40);
      const lowest = memory.causes.reduce((a, b) => (score(a) < score(b) ? a : b));
      if (score(lowest) < score(c)) memory.causes = memory.causes.filter((x) => x.id !== lowest.id);
      else {
        prune(memory);
        return true;
      }
    }
    memory.causes.push(c);
  }
  if (['item_taken', 'item_missing', 'claim', 'noise', 'addressed'].includes(kind)) {
    const predicate =
      kind === 'item_missing'
        ? 'item_missing'
        : kind === 'noise'
          ? 'heard_noise'
          : kind === 'addressed'
            ? 'needs_help'
            : 'took_item';
    const contrary = memory.beliefs.find(
      (b) =>
        b.predicate === predicate &&
        b.targetId === observation.targetId &&
        b.subjectId !== observation.actorId &&
        b.confidence === 'certain' &&
        observation.confidence === 'reported',
    );
    memory.beliefs.push({
      id: `belief-${hash(observation.id)}`,
      subjectId: observation.actorId,
      targetId: observation.targetId,
      predicate,
      confidence:
        observation.confidence === 'witnessed'
          ? 'certain'
          : observation.confidence === 'reported'
            ? 'reported'
            : 'uncertain',
      evidenceIds: [observation.id],
      status: contrary ? 'disputed' : 'active',
      revision: 0,
    });
    memory.beliefs = memory.beliefs.slice(-64);
    if (observation.confidence === 'witnessed')
      for (const b of memory.beliefs)
        if (
          b.predicate === predicate &&
          b.targetId === observation.targetId &&
          b.subjectId !== observation.actorId &&
          b.confidence === 'reported'
        ) {
          b.status = 'disputed';
          b.revision++;
        }
  }
  if (
    observation.actorId &&
    observation.channel === 'direct' &&
    ['item_taken', 'helped'].includes(kind)
  ) {
    const r = (memory.relationships[observation.actorId] ??= {
      trust: 0,
      alertness: 0,
      debt: 0,
      evidenceIds: [],
    });
    if (kind === 'item_taken' && memory.personality.role === 'guard') {
      r.trust = Math.max(-5, r.trust - 1);
      r.alertness = Math.min(5, r.alertness + 1);
    }
    if (kind === 'helped') {
      r.trust = Math.min(5, r.trust + 1);
      r.debt = Math.min(5, r.debt + 1);
    }
    r.evidenceIds = [...r.evidenceIds, observation.id].slice(-32);
  }
  prune(memory);
  return true;
}
export function recordLivingNpcEvents(
  before: GameState,
  after: GameState,
  events: GameEvent[],
  operationId: string,
): GameResult {
  if (after.rulesetVersion !== 'hybrid-v3' || !events.length) return result(after);
  const s = clone(after);
  let changed = false;
  for (const [npcId, brain] of Object.entries(s.npcBrains ?? {})) {
    const m = brain.living,
      npc = before.entities[npcId];
    if (!m || !npc) continue;
    for (let index = 0; index < events.length; index++) {
      const e = events[index],
        actor = e.actorId ? before.entities[e.actorId] : undefined,
        target = e.targetId ? before.entities[e.targetId] : undefined;
      const eventId = `${operationId}:${index}`,
        rootId = eventId;
      if (
        ['actor.moved', 'actor.transitioned'].includes(e.kind) &&
        actor &&
        m.distractedUntilTick <= before.tick &&
        (m.affect?.attention ?? 100) >= 60
      ) {
        const afterNpc = after.entities[npcId];
        const candidates =
          e.actorId === npcId
            ? Object.values(before.entities).filter(
                (x) => x.id !== npcId && ['player', 'npc'].includes(x.kind),
              )
            : [actor];
        for (const candidate of candidates) {
          if (candidate.id === npcId) continue;
          const afterActor = after.entities[candidate.id];
          const saw = visible(before, npc, candidate),
            sees = !!afterNpc && !!afterActor && visible(after, afterNpc, afterActor);
          if (saw === sees) continue;
          const kind = sees ? 'actor_seen' : 'actor_departed',
            known = sees ? afterActor : candidate;
          const observationId = `movement-${hash(`${operationId}:${npcId}:${candidate.id}:${kind}`)}`;
          changed =
            remember(m, {
              id: `${npcId}:${observationId}`,
              eventId,
              rootId: observationId,
              kind,
              tick: after.tick,
              mapId: sees ? afterNpc.mapId : npc.mapId,
              point: { x: known.x, y: known.y },
              channel: 'direct',
              confidence: 'witnessed',
              actorId: known.id,
              targetId: known.id,
              depth: 0,
              disclosure: 'public',
              audienceIds: [],
            }) || changed;
        }
        continue;
      }

      if (e.kind === 'action.distract' && e.targetId === npcId && actor && near(actor, npc)) {
        if (!m.processedCauses.includes(eventId)) {
          m.processedCauses.push(eventId);
          m.distractedUntilTick = s.tick + 40;
          notice(s, npcId, 'distracted', eventId);
          changed = true;
        }
      }
      if (e.kind === 'action.give' && e.actorId === npcId) {
        for (const o of m.obligations)
          if (
            o.status === 'accepted' &&
            o.toActorId === e.targetId &&
            o.itemId &&
            s.entities[o.itemId]?.ownerId === o.toActorId
          ) {
            o.status = 'fulfilled';
            o.resolutionEventId = eventId;
            notice(s, npcId, 'fulfilled', o.id, [o.toActorId, ...audience(s, s.entities[npcId])]);
            changed = true;
          }
      }

      if (e.actorId === npcId)
        for (const o of m.obligations) {
          if (
            o.status === 'accepted' &&
            o.promisedAction &&
            e.kind === `action.${o.promisedAction.kind}` &&
            e.targetId === o.promisedAction.targetId
          ) {
            o.status = 'fulfilled';
            o.resolutionEventId = eventId;
            notice(s, npcId, 'fulfilled', o.id, [o.toActorId, ...audience(s, s.entities[npcId])]);
            changed = true;
          }
        }
      let kind: NpcObservation['kind'] | undefined;
      if (e.kind === 'action.pick_up') kind = 'item_taken';
      if (['action.open', 'action.close', 'action.unlock', 'action.lock'].includes(e.kind))
        kind = 'door_changed';
      if (e.kind === 'action.knock') kind = 'noise';
      if (e.kind === 'action.talk' && e.targetId === npcId) kind = 'addressed';
      if (e.kind === 'action.give' && e.targetId === npcId) kind = 'helped';
      if (!kind || !actor) continue;
      const attentive =
        (m.distractedUntilTick <= before.tick && (m.affect?.attention ?? 100) >= 60) ||
        kind === 'addressed' ||
        kind === 'helped';
      const seesActor = attentive && visible(before, npc, actor),
        seesTarget = target && attentive && visible(before, npc, target);
      const direct =
        e.actorId === npcId ||
        ((kind === 'addressed' || kind === 'helped') && e.targetId === npcId) ||
        !!seesTarget;
      const heard = kind === 'noise' && canNpcHear(before, npc, actor);
      if (!direct && !heard) continue;
      const o: NpcObservation = {
        id: `${npcId}:${eventId}`,
        eventId,
        rootId,
        kind,
        tick: after.tick,
        mapId: npc.mapId,
        channel: direct ? 'direct' : 'heard',
        confidence: direct ? 'witnessed' : 'uncertain',
        depth: 0,
        disclosure: kind === 'addressed' ? 'participants' : 'public',
        audienceIds: kind === 'addressed' ? [actor.id, npcId] : [],
        ...(seesActor || e.actorId === npcId || kind === 'addressed' || kind === 'helped'
          ? { actorId: actor.id }
          : {}),
        ...(seesTarget ? { targetId: target!.id } : {}),
        ...(direct && target
          ? { point: { x: target.x, y: target.y } }
          : heard
            ? { point: { x: Math.floor(actor.x / 3) * 3, y: Math.floor(actor.y / 3) * 3 } }
            : {}),
      };
      changed = remember(m, o) || changed;
    }
  }
  if (changed) s.revision++;
  return result(changed ? s : after);
}
/** Reports copy only a source's known evidence. Hearing a report is not witnessing its claim. */
export function conveyNpcObservation(
  state: GameState,
  fromId: string,
  toId: string,
  observationId: string,
): GameResult {
  const from = state.entities[fromId],
    to = state.entities[toId],
    source = state.npcBrains?.[fromId]?.living?.observations.find((o) => o.id === observationId);
  if (
    !from ||
    !to ||
    from.kind !== 'npc' ||
    to.kind !== 'npc' ||
    !source ||
    !state.npcBrains?.[toId]?.living
  )
    return result(state, [], 'TARGET_UNAVAILABLE');
  if (from.encounterId || to.encounterId || !near(from, to) || !visible(state, from, to))
    return result(state, [], 'OUT_OF_RANGE');
  if (
    source.depth >= 3 ||
    source.disclosure !== 'public' ||
    state.npcBrains?.[fromId]?.living?.personality.taboos.includes('share_rumors')
  )
    return result(state, [], 'FORBIDDEN');
  const s = clone(state),
    m = s.npcBrains![toId].living!;
  const copied: NpcObservation = {
    ...clone(source),
    id: `${toId}:report:${hash(source.rootId)}`,
    eventId: `report:${fromId}:${source.eventId}`,
    channel: 'report',
    confidence: 'reported',
    sourceNpcId: fromId,
    depth: source.depth + 1,
    audienceIds: [],
  };
  if (!remember(m, copied)) return result(state);
  notice(s, fromId, 'warned', `${source.rootId}:${toId}`);
  s.revision++;
  return result(s, [{ kind: 'npc.warned', actorId: fromId, mapId: from.mapId }]);
}
/** Structured fictional allegations are reports, not authoritative mutations. */
export function applyNpcSpeech(
  state: GameState,
  speakerId: string,
  npcId: string,
  input: unknown,
  options: { suppressReply?: boolean } = {},
): GameResult {
  const p = npcSpeechSchema.safeParse(input),
    speaker = state.entities[speakerId],
    npc = state.entities[npcId];
  if (!p.success || state.rulesetVersion !== 'hybrid-v3')
    return result(state, [], 'INVALID_ACTION');
  if (
    !speaker ||
    speaker.kind !== 'player' ||
    npc?.kind !== 'npc' ||
    !state.npcBrains?.[npcId]?.living
  )
    return result(state, [], 'TARGET_UNAVAILABLE');
  if (!near(speaker, npc) || !visible(state, speaker, npc))
    return result(state, [], 'OUT_OF_RANGE');
  if (speaker.encounterId || npc.encounterId) return result(state, [], 'WRONG_MODE');
  const claim = p.data.claim;
  if (
    claim &&
    (!state.entities[claim.actorId] ||
      !visible(state, speaker, state.entities[claim.actorId]) ||
      !state.entities[claim.targetId] ||
      !visible(state, speaker, state.entities[claim.targetId]))
  )
    return result(state, [], 'TARGET_UNAVAILABLE');
  const s = clone(state),
    root = `speech-${hash(`${speakerId}:${s.tick}:${JSON.stringify(p.data)}`)}`;
  const recipients =
    p.data.channel === 'whisper'
      ? [npcId]
      : Object.values(s.entities)
          .filter((e) => e.kind === 'npc' && canNpcHear(state, e, speaker))
          .map((e) => e.id);
  for (const id of recipients) {
    const m = s.npcBrains?.[id]?.living;
    if (!m) continue;
    remember(m, {
      id: `${id}:${root}`,
      eventId: root,
      rootId: root,
      kind: claim ? 'claim' : p.data.text ? 'said' : 'addressed',
      tick: s.tick,
      mapId: speaker.mapId,
      channel: 'report',
      confidence: 'reported',
      actorId: claim?.actorId ?? (visible(s, s.entities[id], speaker) ? speakerId : undefined),
      targetId: claim?.targetId,
      sourceNpcId: undefined,
      addressedNpcId: npcId,
      depth: 0,
      disclosure: p.data.channel === 'whisper' ? 'participants' : 'public',
      audienceIds: p.data.channel === 'whisper' ? [speakerId, npcId] : [],
      ...(p.data.text ? { text: p.data.text } : {}),
    });
  }
  if (p.data.text) {
    const listeners =
      p.data.channel === 'whisper'
        ? [speakerId, npcId]
        : Object.values(s.entities)
            .filter((e) => ['player', 'npc'].includes(e.kind) && canNpcHear(s, e, speaker))
            .map((e) => e.id);
    const known = listeners.filter((id) => id === speakerId || visible(s, s.entities[id], speaker));
    (s.npcUtterances ??= []).push({
      id: `utterance-${hash(root)}`,
      speakerId,
      tick: s.tick,
      text: p.data.text,
      mapId: speaker.mapId,
      audienceIds: listeners,
      speakerKnownToIds: known,
    });
    const replyListeners =
      p.data.channel === 'whisper'
        ? [speakerId, npcId]
        : Object.values(s.entities)
            .filter((e) => ['player', 'npc'].includes(e.kind) && canNpcHear(s, e, npc))
            .map((e) => e.id);
    if (!options.suppressReply)
      s.npcUtterances.push({
        id: `reply-${hash(root)}`,
        speakerId: npcId,
        tick: s.tick,
        code: 'acknowledged',
        mapId: npc.mapId,
        audienceIds: replyListeners,
        speakerKnownToIds: replyListeners.filter(
          (id) => id === npcId || visible(s, s.entities[id], npc),
        ),
      });
    s.npcUtterances = s.npcUtterances.slice(-128);
  }
  s.revision++;
  return result(s, [
    { kind: 'npc.addressed', actorId: speakerId, targetId: npcId, mapId: speaker.mapId },
  ]);
}
function adjacentPath(
  state: GameState,
  npc: GameEntity,
  target: GameEntity | { x: number; y: number },
) {
  return [
    { x: target.x - 1, y: target.y },
    { x: target.x + 1, y: target.y },
    { x: target.x, y: target.y - 1 },
    { x: target.x, y: target.y + 1 },
  ].find(
    (p) =>
      walkable(state, npc.mapId, p, npc.id, true) &&
      findPath(state, npc.mapId, npc, p, npc.id) !== null,
  );
}
export function acceptNpcObligation(
  state: GameState,
  npcId: string,
  toActorId: string,
  itemId: string,
  evidenceIds: string[],
  dueTicks = 200,
): GameResult {
  const npc = state.entities[npcId],
    recipient = state.entities[toActorId],
    m = state.npcBrains?.[npcId]?.living,
    item = state.entities[itemId];
  if (
    !m ||
    npc?.kind !== 'npc' ||
    recipient?.kind !== 'player' ||
    !near(npc, recipient) ||
    item?.ownerId !== npcId ||
    !npc.inventory?.includes(itemId)
  )
    return result(state, [], 'FORBIDDEN');
  if (
    !Number.isInteger(dueTicks) ||
    dueTicks < 1 ||
    dueTicks > 12000 ||
    !evidenceIds.length ||
    evidenceIds.some((id) => !m.observations.some((o) => o.id === id && o.actorId === toActorId))
  )
    return result(state, [], 'INVALID_ACTION');
  if (!npcActionAllowed(state, npcId, { kind: 'give', targetId: toActorId, itemId }))
    return result(state, [], 'FORBIDDEN');
  if (m.obligations.some((o) => ['accepted', 'proposed'].includes(o.status) && o.itemId === itemId))
    return result(state);
  if (m.obligations.filter((o) => ['accepted', 'proposed'].includes(o.status)).length >= 128)
    return result(state, [], 'RATE_LIMITED');
  const s = clone(state),
    next = s.npcBrains![npcId].living!,
    id = `promise-${hash(`${npcId}:${itemId}:${toActorId}:${evidenceIds.join(',')}`)}`;
  if (next.obligations.some((o) => o.id === id)) return result(state);
  next.obligations.push({
    id,
    toActorId,
    itemId,
    createdTick: s.tick,
    dueTick: s.tick + dueTicks,
    status: 'accepted',
    evidenceIds: [...evidenceIds],
    sourceUtteranceId: m.observations.find((o) => evidenceIds.includes(o.id) && o.text)?.eventId,
    sourceUtterance: m.observations.find((o) => evidenceIds.includes(o.id) && o.text)?.text,
  });
  notice(s, npcId, 'promised', id, [toActorId]);
  s.revision++;
  return result(s, [{ kind: 'npc.promised', actorId: npcId, mapId: npc.mapId }]);
}
function plan(state: GameState, npcId: string, actions: GameAction[]): GameResult {
  const npc = state.entities[npcId],
    brain = state.npcBrains![npcId];
  return acceptNpcPlan(state, npcId, {
    contextRevision: state.revision,
    mapRevision: state.maps[npc.mapId].revision,
    entityRevision: npc.revision,
    brainGeneration: brain.generation,
    deadlineTick: state.tick + 160,
    actions: actions.slice(0, 3),
    targetRevisions: Object.fromEntries(
      actions
        .filter((a) => a.targetId)
        .map((a) => [a.targetId!, state.entities[a.targetId!]?.revision ?? -1]),
    ),
  });
}
/** One bounded decision per eligible NPC. No I/O, wall clock, model call or execution of source text. */
export function stepLivingNpcs(
  state: GameState,
  options: { deferredNpcIds?: string[] } = {},
): GameResult {
  if (state.rulesetVersion !== 'hybrid-v3') return result(state);
  const perception = refreshLivingPerception(state);
  let s = perception.state;
  const events: GameEvent[] = [...perception.events];
  for (const npcId of Object.keys(state.npcBrains ?? {}).sort()) {
    const authored = stepNpcAuthoredPolicy(s, npcId, {
      deferPlanning: options.deferredNpcIds?.includes(npcId),
    });
    s = authored.state;
    events.push(...authored.events);
    let brain = s.npcBrains![npcId],
      m = brain.living,
      npc = s.entities[npcId];
    if (!m || !npc) continue;
    for (const obligation of m.obligations.filter(
      (o) =>
        ['accepted', 'proposed'].includes(o.status) &&
        (o.dueTick <= s.tick ||
          (o.itemId
            ? s.entities[o.itemId]?.ownerId !== npcId
            : !o.promisedAction || !s.entities[o.promisedAction.targetId])),
    )) {
      if (s === state) s = clone(s);
      brain = s.npcBrains![npcId];
      m = brain.living!;
      const o = m.obligations.find((o) => o.id === obligation.id)!;
      o.status = o.status === 'proposed' ? 'cancelled' : 'broken';
      o.resolutionEventId = `deadline:${o.id}`;
      notice(s, npcId, o.status === 'cancelled' ? 'promise_cancelled' : 'promise_broken', o.id, [
        o.toActorId,
      ]);
      s.revision++;
      events.push({ kind: 'npc.promise_broken', actorId: npcId, mapId: npc.mapId });
    }
    brain = s.npcBrains![npcId];
    m = brain.living!;
    npc = s.entities[npcId];
    if (
      options.deferredNpcIds?.includes(npcId) ||
      npc.encounterId ||
      brain.cursor < brain.plan.length ||
      s.tick < brain.nextDecisionTick ||
      m.distractedUntilTick > s.tick
    )
      continue;
    const pending = m.obligations
      .filter(
        (o) =>
          o.status === 'accepted' &&
          npcConditionsMet(s, npcId, o.conditions ?? [], o.toActorId, o.createdTick),
      )
      .sort((a, b) =>
        m!.personality.habits?.includes('keep_promises')
          ? a.dueTick - b.dueTick || a.createdTick - b.createdTick
          : a.createdTick - b.createdTick,
      )[0];
    if (pending) {
      const recipient = s.entities[pending.promisedAction?.targetId ?? pending.toActorId];
      if (recipient && recipient.mapId === npc.mapId && visible(s, npc, recipient)) {
        const actions: GameAction[] = [];
        if (!near(npc, recipient)) {
          const p = adjacentPath(s, npc, recipient);
          if (p) actions.push({ kind: 'move_to', target: p });
        }
        actions.push(
          pending.promisedAction
            ? pending.promisedAction
            : { kind: 'give', targetId: recipient.id, itemId: pending.itemId },
        );
        const r = plan(s, npcId, actions);
        if (!r.error) {
          s = r.state;
          events.push(...r.events);
          continue;
        }
      }
    }
    const routineOverdue = s.tick >= m.nextRoutineTick + 100;
    const cause = (routineOverdue ? [] : m.causes)
      .filter((c) => c.notBeforeTick <= s.tick)
      .sort(
        (a, b) =>
          b.priority +
            Math.floor((s.tick - b.notBeforeTick) / 40) -
            (a.priority + Math.floor((s.tick - a.notBeforeTick) / 40)) ||
          a.notBeforeTick - b.notBeforeTick ||
          a.id.localeCompare(b.id),
      )[0];
    if (cause) {
      const observation = m.observations.find((o) => o.id === cause.observationId);
      if (s === state) s = clone(s);
      brain = s.npcBrains![npcId];
      m = brain.living!;
      npc = s.entities[npcId];
      m.causes = m.causes.filter((c) => c.id !== cause.id);
      m.processedCauses.push(cause.id);
      m.goal.revision++;
      m.goal.evidenceIds = [cause.observationId];
      s.revision++;
      if (!observation) continue;
      if (
        observation.kind === 'addressed' &&
        !m.promiseTemplates?.length &&
        (m.personality.role === 'helper' ||
          m.personality.values.includes('kindness') ||
          m.personality.behaviorProfile === 'cookie') &&
        observation.actorId
      ) {
        const owned = (npc.inventory ?? []).find(
          (id) =>
            !m!.obligations.some(
              (o) => o.itemId === id && ['accepted', 'proposed'].includes(o.status),
            ),
        );
        if (owned) {
          const promised = acceptNpcObligation(s, npcId, observation.actorId, owned, [
            observation.id,
          ]);
          if (!promised.error) {
            s = promised.state;
            events.push(...promised.events);
            s.npcBrains![npcId].living!.goal.kind = 'assist';
            defaultNpcGoalPolicy(s, npcId);
            continue;
          }
        }
      }
      if (['item_taken', 'item_missing', 'noise', 'claim'].includes(observation.kind)) {
        m.goal.kind = 'investigate';
        m.goal.targetId = observation.targetId;
        defaultNpcGoalPolicy(s, npcId);
        notice(s, npcId, observation.kind === 'noise' ? 'heard' : 'investigating', cause.id);
        events.push({ kind: 'npc.investigating', actorId: npcId, mapId: npc.mapId });
        const helpers = Object.values(s.entities)
          .filter((e) => e.kind === 'npc' && e.id !== npcId && near(npc, e) && !e.encounterId)
          .sort(
            (a, b) =>
              (m!.relationships[b.id]?.trust ?? 0) - (m!.relationships[a.id]?.trust ?? 0) ||
              a.id.localeCompare(b.id),
          )
          .slice(0, m.personality.habits?.includes('share_warnings') ? 2 : 1);
        for (const helper of helpers)
          if (!(
            (m.personality.values.includes('honesty') ||
              m.personality.behaviorProfile === 'green-apple') &&
            observation.confidence === 'reported'
          )) {
            const told = conveyNpcObservation(s, npcId, helper.id, observation.id);
            if (!told.error) {
              s = told.state;
              events.push(...told.events);
            }
          }
        const target = observation.targetId ? s.entities[observation.targetId] : undefined,
          point = target && !target.ownerId && visible(s, npc, target) ? target : observation.point;
        const actions: GameAction[] = [];
        if (
          point &&
          !(
            (m.personality.values.includes('caution') ||
              m.personality.behaviorProfile === 'green-apple' ||
              m.personality.habits?.includes('observe_before_acting')) &&
            observation.confidence !== 'witnessed'
          )
        ) {
          const destination = target
            ? adjacentPath(s, npc, point)
            : walkable(s, npc.mapId, point, npc.id, true)
              ? point
              : undefined;
          if (destination && (npc.x !== destination.x || npc.y !== destination.y))
            actions.push({ kind: 'move_to', target: destination });
        }
        if (target && !target.ownerId && visible(s, npc, target))
          actions.push({ kind: 'inspect', targetId: target.id });
        const door = Object.values(s.entities).find(
          (e) => e.kind === 'door' && e.open && near(npc, e) && visible(s, npc, e),
        );
        if ((m.personality.role === 'guard' || m.personality.values.includes('duty')) && door)
          actions.push({ kind: 'close', targetId: door.id });
        if (actions.length) {
          const r = plan(s, npcId, actions);
          if (!r.error) {
            s = r.state;
            events.push(...r.events);
          }
        }
        s.npcBrains![npcId].nextDecisionTick = s.tick + 20;
      }
      prune(s.npcBrains![npcId].living!);
      continue;
    }
    if (m.affect && m.affect.fatigue >= 80) {
      if (s === state) s = clone(s);
      s.npcBrains![npcId].nextDecisionTick = s.tick + 20;
      notice(s, npcId, 'resting', String(s.tick));
      s.revision++;
      continue;
    }
    if (s.tick >= m.nextRoutineTick) {
      if (s === state) s = clone(s);
      brain = s.npcBrains![npcId];
      m = brain.living!;
      m.nextRoutineTick = s.tick + 100;
      m.goal = { kind: 'patrol', revision: m.goal.revision + 1, evidenceIds: [] };
      defaultNpcGoalPolicy(s, npcId);
      s.revision++;
      if (npc.x !== brain.patrolTarget.x || npc.y !== brain.patrolTarget.y) {
        const r = plan(s, npcId, [{ kind: 'move_to', target: brain.patrolTarget }]);
        if (!r.error) {
          s = r.state;
          notice(s, npcId, 'patrolling', String(m.nextRoutineTick));
          events.push(...r.events);
        }
      }
    }
  }
  return result(s, events);
}
export function chooseLivingNpcIntent(state: GameState, npcId: string): GameAction {
  const npc = state.entities[npcId],
    m = state.npcBrains?.[npcId]?.living;
  if (!npc || !m) return { kind: 'wait' };
  const promise = m.obligations.find(
    (o) =>
      o.status === 'accepted' &&
      npcConditionsMet(state, npcId, o.conditions ?? [], o.toActorId, o.createdTick) &&
      (o.itemId
        ? state.entities[o.itemId]?.ownerId === npcId
        : !!o.promisedAction && !!state.entities[o.promisedAction.targetId]) &&
      state.entities[o.promisedAction?.targetId ?? o.toActorId] &&
      near(npc, state.entities[o.promisedAction?.targetId ?? o.toActorId]),
  );
  if (promise)
    return (
      promise.promisedAction ?? {
        kind: 'give',
        targetId: promise.toActorId,
        itemId: promise.itemId,
      }
    );
  const door = Object.values(state.entities).find(
    (e) => e.kind === 'door' && e.open && near(npc, e) && visible(state, npc, e),
  );
  if (
    door &&
    (m.personality.role === 'guard' || m.personality.values.includes('duty')) &&
    m.causes.some(
      (c) => m.observations.find((o) => o.id === c.observationId)?.kind === 'item_taken',
    )
  )
    return { kind: 'close', targetId: door.id };
  return { kind: 'wait' };
}
export function buildNpcDecisionContext(state: GameState, npcId: string) {
  const npc = state.entities[npcId],
    brain = state.npcBrains?.[npcId],
    m = brain?.living;
  if (!npc || !m) throw new Error('TARGET_UNAVAILABLE');
  const ranked = [...m.observations]
    .sort(
      (a, b) =>
        npcObservationImportance(m, b) - npcObservationImportance(m, a) ||
        b.tick - a.tick ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 16);
  const context = {
    npcId,
    ...(npc.supportingNpc
      ? {
          publicIdentity: {
            name: npc.label,
            role: npc.supportingNpc.roleLabel,
            untrustedPersonalityFlavor: npc.supportingNpc.personalitySummary,
          },
        }
      : {}),
    knowledgeRevision: m.knowledgeRevision,
    goalGeneration: m.goal.revision,
    personality: clone(m.personality),
    // The scheduler timestamp is not a semantic read dependency. Keep every actual
    // affect value: changing mood, attention, fatigue or alertness still stales a plan.
    affect: {
      fatigue: m.affect?.fatigue ?? 0,
      attention: m.affect?.attention ?? 100,
      alertness: m.affect?.alertness ?? 0,
      mood: m.affect?.mood ?? 'calm',
    },
    communicationPolicy: {
      publicAudienceIds: Object.values(state.entities)
        .filter((e) => ['npc', 'player'].includes(e.kind) && canNpcHear(state, e, npc))
        .map((e) => e.id)
        .sort(),
      privateEvidenceRequiresOriginalAudience: true,
      plannerCannotGrantDisclosure: true,
    },
    goalPolicy: m.goalPolicy ? clone(m.goalPolicy) : null,
    goalDefinitions: clone(m.goalDefinitions ?? []),
    goal: clone(m.goal),
    observations: clone(ranked),
    beliefs: clone(
      m.beliefs
        .filter((b) => b.evidenceIds.every((id) => ranked.some((o) => o.id === id)))
        .slice(-8),
    ),
    relationships: clone(m.relationships),
    obligations: clone(
      m.obligations.filter((o) => ['accepted', 'proposed'].includes(o.status)).slice(0, 3),
    ),
    summary:
      m.summary && validateNpcSummary(state, npcId, m.summary) ? clone(m.summary) : undefined,
    visibleEntities: Object.values(state.entities)
      .filter((e) => e.id === npcId || visible(state, npc, e))
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        mapId: e.mapId,
        x: e.x,
        y: e.y,
        revision: e.revision,
      })),
    ownInventory: (npc.inventory ?? []).map((id) => ({
      id,
      revision: state.entities[id]?.revision,
    })),
    allowedActions: [
      'move_to',
      'wait',
      'inspect',
      'give',
      'open',
      'close',
      'lock',
      'unlock',
      'communicate',
    ],
  };
  return { ...context, contextHash: npcContextFingerprint(context) };
}
export function createNpcMemorySummary(
  state: GameState,
  npcId: string,
  selectedObservationIds?: string[],
): NpcMemorySummary {
  const m = state.npcBrains?.[npcId]?.living;
  if (!m) throw new Error('TARGET_UNAVAILABLE');
  if (
    selectedObservationIds &&
    (selectedObservationIds.length > 16 ||
      new Set(selectedObservationIds).size !== selectedObservationIds.length ||
      selectedObservationIds.some((id) => !m.observations.some((o) => o.id === id)))
  )
    throw new Error('INVALID_SUMMARY_SELECTION');
  const source = selectedObservationIds
    ? selectedObservationIds.map((id) => m.observations.find((o) => o.id === id)!)
    : m.observations.slice(-16);
  return {
    policyVersion: 1,
    modelVersion: 'grounded-summary-v1',
    coveredEventRange: source.length
      ? { firstEventId: source[0].eventId, lastEventId: source[source.length - 1].eventId }
      : null,
    revision: (m.summary?.revision ?? 0) + 1,
    knowledgeRevision: m.knowledgeRevision,
    inputFingerprint: npcContextFingerprint(source),
    observationIds: source.map((o) => o.id),
    claims: source.map((o) => ({ observationId: o.id, kind: o.kind })),
    narrative: groundedNpcNarrative(m, source),
  };
}
export function validateNpcSummary(state: GameState, npcId: string, input: unknown): boolean {
  const m = state.npcBrains?.[npcId]?.living;
  if (!m || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  const x = input as NpcMemorySummary;
  if (
    Object.keys(x).some(
      (k) =>
        ![
          'policyVersion',
          'modelVersion',
          'coveredEventRange',
          'narrative',
          'revision',
          'knowledgeRevision',
          'inputFingerprint',
          'observationIds',
          'claims',
        ].includes(k),
    ) ||
    x.policyVersion !== 1 ||
    x.modelVersion !== 'grounded-summary-v1' ||
    !Number.isSafeInteger(x.revision) ||
    x.revision < 1 ||
    x.knowledgeRevision !== m.knowledgeRevision ||
    !Array.isArray(x.observationIds) ||
    x.observationIds.length > 16 ||
    new Set(x.observationIds).size !== x.observationIds.length ||
    !Array.isArray(x.claims) ||
    x.claims.length !== x.observationIds.length
  )
    return false;
  const source = x.observationIds.map((id) => m.observations.find((o) => o.id === id));
  if (source.some((o) => !o) || npcContextFingerprint(source) !== x.inputFingerprint) return false;
  const range = source.length
    ? { firstEventId: source[0]!.eventId, lastEventId: source[source.length - 1]!.eventId }
    : null;
  if (npcContextFingerprint(range) !== npcContextFingerprint(x.coveredEventRange)) return false;
  if (
    x.narrative !== undefined &&
    x.narrative !== groundedNpcNarrative(m, source as NpcObservation[])
  )
    return false;
  return x.claims.every(
    (c, i) =>
      c &&
      Object.keys(c).length === 2 &&
      c.observationId === source[i]!.id &&
      c.kind === source[i]!.kind,
  );
}
/** Disclosure is checked for the complete audience, not just an intended addressee. */
export function buildNpcPublicSpeechContext(
  state: GameState,
  npcId: string,
  audienceIds: string[],
  observationIds: string[],
  requestedFactIds: string[] = [],
) {
  const m = state.npcBrains?.[npcId]?.living,
    npc = state.entities[npcId];
  const audience = [...new Set(audienceIds)].sort();
  if (!m || !npc) return { npcId, audienceIds: audience, claims: [] };
  if (
    !audienceIds.length ||
    audienceIds.some((id) => !state.entities[id] || !canNpcHear(state, state.entities[id], npc))
  )
    return { npcId, audienceIds: audience, claims: [] };
  return {
    npcId,
    audienceIds: audience,
    ...(npc.supportingNpc
      ? { publicIdentity: { name: npc.label, role: npc.supportingNpc.roleLabel } }
      : {}),
    publicSpeechStyle: m.personality.publicSpeechStyle ?? 'neutral',
    claims: observationIds.flatMap((id) => {
      const o = m.observations.find((o) => o.id === id);
      if (!o) return [];
      const reveal =
        (o.revealCondition === 'asked' && requestedFactIds.includes(o.id)) ||
        (o.revealCondition === 'trusted' &&
          audienceIds.every((id) => id === npcId || (m.relationships[id]?.trust ?? 0) >= 1));
      if (
        (o.disclosure === 'private' && !reveal) ||
        (o.disclosure === 'participants' && audienceIds.some((id) => !o.audienceIds.includes(id)))
      )
        return [];
      return [
        {
          observationId: o.id,
          kind: o.kind,
          confidence: o.confidence,
          ...(o.actorId ? { actorId: o.actorId } : {}),
          ...(o.targetId ? { targetId: o.targetId } : {}),
          ...(o.text ? { untrustedUtterance: o.text } : {}),
          ...(o.kind === 'authored_fact' && o.definitionText
            ? { authoredFact: { title: o.title ?? '', text: o.definitionText } }
            : {}),
        },
      ];
    }),
  };
}
export function projectGameEvents(
  state: GameState,
  viewerId: string,
  events: GameEvent[],
): GameEvent[] {
  const viewer = state.entities[viewerId];
  if (!viewer) return [];
  return events
    .filter(
      (e) =>
        e.actorId === viewerId ||
        (e.actorId &&
          state.entities[e.actorId] &&
          visible(state, viewer, state.entities[e.actorId])),
    )
    .map((e) => ({
      kind: e.kind,
      ...(e.actorId ? { actorId: e.actorId } : {}),
      ...(e.mapId ? { mapId: e.mapId } : {}),
      ...(e.code ? { code: e.code } : {}),
    }));
}
export function npcObligationsForActor(
  state: GameState,
  actorId: string,
): { npcId: string; obligation: NpcObligation }[] {
  return Object.entries(state.npcBrains ?? {}).flatMap(([npcId, b]) =>
    (b.living?.obligations ?? [])
      .filter((o) => o.toActorId === actorId)
      .map((o) => ({ npcId, obligation: clone(o) })),
  );
}
export function acceptNpcMemorySummary(
  state: GameState,
  npcId: string,
  input: unknown,
): GameResult {
  if (!validateNpcSummary(state, npcId, input)) return result(state, [], 'INVALID_ACTION');
  const s = clone(state),
    m = s.npcBrains![npcId].living!,
    summary = input as NpcMemorySummary;
  if (summary.revision !== (m.summary?.revision ?? 0) + 1) return result(state, [], 'STALE_STATE');
  m.summary = clone(summary);
  s.revision++;
  return result(s, [
    { kind: 'npc.memory_summarized', actorId: npcId, mapId: s.entities[npcId].mapId },
  ]);
}
/** Public speech worker receives this context, never the private planning context. */
export function commitNpcPublicUtterance(
  state: GameState,
  npcId: string,
  input: {
    text?: string;
    code?: 'acknowledged';
    channel: 'say' | 'whisper';
    recipientId: string;
    observationIds: string[];
    requestedFactIds?: string[];
    contextHash: string;
  },
): GameResult {
  const npc = state.entities[npcId],
    recipient = state.entities[input.recipientId];
  if (
    state.rulesetVersion !== 'hybrid-v3' ||
    !npc ||
    npc.kind !== 'npc' ||
    !recipient ||
    !['player', 'npc'].includes(recipient.kind) ||
    !near(npc, recipient) ||
    npc.encounterId ||
    recipient.encounterId
  )
    return result(state, [], 'TARGET_UNAVAILABLE');
  if (
    !(
      (typeof input.text === 'string' &&
        input.text.trim().length > 0 &&
        input.text.length <= 1000 &&
        input.code === undefined) ||
      (input.code === 'acknowledged' && input.text === undefined)
    ) ||
    !['say', 'whisper'].includes(input.channel) ||
    !Array.isArray(input.observationIds) ||
    input.observationIds.length > 16
  )
    return result(state, [], 'INVALID_ACTION');
  const listeners =
    input.channel === 'whisper'
      ? [recipient.id, npcId]
      : Object.values(state.entities)
          .filter((e) => ['player', 'npc'].includes(e.kind) && canNpcHear(state, e, npc))
          .map((e) => e.id)
          .sort();
  const context = buildNpcPublicSpeechContext(
    state,
    npcId,
    listeners,
    input.observationIds,
    input.requestedFactIds,
  );
  if (new Set(input.observationIds).size !== context.claims.length)
    return result(state, [], 'FORBIDDEN');
  if (npcContextFingerprint(context) !== input.contextHash) return result(state, [], 'STALE_STATE');
  const s = clone(state),
    id = `utterance-${hash(`${npcId}:${input.contextHash}:${input.code ?? input.text}`)}`;
  if (s.npcUtterances?.some((u) => u.id === id)) return result(state);
  (s.npcUtterances ??= []).push({
    id,
    speakerId: npcId,
    tick: s.tick,
    ...(input.code ? { code: input.code } : { text: input.text }),
    mapId: npc.mapId,
    sourceObservationIds: [...input.observationIds],
    audienceIds: listeners,
    speakerKnownToIds: listeners.filter((id) => id === npcId || visible(s, s.entities[id], npc)),
  });
  s.npcUtterances = s.npcUtterances.slice(-128);
  if (input.text)
    for (const listenerId of listeners) {
      const memory = s.npcBrains?.[listenerId]?.living;
      if (!memory) continue;
      const recognizes = listenerId === npcId || visible(s, s.entities[listenerId], npc);
      remember(memory, {
        id: `${listenerId}:${id}`,
        eventId: id,
        rootId: id,
        kind: 'said',
        tick: s.tick,
        mapId: npc.mapId,
        channel: 'report',
        confidence: 'reported',
        actorId: recognizes ? npcId : undefined,
        sourceNpcId: recognizes ? npcId : undefined,
        depth: 0,
        disclosure: input.channel === 'whisper' ? 'participants' : 'public',
        audienceIds: input.channel === 'whisper' ? listeners : [],
        text: input.text,
      });
    }
  s.revision++;
  return result(s, [{ kind: 'npc.spoke', actorId: npcId, mapId: npc.mapId }]);
}

/** Inspect remembered locations, never consult the hidden owner's identity. */
export function refreshLivingPerception(state: GameState): GameResult {
  if (state.rulesetVersion !== 'hybrid-v3') return result(state);
  const s = clone(state);
  let changed = false;
  const events: GameEvent[] = [];
  for (const [id, brain] of Object.entries(s.npcBrains ?? {})) {
    const m = brain.living,
      npc = s.entities[id];
    if (
      !m ||
      !npc ||
      m.distractedUntilTick > s.tick ||
      (m.affect?.attention ?? 100) < 60 ||
      npc.encounterId
    )
      continue;
    const remembered = (m.rememberedItems ??= {});
    for (const [targetId, last] of Object.entries(remembered)) {
      if (!last.present || last.mapId !== npc.mapId) continue;
      const spot: GameEntity = {
        id: 'perception-location',
        kind: 'item',
        mapId: last.mapId,
        x: last.x,
        y: last.y,
        revision: 0,
      };
      if (!visible(s, npc, spot)) continue;
      const actual = s.entities[targetId];
      if (
        actual &&
        !actual.ownerId &&
        actual.mapId === last.mapId &&
        actual.x === last.x &&
        actual.y === last.y
      )
        continue;
      last.present = false;
      const eventId = `absence-${hash(`${id}:${targetId}:${s.tick}`)}`;
      remember(m, {
        id: `${id}:${eventId}`,
        eventId,
        rootId: eventId,
        kind: 'item_missing',
        tick: s.tick,
        mapId: last.mapId,
        point: { x: last.x, y: last.y },
        channel: 'direct',
        confidence: 'witnessed',
        targetId,
        depth: 0,
        disclosure: 'public',
        audienceIds: [],
      });
      changed = true;
      events.push({ kind: 'npc.absence_noticed', actorId: id, mapId: npc.mapId });
    }
    for (const e of Object.values(s.entities))
      if (e.kind === 'item' && visible(s, npc, e)) {
        const old = remembered[e.id];
        if (!old || !old.present || old.mapId !== e.mapId || old.x !== e.x || old.y !== e.y) {
          remembered[e.id] = { mapId: e.mapId, x: e.x, y: e.y, present: true };
          changed = true;
        }
      }
  }
  if (changed) s.revision++;
  return result(changed ? s : state, events);
}

export function proposeNpcObligation(
  state: GameState,
  npcId: string,
  toActorId: string,
  itemId: string,
  evidenceIds: string[],
  conditions: NpcCondition[] = [],
  dueTicks = 200,
): GameResult {
  if (conditions.length > 4 || conditions.some((c) => !npcConditionSchema.safeParse(c).success))
    return result(state, [], 'INVALID_ACTION');
  if (!npcActionAllowed(state, npcId, { kind: 'give', targetId: toActorId, itemId }))
    return result(state, [], 'FORBIDDEN');
  const existing = state.npcBrains?.[npcId]?.living?.obligations.find(
    (o) => o.itemId === itemId && ['proposed', 'accepted'].includes(o.status),
  );
  if (existing)
    return existing.toActorId === toActorId ? result(state) : result(state, [], 'FORBIDDEN');
  const accepted = acceptNpcObligation(state, npcId, toActorId, itemId, evidenceIds, dueTicks);
  if (accepted.error || accepted.state === state) return accepted;
  const o = accepted.state.npcBrains![npcId].living!.obligations.at(-1)!;
  o.status = 'proposed';
  o.conditions = clone(conditions);
  accepted.state.npcNotices = accepted.state.npcNotices?.filter(
    (n) => n.id !== `notice-${hash(`${npcId}:promised:${o.id}`)}`,
  );
  notice(accepted.state, npcId, 'promise_offered', o.id, [toActorId]);
  return result(accepted.state, [
    { kind: 'npc.promise_offered', actorId: npcId, mapId: state.entities[npcId].mapId },
  ]);
}
export function respondNpcObligation(
  state: GameState,
  actorId: string,
  npcId: string,
  promiseId: string,
  response: 'accept' | 'decline',
): GameResult {
  const o = state.npcBrains?.[npcId]?.living?.obligations.find((o) => o.id === promiseId),
    actor = state.entities[actorId],
    npc = state.entities[npcId];
  if (
    !o ||
    o.toActorId !== actorId ||
    actor?.kind !== 'player' ||
    !npc ||
    !near(actor, npc) ||
    !visible(state, actor, npc)
  )
    return result(state, [], 'TARGET_UNAVAILABLE');
  if (!['accept', 'decline'].includes(response)) return result(state, [], 'INVALID_ACTION');
  if (o.status !== 'proposed')
    return (response === 'accept' && o.status === 'accepted') ||
      (response === 'decline' && o.status === 'cancelled')
      ? result(state)
      : result(state, [], 'STALE_STATE');
  if (actor.encounterId || npc.encounterId) return result(state, [], 'WRONG_MODE');
  if (
    o.dueTick <= state.tick ||
    (o.itemId
      ? state.entities[o.itemId]?.ownerId !== npcId
      : !o.promisedAction || !state.entities[o.promisedAction.targetId])
  )
    return result(state, [], 'STALE_STATE');
  const s = clone(state),
    next = s.npcBrains![npcId].living!.obligations.find((x) => x.id === promiseId)!;
  next.status = response === 'accept' ? 'accepted' : 'cancelled';
  if (response === 'accept') next.acceptedTick = s.tick;
  notice(s, npcId, response === 'accept' ? 'promised' : 'promise_cancelled', o.id, [actorId]);
  s.revision++;
  return result(s, [
    {
      kind: response === 'accept' ? 'npc.promised' : 'npc.promise_cancelled',
      actorId: npcId,
      mapId: npc.mapId,
    },
  ]);
}
/** Only an author-designated question label is public; title/fact ID remain private. */
export function publicNpcFactTopics(
  state: GameState,
  npcId: string,
): { id: string; title: string }[] {
  const m = state.npcBrains?.[npcId]?.living;
  if (!m) return [];
  return m.observations
    .filter((o) => o.kind === 'authored_fact' && o.publicQuestion && o.revealCondition !== 'never')
    .map((o, index) => ({ id: `topic-${hash(npcId)}-${index}`, title: o.publicQuestion! }));
}
export function resolveNpcFactTopic(state: GameState, npcId: string, topicId: string): string[] {
  const m = state.npcBrains?.[npcId]?.living;
  if (!m) return [];
  return m.observations
    .filter((o) => o.kind === 'authored_fact' && o.publicQuestion && o.revealCondition !== 'never')
    .flatMap((o, index) => (`topic-${hash(npcId)}-${index}` === topicId ? [o.id] : []));
}
export function createMockNpcPublicResponse(
  context: ReturnType<typeof buildNpcPublicSpeechContext>,
): { text: string } | { code: 'acknowledged' } {
  const fact = context.claims.find((c) => 'authoredFact' in c && c.authoredFact)?.authoredFact;
  return fact ? { text: fact.text } : { code: 'acknowledged' };
}

function npcObservationImportance(m: LivingNpcMemory, o: NpcObservation): number {
  let score = m.goal.evidenceIds.includes(o.id) ? 100 : 0;
  if (
    m.obligations.some(
      (p) => ['accepted', 'proposed'].includes(p.status) && p.evidenceIds.includes(o.id),
    )
  )
    score += 80;
  if (o.actorId && m.relationships[o.actorId])
    score += Math.abs(m.relationships[o.actorId].trust) * 3 + m.relationships[o.actorId].alertness;
  if (['item_taken', 'item_missing', 'helped'].includes(o.kind)) score += 15;
  if (m.affect?.mood === 'alarmed' && ['noise', 'item_taken', 'item_missing'].includes(o.kind))
    score += 10;
  return score;
}
function groundedNpcNarrative(m: LivingNpcMemory, source: NpcObservation[]): string {
  const changes = source.map((o) => `${o.kind}:${o.id}`).join('; ');
  const pending = m.obligations
    .filter((o) => ['accepted', 'proposed'].includes(o.status))
    .map((o) => o.id)
    .join(', ');
  return `Role: ${m.personality.role}. Current purpose: ${m.goal.kind}. Evidence: ${changes}. Unfinished commitments: ${pending}.`.slice(
    0,
    1200,
  );
}

export const createNpcMemorySummarySelection = (state: GameState, npcId: string, ids: string[]) =>
  createNpcMemorySummary(state, npcId, ids);

export function proposeNpcActionObligation(
  state: GameState,
  npcId: string,
  toActorId: string,
  input: unknown,
  evidenceIds: string[],
  conditions: NpcCondition[] = [],
  dueTicks = 200,
): GameResult {
  const parsed = npcPromisedActionSchema.safeParse(input),
    npc = state.entities[npcId],
    recipient = state.entities[toActorId],
    m = state.npcBrains?.[npcId]?.living;
  if (
    !parsed.success ||
    !m ||
    npc?.kind !== 'npc' ||
    recipient?.kind !== 'player' ||
    !near(npc, recipient)
  )
    return result(state, [], 'FORBIDDEN');
  const action = parsed.data,
    target = state.entities[action.targetId];
  if (
    !target ||
    !visible(state, npc, target) ||
    !visible(state, recipient, target) ||
    (action.kind === 'open' && (target.kind !== 'door' || target.locked))
  )
    return result(state, [], 'TARGET_UNAVAILABLE');
  if (
    !Number.isInteger(dueTicks) ||
    dueTicks < 1 ||
    dueTicks > 12000 ||
    conditions.length > 4 ||
    conditions.some((c) => !npcConditionSchema.safeParse(c).success) ||
    !evidenceIds.length ||
    evidenceIds.some((id) => !m.observations.some((o) => o.id === id && o.actorId === toActorId))
  )
    return result(state, [], 'INVALID_ACTION');
  const existing = m.obligations.find(
    (o) =>
      o.promisedAction?.kind === action.kind &&
      o.promisedAction.targetId === action.targetId &&
      ['proposed', 'accepted'].includes(o.status),
  );
  if (existing)
    return existing.toActorId === toActorId ? result(state) : result(state, [], 'FORBIDDEN');
  if (m.obligations.filter((o) => ['proposed', 'accepted'].includes(o.status)).length >= 128)
    return result(state, [], 'RATE_LIMITED');
  if (!npcActionAllowed(state, npcId, action)) return result(state, [], 'FORBIDDEN');
  const s = clone(state),
    next = s.npcBrains![npcId].living!,
    id = `promise-${hash(`${npcId}:${toActorId}:${JSON.stringify(action)}:${evidenceIds.join(',')}`)}`;
  if (next.obligations.some((o) => o.id === id)) return result(state);
  const source = m.observations.find((o) => evidenceIds.includes(o.id) && o.text);
  next.obligations.push({
    id,
    toActorId,
    promisedAction: clone(action),
    createdTick: s.tick,
    dueTick: s.tick + dueTicks,
    status: 'proposed',
    evidenceIds: [...evidenceIds],
    conditions: clone(conditions),
    sourceUtteranceId: source?.eventId,
    sourceUtterance: source?.text,
  });
  notice(s, npcId, 'promise_offered', id, [toActorId]);
  s.revision++;
  return result(s, [{ kind: 'npc.promise_offered', actorId: npcId, mapId: npc.mapId }]);
}

/** A planner selects evidence, never a private prose string or its own disclosure permission. */
export function communicateNpcObservations(
  state: GameState,
  npcId: string,
  action: GameAction,
): GameResult {
  const npc = state.entities[npcId],
    recipient = action.targetId ? state.entities[action.targetId] : undefined,
    m = state.npcBrains?.[npcId]?.living;
  if (
    state.rulesetVersion !== 'hybrid-v3' ||
    npc?.kind !== 'npc' ||
    !m ||
    !recipient ||
    !['player', 'npc'].includes(recipient.kind) ||
    !near(npc, recipient) ||
    !visible(state, npc, recipient)
  )
    return result(state, [], 'TARGET_UNAVAILABLE');
  if (npc.encounterId || recipient.encounterId) return result(state, [], 'WRONG_MODE');
  if (
    action.kind !== 'communicate' ||
    !action.channel ||
    !action.observationIds?.length ||
    action.observationIds.length > 4 ||
    new Set(action.observationIds).size !== action.observationIds.length
  )
    return result(state, [], 'INVALID_ACTION');
  if (m.personality.taboos.includes('share_rumors')) return result(state, [], 'FORBIDDEN');
  const audienceIds =
    action.channel === 'whisper'
      ? [npcId, recipient.id]
      : Object.values(state.entities)
          .filter((e) => ['npc', 'player'].includes(e.kind) && canNpcHear(state, e, npc))
          .map((e) => e.id)
          .sort();
  const context = buildNpcPublicSpeechContext(state, npcId, audienceIds, action.observationIds, []);
  if (context.claims.length !== action.observationIds.length) return result(state, [], 'FORBIDDEN');
  const sources = action.observationIds.map((id) => m.observations.find((o) => o.id === id)!);
  if (sources.some((o) => o.depth >= 3)) return result(state, [], 'FORBIDDEN');
  const rendered = createMockNpcPublicResponse(context);
  const committed = commitNpcPublicUtterance(state, npcId, {
    ...rendered,
    channel: action.channel,
    recipientId: recipient.id,
    observationIds: action.observationIds,
    contextHash: npcContextFingerprint(context),
  });
  if (committed.error) return committed;
  let s = committed.state;
  let changed = false;
  for (const listenerId of audienceIds) {
    if (listenerId === npcId) continue;
    const memory = s.npcBrains?.[listenerId]?.living;
    if (!memory) continue;
    if (s === state) s = clone(s);
    const target = s.npcBrains![listenerId].living!;
    for (const source of sources) {
      const eventId = `communicated-${hash(`${npcId}:${listenerId}:${source.rootId}`)}`;
      changed =
        remember(target, {
          ...clone(source),
          id: `${listenerId}:${eventId}`,
          eventId,
          rootId: source.rootId,
          channel: 'report',
          confidence: 'reported',
          sourceNpcId: npcId,
          depth: source.depth + 1,
          disclosure: source.disclosure === 'public' ? 'public' : 'participants',
          audienceIds: source.disclosure === 'public' ? [] : audienceIds,
          revealCondition: undefined,
        }) || changed;
    }
  }
  if (changed) s.revision++;
  return result(s, [
    ...committed.events,
    { kind: 'npc.communicated', actorId: npcId, targetId: recipient.id, mapId: npc.mapId },
  ]);
}
