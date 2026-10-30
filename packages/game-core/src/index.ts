import { projectVisibleArtBindings } from './art';
import { chooseLivingNpcIntent, publicNpcFactTopics, communicateNpcObservations } from './living';
import { npcActionAllowed } from './living-policy';
import {
  gameActionSchema,
  gameMoveSchema,
  gameIntentSchema,
  npcProposalSchema,
  type GameAction,
  type GameEncounter,
  type GameEntity,
  type GameError,
  type GameEvent,
  type GameIntentInput,
  type GameMove,
  type GamePoint,
  type GameProjection,
  type GameResult,
  type GameState,
} from '@dreamwalk/contracts';
export * from '@dreamwalk/contracts';
const copy = (s: GameState): GameState => structuredClone(s);
const result = (state: GameState, events: GameEvent[] = []): GameResult => ({ state, events });
const fail = (state: GameState, error: GameError): GameResult => ({ state, events: [], error });
const same = (a: GamePoint, b: GamePoint) => a.x === b.x && a.y === b.y;
const distance = (a: GamePoint, b: GamePoint) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const key = (p: GamePoint) => `${p.x},${p.y}`;
const directions = [
  { x: 0, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
];
const inside = (p: GamePoint, a: GameEncounter['area']) =>
  p.x >= a.x && p.y >= a.y && p.x < a.x + a.width && p.y < a.y + a.height;
export function walkable(
  s: GameState,
  mapId: string,
  p: GamePoint,
  actorId?: string,
  strict = false,
): boolean {
  const m = s.maps[mapId];
  if (
    !m ||
    p.x < 0 ||
    p.y < 0 ||
    p.x >= m.width ||
    p.y >= m.height ||
    m.blocked.some((b) => same(b, p))
  )
    return false;
  return !Object.values(s.entities).some(
    (e) =>
      e.mapId === mapId &&
      e.id !== actorId &&
      !e.ownerId &&
      same(e, p) &&
      ((e.kind === 'door' && !e.open) || (strict && (e.kind === 'player' || e.kind === 'npc'))),
  );
}
export function findPath(
  s: GameState,
  mapId: string,
  from: GamePoint,
  to: GamePoint,
  actorId?: string,
  strict = false,
  area?: GameEncounter['area'],
): GamePoint[] | null {
  if (
    (area && (!inside(from, area) || !inside(to, area))) ||
    !walkable(s, mapId, to, actorId, strict)
  )
    return null;
  const queue = [from],
    seen = new Set([key(from)]),
    parents = new Map<string, GamePoint>();
  let found = false;
  for (let i = 0; i < queue.length && i < 4096; i++) {
    const p = queue[i];
    if (same(p, to)) {
      found = true;
      break;
    }
    for (const d of directions) {
      const n = { x: p.x + d.x, y: p.y + d.y };
      if (
        (!area || inside(n, area)) &&
        !seen.has(key(n)) &&
        walkable(s, mapId, n, actorId, strict)
      ) {
        seen.add(key(n));
        parents.set(key(n), p);
        queue.push(n);
      }
    }
  }
  if (!found) return null;
  const path: GamePoint[] = [];
  let p = to;
  while (!same(p, from)) {
    path.unshift(p);
    p = parents.get(key(p))!;
  }
  return path;
}
export function createObservatoryState(actorIds: string[] = [], seed = 1): GameState {
  const blocked: GamePoint[] = [];
  for (let y = 0; y < 12; y++)
    for (let x = 0; x < 16; x++)
      if (x === 0 || y === 0 || x === 15 || y === 11 || (x === 10 && y !== 5))
        blocked.push({ x, y });
  let s: GameState = {
    schemaVersion: 1,
    rulesetVersion: 'observatory-v1',
    seed,
    tick: 0,
    revision: 0,
    maps: {
      observatory: {
        id: 'observatory',
        width: 16,
        height: 12,
        blocked,
        spawns: [
          { x: 2, y: 6 },
          { x: 3, y: 6 },
          { x: 2, y: 7 },
          { x: 3, y: 7 },
        ],
        exits: [
          { id: 'roof-exit', x: 13, y: 5, destinationMapId: 'roof', destination: { x: 2, y: 3 } },
        ],
        revision: 0,
      },
      roof: {
        id: 'roof',
        width: 12,
        height: 9,
        blocked: [],
        spawns: [{ x: 2, y: 3 }],
        exits: [
          {
            id: 'observatory-exit',
            x: 1,
            y: 3,
            destinationMapId: 'observatory',
            destination: { x: 13, y: 5 },
          },
        ],
        revision: 0,
      },
    },
    entities: {
      key: { id: 'key', kind: 'item', mapId: 'observatory', x: 5, y: 6, revision: 0 },
      door: {
        id: 'door',
        kind: 'door',
        mapId: 'observatory',
        x: 10,
        y: 5,
        revision: 0,
        locked: true,
        open: false,
        keyId: 'key',
      },
      keeper: {
        id: 'keeper',
        kind: 'npc',
        mapId: 'observatory',
        x: 6,
        y: 4,
        revision: 0,
        inventory: ['token'],
        movementGeneration: 0,
        lastInputSeq: 0,
        knownIds: ['token', 'door'],
      },
      token: {
        id: 'token',
        kind: 'item',
        mapId: 'observatory',
        x: 6,
        y: 4,
        revision: 0,
        ownerId: 'keeper',
      },
    },
    encounters: {},
  };
  for (const id of actorIds) s = addPlayer(s, id).state;
  return s;
}
export function addPlayer(state: GameState, id: string): GameResult {
  if (state.entities[id]) return result(state);
  if (Object.values(state.entities).filter((e) => e.kind === 'player').length >= 4)
    return fail(state, 'FORBIDDEN');
  const s = copy(state),
    n = Object.values(s.entities).filter((e) => e.kind === 'player').length;
  const mapId = s.startMapId ?? 'observatory',
    map = s.maps[mapId];
  if (!map?.spawns.length) return fail(state, 'PATH_BLOCKED');
  s.entities[id] = {
    id,
    kind: 'player',
    mapId,
    ...map.spawns[n % map.spawns.length],
    revision: 0,
    inventory: [],
    movementGeneration: 0,
    lastInputSeq: 0,
  };
  s.revision++;
  return result(s, [{ kind: 'actor.joined', actorId: id, mapId }]);
}
export function moveInput(state: GameState, id: string, input: GameMove): GameResult {
  if (!gameMoveSchema.safeParse(input).success) return fail(state, 'INVALID_ACTION');
  const a = state.entities[id];
  if (!a || (a.kind !== 'player' && a.kind !== 'npc')) return fail(state, 'FORBIDDEN');
  if (a.encounterId) return fail(state, 'WRONG_MODE');
  if (input.movementGeneration !== a.movementGeneration || input.inputSeq <= (a.lastInputSeq ?? 0))
    return fail(state, 'STALE_STATE');
  const path = findPath(state, a.mapId, a, input.target, id);
  if (!path || path.length > 128) return fail(state, 'PATH_BLOCKED');
  if (
    path.some((p) =>
      Object.values(state.encounters).some(
        (e) => e.phase === 'planning' && e.mapId === a.mapId && inside(p, e.area),
      ),
    )
  )
    return fail(state, 'WRONG_MODE');
  const s = copy(state);
  s.entities[id].path = path;
  s.entities[id].lastInputSeq = input.inputSeq;
  return result(s);
}
export function stopMovement(state: GameState, id: string): GameResult {
  if (!state.entities[id]) return fail(state, 'FORBIDDEN');
  const s = copy(state);
  s.entities[id].path = [];
  s.entities[id].movementGeneration = (s.entities[id].movementGeneration ?? 0) + 1;
  return result(s);
}
export function tick(state: GameState, tickCount = 1): GameResult {
  const s = copy(state),
    events: GameEvent[] = [];
  for (let i = 0; i < Math.min(20, Math.max(0, tickCount)); i++) {
    s.tick++;
    if (s.tick % 4 !== 0) continue;
    for (const a of Object.values(s.entities).sort((a, b) => a.id.localeCompare(b.id))) {
      if (a.encounterId || !a.path?.length) continue;
      const next = a.path[0];
      if (
        !walkable(s, a.mapId, next, a.id) ||
        Object.values(s.encounters).some(
          (e) => e.phase === 'planning' && e.mapId === a.mapId && inside(next, e.area),
        )
      ) {
        a.path = [];
        continue;
      }
      a.path.shift();
      Object.assign(a, next);
      a.revision++;
      s.revision++;
      events.push({ kind: 'actor.moved', actorId: a.id, mapId: a.mapId });
    }
  }
  return result(s, events);
}
export function visible(s: GameState, a: GameEntity, b: GameEntity): boolean {
  if (a.mapId !== b.mapId || b.ownerId || distance(a, b) > 9) return false;
  let x = a.x,
    y = a.y;
  const dx = Math.abs(b.x - x),
    dy = -Math.abs(b.y - y),
    sx = x < b.x ? 1 : -1,
    sy = y < b.y ? 1 : -1;
  let err = dx + dy;
  for (let i = 0; i < 128; i++) {
    if (x === b.x && y === b.y) return true;
    if ((x !== a.x || y !== a.y) && !walkable(s, a.mapId, { x, y }, a.id)) return false;
    const e = 2 * err;
    if (e >= dy) {
      err += dy;
      x += sx;
    }
    if (e <= dx) {
      err += dx;
      y += sy;
    }
  }
  return false;
}
function actionInternal(
  state: GameState,
  id: string,
  action: GameAction,
  inRound = false,
): GameResult {
  const a = state.entities[id];
  if (!a) return fail(state, 'FORBIDDEN');
  if (a.kind === 'npc' && !npcActionAllowed(state, id, action)) return fail(state, 'FORBIDDEN');
  if (a.encounterId && !inRound) return fail(state, 'WRONG_MODE');
  if (!gameActionSchema.safeParse(action).success) return fail(state, 'INVALID_ACTION');
  if (action.kind === 'communicate') return communicateNpcObservations(state, id, action);
  if (action.kind === 'move_to') {
    if (!action.target) return fail(state, 'INVALID_ACTION');
    if (!inRound)
      return moveInput(state, id, {
        inputSeq: (a.lastInputSeq ?? 0) + 1,
        movementGeneration: a.movementGeneration ?? 0,
        target: action.target,
      });
    if (
      (a.encounterId && !inside(action.target, state.encounters[a.encounterId].area)) ||
      distance(a, action.target) > 1 ||
      !walkable(state, a.mapId, action.target, id, true)
    )
      return fail(state, 'PATH_BLOCKED');
    const s = copy(state);
    Object.assign(s.entities[id], action.target);
    s.entities[id].revision++;
    s.revision++;
    return result(s, [{ kind: 'actor.moved', actorId: id, mapId: a.mapId }]);
  }
  if (['wait', 'defend', 'flee'].includes(action.kind)) {
    const s = copy(state);
    if (action.kind === 'flee' && a.encounterId) {
      const e = s.encounters[a.encounterId];
      const exit = directions
        .map((d) => ({ x: a.x + d.x, y: a.y + d.y }))
        .find(
          (p) =>
            !inside(p, e.area) &&
            walkable(s, a.mapId, p, id, true) &&
            !Object.values(s.encounters).some(
              (other) =>
                other.id !== e.id &&
                other.phase === 'planning' &&
                other.mapId === a.mapId &&
                inside(p, other.area),
            ),
        );
      if (!exit) return fail(state, 'PATH_BLOCKED');
      Object.assign(s.entities[id], exit);
      e.participants = e.participants.filter((p) => p !== id);
      if (e.endVotes) e.endVotes = e.endVotes.filter((p) => p !== id);
      if (e.coordinatorId === id)
        e.coordinatorId = e.participants.filter((p) => s.entities[p]?.kind === 'player').sort()[0];
      delete s.entities[id].encounterId;
      s.entities[id].movementGeneration = (a.movementGeneration ?? 0) + 1;
    }
    s.revision++;
    return result(s, [{ kind: `actor.${action.kind}`, actorId: id, mapId: a.mapId }]);
  }
  if (action.kind === 'transition') {
    if (a.encounterId) return fail(state, 'WRONG_MODE');
    const exit = state.maps[a.mapId].exits.find((e) => e.id === action.targetId);
    if (!exit) return fail(state, 'TARGET_UNAVAILABLE');
    if (distance(a, exit) > 1) return fail(state, 'OUT_OF_RANGE');
    if (exit.doorId && !state.entities[exit.doorId]?.open) return fail(state, 'PATH_BLOCKED');
    if (
      Object.values(state.encounters).some(
        (e) =>
          e.phase === 'planning' &&
          e.mapId === exit.destinationMapId &&
          inside(exit.destination, e.area),
      )
    )
      return fail(state, 'WRONG_MODE');
    if (!walkable(state, exit.destinationMapId, exit.destination, id))
      return fail(state, 'PATH_BLOCKED');
    const s = copy(state);
    Object.assign(s.entities[id], exit.destination, {
      mapId: exit.destinationMapId,
      path: [],
      movementGeneration: (a.movementGeneration ?? 0) + 1,
      revision: a.revision + 1,
    });
    s.revision++;
    return result(s, [{ kind: 'actor.transitioned', actorId: id, mapId: exit.destinationMapId }]);
  }
  const target = action.targetId ? state.entities[action.targetId] : undefined;
  if (!target || !visible(state, a, target)) return fail(state, 'TARGET_UNAVAILABLE');
  if (distance(a, target) > 1) return fail(state, 'OUT_OF_RANGE');
  if (
    (target.encounterId && target.encounterId !== a.encounterId) ||
    Object.values(state.encounters).some(
      (e) =>
        e.phase === 'planning' &&
        e.mapId === target.mapId &&
        inside(target, e.area) &&
        (!inRound || e.id !== a.encounterId),
    )
  )
    return fail(state, 'WRONG_MODE');
  const s = copy(state),
    actor = s.entities[id],
    t = s.entities[target.id];
  if (['lock', 'knock'].includes(action.kind) && state.rulesetVersion !== 'hybrid-v3')
    return fail(state, 'INVALID_ACTION');
  switch (action.kind) {
    case 'pick_up':
      if (t.kind !== 'item' || t.ownerId) return fail(state, 'TARGET_UNAVAILABLE');
      t.ownerId = id;
      (actor.inventory ??= []).push(t.id);
      break;
    case 'give': {
      const item = action.itemId ? s.entities[action.itemId] : undefined;
      if (!item || item.ownerId !== id || !['player', 'npc'].includes(t.kind))
        return fail(state, 'FORBIDDEN');
      actor.inventory = actor.inventory?.filter((v) => v !== item.id);
      (t.inventory ??= []).push(item.id);
      item.ownerId = t.id;
      item.revision++;
      break;
    }
    case 'lock':
      if (
        t.kind !== 'door' ||
        t.open ||
        !actor.inventory?.includes(t.keyId ?? '') ||
        (action.itemId !== undefined && action.itemId !== t.keyId)
      )
        return fail(state, 'FORBIDDEN');
      t.locked = true;
      s.maps[a.mapId].revision++;
      break;
    case 'knock':
      if (t.kind !== 'door') return fail(state, 'INVALID_ACTION');
      break;
    case 'unlock':
      if (
        t.kind !== 'door' ||
        (action.itemId !== undefined && action.itemId !== t.keyId) ||
        !actor.inventory?.includes(t.keyId ?? '')
      )
        return fail(state, 'FORBIDDEN');
      t.locked = false;
      s.maps[a.mapId].revision++;
      break;
    case 'open':
      if (t.kind !== 'door' || t.locked) return fail(state, 'FORBIDDEN');
      t.open = true;
      s.maps[a.mapId].revision++;
      break;
    case 'close':
      if (
        t.kind !== 'door' ||
        Object.values(s.entities).some(
          (e) =>
            e.id !== t.id &&
            e.mapId === t.mapId &&
            ['player', 'npc'].includes(e.kind) &&
            same(e, t),
        )
      )
        return fail(state, 'PATH_BLOCKED');
      t.open = false;
      s.maps[a.mapId].revision++;
      break;
    case 'inspect':
    case 'talk':
    case 'distract':
      break;
    default:
      return fail(state, 'INVALID_ACTION');
  }
  t.revision++;
  actor.revision++;
  s.revision++;
  return result(s, [
    {
      kind: `action.${action.kind}`,
      actorId: id,
      targetId: t.id,
      mapId: a.mapId,
      ...(action.itemId ? { itemId: action.itemId } : {}),
    },
  ]);
}
export const applyAction = (state: GameState, id: string, action: GameAction): GameResult =>
  actionInternal(state, id, action);
export function beginEncounter(state: GameState, id: string, nowMs = 0): GameResult {
  const actor = state.entities[id];
  if (!actor || actor.encounterId) return fail(state, 'WRONG_MODE');
  const area = { x: Math.max(0, actor.x - 2), y: Math.max(0, actor.y - 2), width: 5, height: 5 };
  if (
    Object.values(state.encounters).some(
      (e) =>
        e.phase === 'planning' &&
        e.mapId === actor.mapId &&
        e.area.x < area.x + area.width &&
        e.area.x + e.area.width > area.x &&
        e.area.y < area.y + area.height &&
        e.area.y + e.area.height > area.y,
    )
  )
    return fail(state, 'WRONG_MODE');
  const s = copy(state),
    participants = Object.values(s.entities)
      .filter(
        (a) => ['player', 'npc'].includes(a.kind) && a.mapId === actor.mapId && inside(a, area),
      )
      .map((a) => a.id)
      .sort(),
    occupied = new Set<string>();
  for (const p of participants) {
    const a = s.entities[p];
    if (occupied.has(key(a))) {
      const candidates: GamePoint[] = [];
      for (let y = area.y; y < area.y + area.height; y++)
        for (let x = area.x; x < area.x + area.width; x++) candidates.push({ x, y });
      candidates.sort((l, r) => distance(a, l) - distance(a, r) || l.y - r.y || l.x - r.x);
      const next = candidates.find(
        (c) => !occupied.has(key(c)) && findPath(s, a.mapId, a, c, p, false, area) !== null,
      );
      if (!next) return fail(state, 'PATH_BLOCKED');
      Object.assign(a, next);
    }
    occupied.add(key(a));
    a.path = [];
    a.movementGeneration = (a.movementGeneration ?? 0) + 1;
    a.revision++;
  }
  const encounterId = `encounter-${s.revision + 1}`;
  s.encounters[encounterId] = {
    id: encounterId,
    mapId: actor.mapId,
    generation: 1,
    round: 1,
    phase: 'planning',
    participants,
    area,
    deadlineMs: nowMs + (s.roundPolicy?.planningMs ?? 30000),
    ...(s.roundPolicy
      ? { policy: { ...s.roundPolicy }, pendingJoinIds: [], endVotes: [], coordinatorId: id }
      : {}),
    intents: {},
  };
  for (const p of participants) s.entities[p].encounterId = encounterId;
  s.revision++;
  return result(s, [{ kind: 'encounter.started', actorId: id, mapId: actor.mapId }]);
}
export function submitIntent(state: GameState, id: string, input: GameIntentInput): GameResult {
  if (!gameIntentSchema.safeParse(input).success) return fail(state, 'INVALID_ACTION');
  const e = state.encounters[input.encounterId];
  if (!e || !e.participants.includes(id) || state.entities[id]?.encounterId !== e.id)
    return fail(state, 'FORBIDDEN');
  if (e.phase !== 'planning' || input.generation !== e.generation || input.round !== e.round)
    return fail(state, 'STALE_STATE');
  const prior = e.intents[id];
  if (prior?.ready) return fail(state, 'ROUND_LOCKED');
  if (prior && input.intentRevision <= prior.revision) return fail(state, 'STALE_STATE');
  if (!gameActionSchema.safeParse(input.action).success) return fail(state, 'INVALID_ACTION');
  const s = copy(state);
  s.encounters[e.id].intents[id] = {
    revision: input.intentRevision,
    action: input.action,
    ready: input.ready,
  };
  s.revision++;
  return result(s, [{ kind: 'encounter.intent', actorId: id, mapId: e.mapId }]);
}
const hash = (seed: number, id: string) => {
  let n = seed >>> 0;
  for (const c of id) n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0;
  return n;
};
export function resolveRound(state: GameState, encounterId: string, nowMs: number): GameResult {
  const encounter = state.encounters[encounterId];
  if (!encounter || encounter.phase !== 'planning') return fail(state, 'WRONG_MODE');
  if (
    nowMs < encounter.deadlineMs &&
    !encounter.participants.every(
      (id) => state.entities[id].kind === 'npc' || encounter.intents[id]?.ready,
    )
  )
    return fail(state, 'ROUND_LOCKED');
  let s = copy(state);
  const events: GameEvent[] = [];
  if (s.rulesetVersion === 'hybrid-v3')
    for (const id of encounter.participants)
      if (s.entities[id]?.kind === 'npc')
        s.encounters[encounterId].intents[id] = {
          revision: 1,
          ready: true,
          action: chooseLivingNpcIntent(state, id),
        };
  const roundIntents = s.encounters[encounterId].intents;
  const phase = (a: GameAction) => (a.kind === 'distract' ? 0 : a.kind === 'move_to' ? 1 : 2);
  const ordered = [...encounter.participants].sort(
    (a, b) =>
      phase(roundIntents[a]?.action ?? { kind: 'wait' }) -
        phase(roundIntents[b]?.action ?? { kind: 'wait' }) ||
      hash(s.seed + encounter.round, a) - hash(s.seed + encounter.round, b) ||
      a.localeCompare(b),
  );
  for (const id of ordered) {
    const action = roundIntents[id]?.action ?? { kind: 'wait' as const };
    const r = actionInternal(s, id, action, true);
    if (r.error)
      events.push({ kind: 'action.rejected', actorId: id, code: r.error, mapId: encounter.mapId });
    else {
      s = r.state;
      events.push(...r.events);
    }
  }
  const e = s.encounters[encounterId];
  const players = e.participants.filter((id) => s.entities[id]?.kind === 'player');
  const completed =
    !e.policy ||
    e.round >= e.policy.maxRounds ||
    players.length === 0 ||
    players.every((id) => e.endVotes?.includes(id));
  e.intents = {};
  if (completed) {
    e.phase = 'completed';
    e.pendingJoinIds = [];
    for (const id of e.participants) {
      if (!s.entities[id]) continue;
      delete s.entities[id].encounterId;
      s.entities[id].path = [];
      s.entities[id].movementGeneration = (s.entities[id].movementGeneration ?? 0) + 1;
    }
    events.push({ kind: 'encounter.completed', mapId: e.mapId });
  } else {
    for (const id of [...(e.pendingJoinIds ?? [])].sort()) {
      const actor = s.entities[id];
      if (!actor || actor.encounterId || actor.mapId !== e.mapId) continue;
      const candidates = [
        { x: actor.x, y: actor.y },
        ...directions.map((d) => ({ x: actor.x + d.x, y: actor.y + d.y })),
      ];
      const point = candidates.find((p) => inside(p, e.area) && walkable(s, e.mapId, p, id, true));
      if (!point) {
        events.push({
          kind: 'encounter.join_rejected',
          actorId: id,
          mapId: e.mapId,
          code: 'PATH_BLOCKED',
        });
        continue;
      }
      Object.assign(actor, point);
      actor.path = [];
      actor.encounterId = e.id;
      actor.movementGeneration = (actor.movementGeneration ?? 0) + 1;
      actor.revision++;
      e.participants.push(id);
      events.push({ kind: 'encounter.joined', actorId: id, mapId: e.mapId });
    }
    e.pendingJoinIds = [];
    e.endVotes = [];
    e.round++;
    e.deadlineMs = nowMs + e.policy!.planningMs;
    events.push({ kind: 'encounter.round_started', mapId: e.mapId });
  }
  s.revision++;
  return result(s, events);
}
export function requestEncounterJoin(
  state: GameState,
  id: string,
  encounterId: string,
): GameResult {
  const actor = state.entities[id],
    e = state.encounters[encounterId];
  if (
    !actor ||
    actor.kind !== 'player' ||
    !e ||
    e.phase !== 'planning' ||
    !e.policy ||
    e.mapId !== actor.mapId
  )
    return fail(state, 'TARGET_UNAVAILABLE');
  if (actor.encounterId) return fail(state, 'WRONG_MODE');
  const adjacent = [actor, ...directions.map((d) => ({ x: actor.x + d.x, y: actor.y + d.y }))].some(
    (p) => inside(p, e.area) && walkable(state, e.mapId, p, id),
  );
  if (!adjacent) return fail(state, 'OUT_OF_RANGE');
  if (e.pendingJoinIds?.includes(id)) return result(state);
  if ((e.pendingJoinIds?.length ?? 0) >= 4) return fail(state, 'RATE_LIMITED');
  const s = copy(state);
  (s.encounters[e.id].pendingJoinIds ??= []).push(id);
  s.revision++;
  return result(s, [{ kind: 'encounter.join_requested', actorId: id, mapId: e.mapId }]);
}
export function requestEncounterEnd(state: GameState, id: string): GameResult {
  const actor = state.entities[id],
    e = actor?.encounterId ? state.encounters[actor.encounterId] : undefined;
  if (!e || e.phase !== 'planning' || !e.participants.includes(id) || actor.kind !== 'player')
    return fail(state, 'WRONG_MODE');
  const s = copy(state),
    next = s.encounters[e.id];
  if (!(next.endVotes ??= []).includes(id)) next.endVotes.push(id);
  if (!next.intents[id]?.ready)
    next.intents[id] = {
      revision: (next.intents[id]?.revision ?? 0) + 1,
      ready: true,
      action: { kind: 'wait' },
    };
  s.revision++;
  return result(s, [{ kind: 'encounter.end_requested', actorId: id, mapId: e.mapId }]);
}

export function projectState(s: GameState, id: string): GameProjection {
  const actor = s.entities[id];
  if (!actor) throw new Error('FORBIDDEN');
  const clean = (e: GameEntity): GameEntity => {
    const c = structuredClone(e);
    delete c.path;
    delete c.lastMoveTick;
    delete c.knownIds;
    delete c.inventory;
    if (c.id !== id) {
      delete c.lastInputSeq;
      delete c.movementGeneration;
    }
    return c;
  };
  const encounter = actor.encounterId
    ? structuredClone(s.encounters[actor.encounterId])
    : undefined;
  if (encounter) {
    if (encounter.pendingJoinIds)
      encounter.pendingJoinIds = encounter.pendingJoinIds.filter((p) => p === id);
  }
  if (encounter)
    for (const [p, intent] of Object.entries(encounter.intents))
      if (p !== id) intent.action = { kind: 'wait' };
  return {
    schemaVersion: 1,
    ...(s.assetManifest ? { assetManifest: { ...s.assetManifest } } : {}),
    ...(s.artBindings ? { artBindings: projectVisibleArtBindings(s, id) } : {}),
    rulesetVersion: s.rulesetVersion,
    tick: s.tick,
    revision: s.revision,
    actorId: id,
    map: structuredClone(s.maps[actor.mapId]),
    entities: Object.values(s.entities)
      .filter((e) => e.id === id || visible(s, actor, e))
      .map(clean),
    inventory: (actor.inventory ?? []).map((i) => clean(s.entities[i])),
    encounter,
    ...(s.rulesetVersion === 'hybrid-v3'
      ? {
          npcFactTopics: Object.values(s.entities)
            .filter((e) => e.kind === 'npc' && visible(s, actor, e))
            .flatMap((e) => publicNpcFactTopics(s, e.id).map((t) => ({ npcId: e.id, ...t }))),
          npcUtterances: (s.npcUtterances ?? [])
            .filter((u) => u.mapId === actor.mapId && u.audienceIds.includes(id))
            .slice(-32)
            .map((u) => ({
              id: u.id,
              tick: u.tick,
              ...(u.speakerKnownToIds.includes(id) ? { speakerId: u.speakerId } : {}),
              ...(u.text ? { text: u.text } : {}),
              ...(u.code ? { code: u.code } : {}),
            })),
          npcNotices: (s.npcNotices ?? [])
            .filter((n) => n.mapId === actor.mapId && n.audienceIds.includes(id))
            .slice(-32)
            .map(({ id, npcId, kind, tick }) => ({ id, npcId, kind, tick })),
          npcObligations: Object.entries(s.npcBrains ?? {})
            .flatMap(([npcId, b]) =>
              (b.living?.obligations ?? [])
                .filter((o) => o.toActorId === id)
                .map((o) => ({
                  id: o.id,
                  npcId,
                  ...(o.itemId ? { itemId: o.itemId } : {}),
                  ...(o.promisedAction
                    ? { promisedAction: structuredClone(o.promisedAction) }
                    : {}),
                  status: o.status,
                  remainingTicks: Math.max(0, o.dueTick - s.tick),
                })),
            )
            .slice(-128),
        }
      : {}),
    ...(s.rulesetVersion !== 'observatory-v1'
      ? {
          nearbyEncounters: Object.values(s.encounters)
            .filter(
              (e) =>
                e.phase === 'planning' &&
                e.mapId === actor.mapId &&
                e.participants.some((p) => s.entities[p] && visible(s, actor, s.entities[p])),
            )
            .map((e) => ({
              id: e.id,
              mapId: e.mapId,
              area: structuredClone(e.area),
              round: e.round,
              phase: 'planning' as const,
              participantCount: e.participants.length,
            })),
        }
      : {}),
  };
}
export function mockNpcDecision(s: GameState, id = 'keeper'): unknown {
  const a = s.entities[id];
  if (!a) return null;
  const recipient = Object.values(s.entities).find(
    (e) => e.kind === 'player' && visible(s, a, e) && distance(a, e) <= 1,
  );
  const action: GameAction =
    recipient && a.inventory?.length
      ? { kind: 'give', targetId: recipient.id, itemId: a.inventory[0] }
      : { kind: 'move_to', target: { x: 7, y: 4 } };
  return {
    contextRevision: s.revision,
    mapRevision: s.maps[a.mapId].revision,
    entityRevision: a.revision,
    deadlineTick: s.tick + 160,
    targetRevision: action.targetId ? s.entities[action.targetId]?.revision : undefined,
    action,
  };
}
export function validateNpcProposal(state: GameState, id: string, value: unknown): GameResult {
  const npc = state.entities[id];
  if (!npc || npc.kind !== 'npc') return fail(state, 'FORBIDDEN');
  const parsed = npcProposalSchema.safeParse(value);
  if (!parsed.success) return fail(state, 'INVALID_ACTION');
  const p = parsed.data;
  if (!['move_to', 'wait', 'inspect', 'give'].includes(p.action.kind))
    return fail(state, 'INVALID_ACTION');
  if (
    p.deadlineTick < state.tick ||
    p.contextRevision > state.revision ||
    p.entityRevision !== npc.revision ||
    p.mapRevision !== state.maps[npc.mapId].revision ||
    npc.encounterId
  )
    return fail(state, 'STALE_STATE');
  if (p.action.targetId) {
    const target = state.entities[p.action.targetId];
    if (!target || !visible(state, npc, target)) return fail(state, 'TARGET_UNAVAILABLE');
    if (p.targetRevision !== target.revision) return fail(state, 'STALE_STATE');
  }
  if (p.action.itemId && state.entities[p.action.itemId]?.ownerId !== id)
    return fail(state, 'FORBIDDEN');
  return applyAction(state, id, p.action);
}
export function validateMapState(s: GameState): string[] {
  const errors: string[] = [];
  if (!Number.isSafeInteger(s.seed) || s.seed < 0 || s.seed > 0xffffffff)
    errors.push('seed:bounds');
  if (new Set(Object.values(s.maps).map((m) => m.id)).size !== Object.keys(s.maps).length)
    errors.push('map:duplicate-id');
  if (new Set(Object.values(s.entities).map((e) => e.id)).size !== Object.keys(s.entities).length)
    errors.push('entity:duplicate-id');
  for (const [id, m] of Object.entries(s.maps))
    if (id !== m.id) errors.push(`map:${id}:id-mismatch`);
  for (const [id, e] of Object.entries(s.entities))
    if (id !== e.id) errors.push(`entity:${id}:id-mismatch`);
  for (const m of Object.values(s.maps)) {
    if (m.width < 1 || m.height < 1 || m.width > 64 || m.height > 64 || !m.spawns.length)
      errors.push(`map:${m.id}:size`);
    for (const p of m.spawns) if (!walkable(s, m.id, p)) errors.push(`map:${m.id}:spawn`);
    for (const e of m.exits)
      if (!s.maps[e.destinationMapId] || !walkable(s, e.destinationMapId, e.destination))
        errors.push(`map:${m.id}:exit`);
  }
  const ownership = new Map<string, string>();
  for (const e of Object.values(s.entities)) {
    const map = s.maps[e.mapId];
    if (!map || e.x < 0 || e.y < 0 || e.x >= map.width || e.y >= map.height)
      errors.push(`entity:${e.id}:position`);
    if (e.ownerId && (!s.entities[e.ownerId]?.inventory?.includes(e.id) || e.kind !== 'item'))
      errors.push(`entity:${e.id}:owner`);
    for (const item of e.inventory ?? []) {
      if (ownership.has(item) || s.entities[item]?.ownerId !== e.id)
        errors.push(`entity:${item}:duplicate`);
      ownership.set(item, e.id);
    }
  }
  // Explore the lock dependency graph rather than requiring every exit open initially.
  const unlocked = copy(s);
  let progress = true;
  const reachedKeys = new Set<string>(
    Object.values(s.entities)
      .filter(
        (e) => e.kind === 'item' && e.ownerId && s.entities[e.ownerId]?.inventory?.includes(e.id),
      )
      .map((e) => e.id),
  );
  while (progress) {
    progress = false;
    for (const item of Object.values(unlocked.entities).filter(
      (e) => e.kind === 'item' && !e.ownerId,
    )) {
      const map = unlocked.maps[item.mapId];
      if (map?.spawns.some((sp) => findPath(unlocked, map.id, sp, item) !== null))
        reachedKeys.add(item.id);
    }
    for (const door of Object.values(unlocked.entities).filter(
      (e) => e.kind === 'door' && e.locked,
    )) {
      if (door.keyId && reachedKeys.has(door.keyId)) {
        door.locked = false;
        door.open = true;
        progress = true;
      }
    }
  }
  for (const door of Object.values(unlocked.entities).filter((e) => e.kind === 'door' && e.locked))
    errors.push(`entity:${door.id}:unreachable-key`);
  return errors;
}
/** Only perceived public facts and the actor's own inventory enter a mock decision context. */
export function buildNpcContext(state: GameState, id: string) {
  const npc = state.entities[id];
  if (!npc || npc.kind !== 'npc') throw new Error('FORBIDDEN');
  return {
    actorId: id,
    traits: state.npcBrains?.[id]?.traits ?? ['cautious', 'helpful'],
    memory: structuredClone(state.npcBrains?.[id]?.facts ?? []),
    goals: state.npcBrains?.[id]
      ? [state.npcBrains[id].goal]
      : ['watch_observatory', 'help_nearby_visitors'],
    allowedActions: ['move_to', 'wait', 'inspect', 'give'] as const,
    maxPlanActions: state.npcBrains?.[id] ? 3 : 1,
    cooldownTicks: 20,
    ownInventory: [...(npc.inventory ?? [])],
    visible: Object.values(state.entities)
      .filter((e) => e.id !== id && visible(state, npc, e))
      .map((e) => ({ id: e.id, kind: e.kind, x: e.x, y: e.y, revision: e.revision })),
    // Memorized facts are not live positions or permission to target a hidden entity.
    knownIds: [...(npc.knownIds ?? [])],
    mapRevision: state.maps[npc.mapId].revision,
    entityRevision: npc.revision,
  };
}

export * from './authored';

export * from './npc';

export * from './living';

export * from './living-policy';

export * from './living-reasoning';

export * from './art';
