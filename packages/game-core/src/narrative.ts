import {
  BATTLEMAP_CELLS,
  footprintOverlaps,
  readNarrativePreferences,
  narrativeConstraintsSchema,
  localeSchema,
  type Locale,
  narrativeProposalSchema,
  type GameState,
  type GameEntity,
  type GameResult,
  type NarrativeProposal,
} from '@dreamwalk/contracts';
import { applyAction, findPath, visible, walkable } from './index';
import { createLivingMemory, npcContextFingerprint, refreshLivingPerception } from './living';
const normalize = (s: string) =>
  s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
const error = (state: GameState, code: GameResult['error']): GameResult => ({
  state,
  events: [],
  error: code,
});
const policy = (state: GameState) =>
  narrativeConstraintsSchema.parse(state.narrativeConstraints ?? {});
function candidates(state: GameState, actorId: string) {
  const actor = state.entities[actorId],
    map = actor && state.maps[actor.mapId],
    points: { x: number; y: number }[] = [];
  if (!actor || actor.kind !== 'player' || actor.encounterId || !map) return points;
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++) {
      if (
        Math.abs(x - actor.x) + Math.abs(y - actor.y) > 4 ||
        map.exits.some((e) => e.x === x && e.y === y) ||
        map.spawns.some((e) => e.x === x && e.y === y) ||
        Object.values(state.entities).some(
          (e) => e.mapId === map.id && !e.ownerId && e.x === x && e.y === y,
        ) ||
        !walkable(state, map.id, { x, y }, undefined, true) ||
        !visible(state, actor, {
          id: 'narrative-candidate',
          kind: 'item',
          mapId: map.id,
          x,
          y,
          revision: 0,
        }) ||
        !findPath(state, map.id, actor, { x, y }, actorId) ||
        Object.values(state.encounters).some(
          (e) =>
            e.phase === 'planning' &&
            e.mapId === map.id &&
            x >= e.area.x &&
            y >= e.area.y &&
            x < e.area.x + e.area.width &&
            y < e.area.y + e.area.height,
        )
      )
        continue;
      points.push({ x, y });
    }
  return points
    .sort(
      (a, b) =>
        Math.abs(a.x - actor.x) +
          Math.abs(a.y - actor.y) -
          (Math.abs(b.x - actor.x) + Math.abs(b.y - actor.y)) ||
        a.y - b.y ||
        a.x - b.x,
    )
    .slice(0, 32);
}
export function buildNarrativeContext(
  state: GameState,
  actorId: string,
  text: string,
  replyLocale: Locale = 'en',
) {
  const actor = state.entities[actorId],
    constraints = policy(state),
    canon = state.narrativeCanon;
  const context = {
    actorId,
    replyLocale: localeSchema.parse(replyLocale),
    ...(state.narrativePreferences?.[actorId]
      ? { narrativePreferences: readNarrativePreferences(state, actorId) }
      : {}),
    premise: state.narrativePremise ? structuredClone(state.narrativePremise) : null,
    sourceVersion: state.narrativeSource ? { ...state.narrativeSource } : null,
    intent: text,
    canonRevision: canon?.revision ?? 0,
    constraints,
    currentScene: actor
      ? {
          id: actor.mapId,
          label: state.maps[actor.mapId]?.label,
          description:
            canon?.turns.find((turn) => turn.sceneId === actor.mapId)?.introducedScene
              ?.description ?? state.maps[actor.mapId]?.description,
          actorPosition: { x: actor.x, y: actor.y },
        }
      : null,
    availableConnections: candidates(state, actorId),
    visibleEntities: actor
      ? Object.values(state.entities)
          .filter((e) => e.id === actorId || visible(state, actor, e))
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            label: e.label,
            mapId: e.mapId,
            x: e.x,
            y: e.y,
            revision: e.revision,
            ...(e.supportingNpc?.generated ? { publicRole: e.supportingNpc.roleLabel } : {}),
            ...(e.kind === 'door' ? { open: e.open, locked: e.locked } : {}),
          }))
          .sort((a, b) => a.id.localeCompare(b.id))
      : [],
    sharedAudience: actor
      ? Object.values(state.entities)
          .filter((e) => e.kind === 'player' && (e.id === actorId || visible(state, actor, e)))
          .map((e) => ({ id: e.id }))
          .sort((a, b) => a.id.localeCompare(b.id))
      : [],
    confirmedTurns: (canon?.turns ?? []).slice(-16).map((t) => ({
      id: t.id,
      narration: t.narration,
      introducedScene: t.introducedScene,
      introducedNpc: t.introducedNpc,
    })),
    remainingScenes: Math.max(0, constraints.maxScenes - Object.keys(state.maps).length),
    remainingNpcs: Math.max(
      0,
      constraints.maxSupportingNpcs -
        Object.values(state.entities).filter((e) => e.supportingNpc?.generated).length,
    ),
    remainingTurns: Math.max(0, constraints.maxTurns - (canon?.turns.length ?? 0)),
    evidenceIds: (canon?.turns ?? []).map((t) => t.id).slice(-16),
    supportedActions: [
      'inspect',
      'open',
      'close',
      'unlock',
      'pick_up',
      'give',
      'transition',
      'wait',
    ],
    narrativePolicy:
      'Shared campaign story only. Player intent and narrative flavor are not authoritative facts. Do not use private whispers, NPC secrets or unsupported mechanics. New content may extend, never retroactively replace, confirmed canon.',
  };
  const semantic = {
    ...context,
    privateInventory: (actor?.inventory ?? [])
      .filter((id) => state.entities[id]?.ownerId === actorId)
      .map((id) => ({ id, kind: state.entities[id].kind }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    privateDoorKeys: context.visibleEntities
      .filter((e) => e.kind === 'door')
      .map((e) => ({ id: e.id, keyId: state.entities[e.id].keyId })),
    currentScene: context.currentScene
      ? {
          id: context.currentScene.id,
          label: context.currentScene.label,
          description: context.currentScene.description,
        }
      : null,
    availableConnections: undefined,
    visibleEntities: context.visibleEntities.map(
      ({ id, kind, label, mapId, open, locked, publicRole }) => ({
        id,
        kind,
        label,
        mapId,
        open,
        locked,
        publicRole,
      }),
    ),
  };
  return { ...context, contextHash: npcContextFingerprint(semantic) };
}
export function applyNarrativeProposal(
  state: GameState,
  actorId: string,
  input: unknown,
  intent: string,
  replyLocale: Locale = 'en',
): GameResult {
  const parsed = narrativeProposalSchema.safeParse(input);
  if (!parsed.success) return error(state, 'INVALID_ACTION');
  const p = parsed.data,
    requestHash = npcContextFingerprint({ actorId, proposal: p });
  const previous = state.narrativeCanon?.turns.find((t) => t.id === p.turnId);
  if (previous)
    return previous.actorId === actorId && previous.requestHash === requestHash
      ? { state, events: [] }
      : error(state, 'INVALID_ACTION');
  const actor = state.entities[actorId];
  if (actor?.kind !== 'player' || state.rulesetVersion !== 'hybrid-v3')
    return error(state, 'FORBIDDEN');
  if (actor.encounterId) return error(state, 'WRONG_MODE');
  if (typeof intent !== 'string' || !intent.trim() || intent.length > 2000)
    return error(state, 'INVALID_ACTION');
  const context = buildNarrativeContext(state, actorId, intent, replyLocale),
    constraints = policy(state);
  if (context.contextHash !== p.contextHash) return error(state, 'STALE_STATE');
  if (!context.remainingTurns) return error(state, 'RATE_LIMITED');
  if (
    new Set(p.evidenceIds).size !== p.evidenceIds.length ||
    p.evidenceIds.some((id) => !context.evidenceIds.includes(id))
  )
    return error(state, 'FORBIDDEN');
  const sceneId = p.newScene ? `scene-${p.turnId}` : undefined,
    npcId = p.newNpc ? `support-${p.turnId}` : undefined;
  let next = structuredClone(state);
  const events: GameResult['events'] = [];
  if (p.newScene) {
    const scene = p.newScene;
    if (!constraints.allowNewScenes) return error(state, 'FORBIDDEN');
    if (!context.remainingScenes || next.maps[actor.mapId].exits.length >= 32)
      return error(state, 'RATE_LIMITED');
    if (
      scene.connection.fromMapId !== actor.mapId ||
      !context.availableConnections.some(
        (c) => c.x === scene.connection.x && c.y === scene.connection.y,
      )
    )
      return error(state, 'PATH_BLOCKED');
    if (
      next.maps[sceneId!] ||
      Object.values(state.maps).some(
        (map) => normalize(map.label ?? map.id) === normalize(scene.name),
      )
    )
      return error(state, 'INVALID_ACTION');
    const blocked: { x: number; y: number }[] = [];
    if (scene.template === 'room')
      for (let y = 0; y < BATTLEMAP_CELLS; y++)
        for (let x = 0; x < BATTLEMAP_CELLS; x++)
          if (x === 0 || y === 0 || x === BATTLEMAP_CELLS - 1 || y === BATTLEMAP_CELLS - 1)
            blocked.push({ x, y });
    next.maps[sceneId!] = {
      id: sceneId!,
      label: scene.name,
      width: BATTLEMAP_CELLS,
      height: BATTLEMAP_CELLS,
      blocked,
      spawns: [{ x: 2, y: 3 }],
      exits: [
        {
          id: `back-${p.turnId}`,
          x: 1,
          y: 3,
          label: next.maps[actor.mapId].label,
          destinationMapId: actor.mapId,
          destination: { x: scene.connection.x, y: scene.connection.y },
        },
      ],
      revision: 0,
    };
    next.maps[actor.mapId].exits.push({
      id: `link-${p.turnId}`,
      x: scene.connection.x,
      y: scene.connection.y,
      label: scene.name,
      destinationMapId: sceneId!,
      destination: { x: 2, y: 3 },
    });
    next.maps[actor.mapId].revision++;
    events.push({ kind: 'narrative.scene_created', mapId: sceneId });
  }
  if (p.newNpc) {
    const n = p.newNpc;
    if (!constraints.allowNewNpcs) return error(state, 'FORBIDDEN');
    if (!context.remainingNpcs) return error(state, 'RATE_LIMITED');
    const reserved = Object.values(state.entities).flatMap((e) => [
      e.id,
      e.label ?? '',
      ...Object.values(e.labelTranslations ?? {}),
    ]);
    if (
      /[\p{Cc}\p{Cf}<>]/u.test(n.name) ||
      reserved.some((v) => normalize(v) === normalize(n.name)) ||
      constraints.forbiddenRoles.some((v) => normalize(v) === normalize(n.roleLabel)) ||
      new Set(n.values).size !== n.values.length
    )
      return error(state, 'FORBIDDEN');
    const mapId = n.placement === 'new_scene' ? sceneId : actor.mapId;
    if (!mapId) return error(state, 'INVALID_ACTION');
    const map = next.maps[mapId];
    const proposedFootprint = { ...n.spawn, kind: 'npc', tokenSize: n.tokenSize };
    if (
      !walkable(next, mapId, n.spawn, undefined, true) ||
      map.exits.some((e) => footprintOverlaps(proposedFootprint, e)) ||
      map.spawns.some((e) => footprintOverlaps(proposedFootprint, e)) ||
      Object.values(next.entities).some(
        (e) => e.mapId === mapId && !e.ownerId && footprintOverlaps(proposedFootprint, e),
      ) ||
      (n.placement === 'current' &&
        !context.availableConnections.some((c) => c.x === n.spawn.x && c.y === n.spawn.y))
    )
      return error(state, 'PATH_BLOCKED');
    if (!findPath(next, mapId, n.placement === 'new_scene' ? { x: 2, y: 3 } : actor, n.spawn))
      return error(state, 'PATH_BLOCKED');
    const npc: GameEntity = {
      id: npcId!,
      kind: 'npc',
      label: n.name,
      tokenSize: n.tokenSize ?? 'medium',
      visual: 'traveler',
      mapId,
      ...n.spawn,
      revision: 0,
      inventory: [],
      movementGeneration: 0,
      lastInputSeq: 0,
      supportingNpc: {
        generated: true,
        roleId: 'director-secondary',
        roleLabel: n.roleLabel,
        description: n.description,
        appearance: n.appearance,
        personalitySummary: n.personalitySummary,
      },
    };
    if (
      new Set(n.knownEntityIds).size !== n.knownEntityIds.length ||
      n.knownEntityIds.some(
        (id) =>
          !context.visibleEntities.some((e) => e.id === id) ||
          !next.entities[id] ||
          !visible(next, npc, next.entities[id]),
      )
    )
      return error(state, 'FORBIDDEN');
    next.entities[npcId!] = npc;
    if (!walkable(next, mapId, npc, npc.id, true)) return error(state, 'PATH_BLOCKED');
    next.npcBrains ??= {};
    next.npcBrains[npcId!] = {
      living: createLivingMemory({
        role: n.goal === 'help' ? 'helper' : 'patrol',
        values: n.values,
        taboos: ['steal', 'harm', 'disclose_private'],
        speechStyle: 'Use only perceived facts; character flavor is not factual authority.',
        publicSpeechStyle: n.publicSpeechStyle,
      }),
      traits: ['cautious', 'helpful'],
      goal: n.goal,
      patrolTarget: { ...n.spawn },
      facts: [],
      plan: [],
      cursor: 0,
      nextDecisionTick: next.tick + 20,
      generation: 0,
    };
    events.push({ kind: 'narrative.npc_created', actorId: npcId, mapId });
  }
  for (const action of p.actions) {
    const r = applyAction(next, actorId, action);
    if (r.error) return error(state, r.error);
    next = r.state;
    events.push(...r.events);
  }
  next.narrativeCanon ??= { revision: 0, turns: [] };
  next.narrativeCanon.revision++;
  next.narrativeCanon.turns.push({
    id: p.turnId,
    actorId,
    requestHash,
    tick: state.tick,
    narration: p.narration,
    evidenceIds: [...p.evidenceIds],
    ...(sceneId
      ? {
          sceneId,
          introducedScene: {
            id: sceneId,
            name: p.newScene!.name,
            description: p.newScene!.description,
          },
        }
      : {}),
    ...(npcId
      ? {
          npcId,
          introducedNpc: { id: npcId, name: p.newNpc!.name, roleLabel: p.newNpc!.roleLabel },
        }
      : {}),
  });
  next.revision++;
  const perceived = refreshLivingPerception(next);
  return {
    state: perceived.state,
    events: [...events, { kind: 'narrative.turn_committed', actorId }, ...perceived.events],
  };
}
export function createMockNarrativeProposal(
  state: GameState,
  actorId: string,
  text: string,
  turnId: string,
  replyLocale: Locale = 'en',
): NarrativeProposal | null {
  const c = buildNarrativeContext(state, actorId, text, replyLocale);
  if (!c.currentScene || !c.availableConnections.length || !c.remainingTurns) return null;
  const next = (state.narrativeCanon?.revision ?? 0) + 1,
    extend = c.constraints.allowNewScenes && c.remainingScenes > 0;
  const copy = {
    en: {
      name: 'Mira',
      annex: 'Maintenance annex',
      room: 'Investigation room',
      currentScene: 'the current scene',
      scene: (label: string) =>
        `A reachable extension of ${label}, following the shared investigation.`,
      discovery: (label: string) =>
        `A passage to ${label} is discovered as the investigation continues.`,
      pause: 'The group pauses to consider the confirmed clues.',
      role: 'Maintenance witness',
      description: 'A secondary worker encountered during this investigation.',
      appearance: 'Practical clothes and a notebook.',
      personality: 'Curious and patient; does not know events they have not perceived.',
    },
    uk: {
      name: 'Міра',
      annex: 'Службова прибудова',
      room: 'Кімната розслідування',
      currentScene: 'поточної локації',
      scene: (label: string) =>
        `Доступне продовження локації «${label}», пов’язане зі спільним розслідуванням.`,
      discovery: (label: string) => `Розслідування триває: відкрито прохід до локації «${label}».`,
      pause: 'Група зупиняється, щоб обміркувати підтверджені зачіпки.',
      role: 'Свідок із технічної служби',
      description: 'Другорядний працівник, якого зустріли під час цього розслідування.',
      appearance: 'Практичний одяг і записник.',
      personality: 'Допитлива й терпляча людина; не знає подій, яких не спостерігала.',
    },
    ru: {
      name: 'Мира',
      annex: 'Служебная пристройка',
      room: 'Комната расследования',
      currentScene: 'текущей локации',
      scene: (label: string) =>
        `Доступное продолжение локации «${label}», связанное с общим расследованием.`,
      discovery: (label: string) =>
        `Расследование продолжается: найден проход в локацию «${label}».`,
      pause: 'Группа останавливается, чтобы обдумать подтверждённые зацепки.',
      role: 'Свидетель из технической службы',
      description: 'Второстепенный работник, встреченный во время этого расследования.',
      appearance: 'Практичная одежда и блокнот.',
      personality: 'Любознательный и терпеливый человек; не знает событий, которых не наблюдал.',
    },
  }[c.replyLocale];
  let name = `${copy.name} ${next}`;
  while (Object.values(state.entities).some((e) => normalize(e.label ?? '') === normalize(name)))
    name += 'a';
  const newScene = extend
    ? {
        name: next === 1 ? copy.annex : `${copy.room} ${next}`,
        description: copy.scene(c.currentScene.label ?? copy.currentScene),
        template: 'room' as const,
        connection: { fromMapId: c.currentScene.id, ...c.availableConnections[0] },
      }
    : null;
  return {
    turnId,
    contextHash: c.contextHash,
    narration: extend ? copy.discovery(newScene!.name) : copy.pause,
    newScene,
    newNpc:
      extend && c.constraints.allowNewNpcs && c.remainingNpcs > 0
        ? {
            name,
            roleLabel: copy.role,
            description: copy.description,
            appearance: copy.appearance,
            personalitySummary: copy.personality,
            values: ['kindness'],
            publicSpeechStyle: 'warm',
            goal: 'help',
            placement: 'new_scene',
            spawn: { x: 4, y: 3 },
            knownEntityIds: [],
          }
        : null,
    actions: [],
    evidenceIds: c.evidenceIds.slice(-1),
  };
}
