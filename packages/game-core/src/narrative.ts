import { enterScene, sharesScene } from './scene-presence';
import { travelLocations } from './location-travel';
import { hasPosition, actorLifeState, isActorConscious } from '@dreamwalk/contracts';
import { observedVisible } from './observation-visibility';
import { spatialContext } from './spatial-context';
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
  type ConfirmedNarrativeTurn,
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
export function narrativeTurnIsPublic(turn: ConfirmedNarrativeTurn): boolean {
  // Any explicit audience restricts access, even for inconsistent legacy data.
  return (
    (turn.channel === undefined || turn.channel === 'public') && turn.audienceIds === undefined
  );
}
export function narrativeTurnVisibleTo(turn: ConfirmedNarrativeTurn, readerId: string): boolean {
  return (
    narrativeTurnIsPublic(turn) ||
    (Array.isArray(turn.audienceIds) && turn.audienceIds.includes(readerId))
  );
}
/** Server-stamped encounter scope. A map image is not a campaign-wide audience. */
export function narrativeSceneAudience(state: GameState, actorId: string): string[] | undefined {
  const actor = state.entities[actorId];
  if (!actor || actor.spatialMode !== 'location_only') return undefined;
  return Object.values(state.entities)
    .filter(
      (entity) =>
        ['player', 'npc'].includes(entity.kind) &&
        (entity.id === actorId || (isActorConscious(entity) && sharesScene(state, actor, entity))),
    )
    .map((entity) => entity.id)
    .sort();
}
function validNarrativeAudience(state: GameState, actorId: string, audienceIds: string[]): boolean {
  return (
    Array.isArray(audienceIds) &&
    audienceIds.length > 0 &&
    audienceIds.includes(actorId) &&
    audienceIds.every(
      (id) =>
        typeof id === 'string' &&
        ['player', 'npc'].includes(state.entities[id]?.kind) &&
        (state.entities[actorId]?.spatialMode !== 'location_only' ||
          id === actorId ||
          sharesScene(state, state.entities[actorId], state.entities[id])),
    )
  );
}
function candidates(state: GameState, actorId: string) {
  const actor = state.entities[actorId],
    map = actor && state.maps[actor.mapId],
    points: { x: number; y: number }[] = [];
  if (!actor || !hasPosition(actor) || actor.kind !== 'player' || actor.encounterId || !map)
    return points;
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
  audienceIds?: string[],
  playerAuthoredRoleplay = false,
) {
  if (audienceIds !== undefined && !validNarrativeAudience(state, actorId, audienceIds))
    throw new Error('FORBIDDEN');
  const actor = state.entities[actorId],
    constraints = policy(state),
    canon = state.narrativeCanon,
    audience =
      audienceIds === undefined
        ? narrativeSceneAudience(state, actorId)
        : [...new Set(audienceIds)].sort(),
    publicTurns = (canon?.turns ?? []).filter(
      (turn) => actor?.spatialMode !== 'location_only' && narrativeTurnIsPublic(turn),
    ),
    accessibleTurns = audience
      ? (canon?.turns ?? []).filter(
          (turn) =>
            (actor?.spatialMode !== 'location_only' && narrativeTurnIsPublic(turn)) ||
            (audience.length > 0 &&
              (audienceIds !== undefined || turn.channel === 'public') &&
              (actor?.spatialMode !== 'location_only' || Array.isArray(turn.audienceIds)) &&
              audience.every((readerId) => narrativeTurnVisibleTo(turn, readerId))),
        )
      : publicTurns;
  const context = {
    ...(spatialContext(state, actorId) ? { spatialContext: spatialContext(state, actorId) } : {}),
    actorId,
    ...(audience
      ? {
          channel: audienceIds !== undefined ? ('whisper' as const) : ('public' as const),
          audienceIds: [...audience],
        }
      : {}),
    replyLocale: localeSchema.parse(replyLocale),
    ...(state.narrativePreferences?.[actorId]
      ? { narrativePreferences: readNarrativePreferences(state, actorId) }
      : {}),
    premise: state.narrativePremise ? structuredClone(state.narrativePremise) : null,
    sourceVersion: state.narrativeSource ? { ...state.narrativeSource } : null,
    intent: text,
    canonRevision: canon?.revision ?? 0,
    constraints: {
      ...(!playerAuthoredRoleplay
        ? {
            maxScenes: constraints.maxScenes,
            maxSupportingNpcs: constraints.maxSupportingNpcs,
            maxTurns: constraints.maxTurns,
          }
        : {}),
      allowNewScenes: playerAuthoredRoleplay || constraints.allowNewScenes,
      allowNewNpcs: playerAuthoredRoleplay || constraints.allowNewNpcs,
      protectedFacts: constraints.protectedFacts,
      forbiddenRoles: constraints.forbiddenRoles,
    },
    ...(playerAuthoredRoleplay
      ? {
          explicitPlayerCreation: true,
          autonomousAuthoring: {
            allowNewScenes: constraints.allowNewScenes,
            allowNewNpcs: constraints.allowNewNpcs,
          },
        }
      : {}),
    currentScene: actor
      ? {
          id: actor.mapId,
          label: state.maps[actor.mapId]?.label,
          description:
            publicTurns.find((turn) => turn.sceneId === actor.mapId)?.introducedScene
              ?.description ?? state.maps[actor.mapId]?.description,
          ...(hasPosition(actor)
            ? {
                actorPosition: { x: actor.x, y: actor.y },
                positionEvidence: 'committed_state' as const,
              }
            : { spatialMode: actor.spatialMode, sceneId: actor.sceneId }),
          descriptionScope: 'whole_location' as const,
          // A named building can include an exterior. Its description is not tile evidence.
          terrainAnalysisAvailable: Boolean(spatialContext(state, actorId)),
        }
      : null,
    availableConnections: candidates(state, actorId),
    existingLocations: travelLocations(state),
    visibleEntities: actor
      ? Object.values(state.entities)
          .filter((e) => e.id === actorId || observedVisible(state, actor, e))
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            label: e.label,
            mapId: e.mapId,
            ...(hasPosition(e)
              ? { x: e.x, y: e.y }
              : { spatialMode: e.spatialMode, sceneId: e.sceneId }),
            revision: e.revision,
            ...(['npc', 'player'].includes(e.kind) ? { lifeState: actorLifeState(e) } : {}),
            ...(e.supportingNpc?.generated ? { publicRole: e.supportingNpc.roleLabel } : {}),
            ...(e.kind === 'door' ? { open: e.open, locked: e.locked } : {}),
          }))
          .sort((a, b) => a.id.localeCompare(b.id))
      : [],
    sharedAudience: audience
      ? audience.map((id) => ({ id }))
      : actor
        ? Object.values(state.entities)
            .filter(
              (e) => e.kind === 'player' && (e.id === actorId || observedVisible(state, actor, e)),
            )
            .map((e) => ({ id: e.id }))
            .sort((a, b) => a.id.localeCompare(b.id))
        : [],
    confirmedTurnsPolicy:
      'These are historical turns, not the status of the current attempt. Preserve past events without treating an earlier failure, pending claim or custody description as a current outcome. Descriptions are established ordinary fiction, not witnessed physical evidence or authority over another player. Only typed effects and current tracked state establish mechanical outcomes. Current state and current admitted effects take precedence; old evidence IDs support historical continuity only.',
    confirmedTurns: accessibleTurns.slice(-16).map((t) => ({
      id: t.id,
      tick: t.tick,
      narration: t.narration,
      ...(t.impact ? { impact: t.impact } : {}),
      ...(t.impacts ? { impacts: t.impacts } : {}),
      ...(t.establishedEvents
        ? {
            establishedEvents: t.establishedEvents
              .filter((event) =>
                (
                  audience ??
                  Object.values(state.entities)
                    .filter((entity) => entity.kind === 'player')
                    .map((entity) => entity.id)
                ).every((id) => event.audienceIds.includes(id)),
              )
              .map(({ description, segmentIndex, eventIndex }) => ({
                description,
                segmentIndex,
                eventIndex,
                authority: 'authored_fiction' as const,
              })),
          }
        : {}),
      introducedScene: t.introducedScene,
      introducedNpc: t.introducedNpc,
      introducedItem: t.introducedItem,
    })),
    ...(!playerAuthoredRoleplay
      ? {
          remainingScenes: Math.max(0, constraints.maxScenes - Object.keys(state.maps).length),
          remainingNpcs: Math.max(
            0,
            constraints.maxSupportingNpcs -
              Object.values(state.entities).filter((entity) => entity.supportingNpc?.generated)
                .length,
          ),
          remainingTurns: Math.max(0, constraints.maxTurns - (canon?.turns.length ?? 0)),
        }
      : {}),
    evidenceIds: accessibleTurns.map((t) => t.id).slice(-16),
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
      audienceIds !== undefined
        ? 'Private story for the server-stamped audience only. Use only canon accessible to every recipient. Current player-authored RP events can establish fictional canon through typed admission; quotations and reported speech remain attributed claims. Do not reveal NPC secrets or use unsupported mechanics. No new scenes or NPCs. Current authored RP may change the fictional situation; keep event provenance and coherent current state.'
        : audience
          ? 'Story for the current server-stamped encounter audience only. Use only shared canon accessible to every recipient. Accept current player-authored RP outcomes through typed admission. Do not reveal private whispers or NPC secrets, or claim unseen participants know these events. New content may extend confirmed canon.'
          : 'Shared campaign story only. Current player-authored RP events can establish fictional canon through typed admission; quotations and reported speech remain attributed claims. Do not use private whispers, NPC secrets or unsupported mechanics. Current authored RP may change the fictional situation; keep event provenance and coherent current state.',
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
  audienceIds?: string[],
  establishedRoleplay = false,
): GameResult {
  const parsed = narrativeProposalSchema.safeParse(input);
  if (!parsed.success) return error(state, 'INVALID_ACTION');
  if (audienceIds !== undefined && !validNarrativeAudience(state, actorId, audienceIds))
    return error(state, 'FORBIDDEN');
  const audience =
    audienceIds === undefined
      ? narrativeSceneAudience(state, actorId)
      : [...new Set(audienceIds)].sort();
  const p = parsed.data,
    requestHash = npcContextFingerprint({
      actorId,
      proposal: p,
      ...(audience
        ? { channel: audienceIds !== undefined ? 'whisper' : 'public', audienceIds: audience }
        : {}),
    });
  const previous = state.narrativeCanon?.turns.find((t) => t.id === p.turnId);
  if (previous)
    return previous.actorId === actorId && previous.requestHash === requestHash
      ? { state, events: [] }
      : error(state, 'INVALID_ACTION');
  const actor = state.entities[actorId];
  if (actor?.kind !== 'player' || state.rulesetVersion !== 'hybrid-v3')
    return error(state, 'FORBIDDEN');
  if (actor.encounterId && !establishedRoleplay) return error(state, 'WRONG_MODE');
  if (typeof intent !== 'string' || !intent.trim() || intent.length > 2000)
    return error(state, 'INVALID_ACTION');
  if (audienceIds !== undefined && (p.newScene || p.newNpc)) return error(state, 'FORBIDDEN');
  const context = buildNarrativeContext(
      state,
      actorId,
      intent,
      replyLocale,
      audienceIds,
      establishedRoleplay,
    ),
    constraints = policy(state);
  if (context.contextHash !== p.contextHash) return error(state, 'STALE_STATE');
  if (!establishedRoleplay && !context.remainingTurns) return error(state, 'RATE_LIMITED');
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
    if (!constraints.allowNewScenes && !establishedRoleplay) return error(state, 'FORBIDDEN');
    if (
      (!establishedRoleplay && !context.remainingScenes) ||
      next.maps[actor.mapId].exits.length >= 32
    )
      return error(state, 'RATE_LIMITED');
    if (
      scene.connection.fromMapId !== actor.mapId ||
      (hasPosition(actor)
        ? scene.connection.spatialMode === 'location_only' ||
          !context.availableConnections.some(
            (c) => c.x === scene.connection.x && c.y === scene.connection.y,
          )
        : scene.connection.spatialMode !== 'location_only')
    )
      return error(state, 'PATH_BLOCKED');
    if (
      next.maps[sceneId!] ||
      Object.values(state.maps).some(
        (map) => normalize(map.label ?? map.id) === normalize(scene.name),
      )
    )
      return error(state, 'INVALID_ACTION');
    if (!hasPosition(actor)) {
      const entrySceneId = `encounter-${p.turnId}`;
      next.maps[sceneId!] = {
        id: sceneId!,
        label: scene.name,
        description: scene.description,
        spatialMode: 'location_only',
        width: BATTLEMAP_CELLS,
        height: BATTLEMAP_CELLS,
        blocked: [],
        spawns: [],
        exits: [],
        revision: 0,
        scenePresence: {
          version: 1,
          entrySceneId,
          scenes: [
            {
              id: entrySceneId,
              participantIds: [],
              evidence: { kind: 'committed_event', reference: p.turnId },
            },
          ],
        },
      };
    } else {
      const blocked: { x: number; y: number }[] = [];
      if (scene.template === 'room')
        for (let y = 0; y < BATTLEMAP_CELLS; y++)
          for (let x = 0; x < BATTLEMAP_CELLS; x++)
            if (x === 0 || y === 0 || x === BATTLEMAP_CELLS - 1 || y === BATTLEMAP_CELLS - 1)
              blocked.push({ x, y });
      next.maps[sceneId!] = {
        id: sceneId!,
        label: scene.name,
        description: scene.description,
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
            destination: { x: scene.connection.x!, y: scene.connection.y! },
          },
        ],
        revision: 0,
      };
      next.maps[actor.mapId].exits.push({
        id: `link-${p.turnId}`,
        x: scene.connection.x!,
        y: scene.connection.y!,
        label: scene.name,
        destinationMapId: sceneId!,
        destination: { x: 2, y: 3 },
      });
      next.maps[actor.mapId].revision++;
    }
    events.push({ kind: 'narrative.scene_created', mapId: sceneId });
  }
  if (p.newNpc) {
    const n = p.newNpc;
    if (!constraints.allowNewNpcs && !establishedRoleplay) return error(state, 'FORBIDDEN');
    if (!establishedRoleplay && !context.remainingNpcs) return error(state, 'RATE_LIMITED');
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
    const locationOnly = map.spatialMode === 'location_only';
    if (locationOnly !== (n.spatialMode === 'location_only')) return error(state, 'FORBIDDEN');
    if (!locationOnly) {
      if (!n.spawn) return error(state, 'INVALID_ACTION');
      const proposedFootprint = { ...n.spawn, kind: 'npc', tokenSize: n.tokenSize };
      if (
        !walkable(next, mapId, n.spawn, undefined, true) ||
        map.exits.some((e) => footprintOverlaps(proposedFootprint, e)) ||
        map.spawns.some((e) => footprintOverlaps(proposedFootprint, e)) ||
        Object.values(next.entities).some(
          (e) => e.mapId === mapId && !e.ownerId && footprintOverlaps(proposedFootprint, e),
        ) ||
        (n.placement === 'current' &&
          !context.availableConnections.some((c) => c.x === n.spawn!.x && c.y === n.spawn!.y))
      )
        return error(state, 'PATH_BLOCKED');
      if (n.placement === 'current' && !hasPosition(actor)) return error(state, 'FORBIDDEN');
      if (
        !findPath(
          next,
          mapId,
          n.placement === 'new_scene' ? { x: 2, y: 3 } : { x: actor.x!, y: actor.y! },
          n.spawn,
        )
      )
        return error(state, 'PATH_BLOCKED');
    }
    const npc: GameEntity = {
      id: npcId!,
      kind: 'npc',
      label: n.name,
      tokenSize: n.tokenSize ?? 'medium',
      visual: 'traveler',
      mapId,
      ...(locationOnly
        ? {
            spatialMode: 'location_only' as const,
            sceneId: n.placement === 'current' ? actor.sceneId! : map.scenePresence!.entrySceneId,
          }
        : { x: n.spawn!.x, y: n.spawn!.y }),
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
    if (locationOnly) {
      next.entities[npcId!] = npc;
      if (!enterScene(next, npc, mapId, npc.sceneId)) return error(state, 'FORBIDDEN');
    }
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
    if (hasPosition(npc) && !walkable(next, mapId, npc, npc.id, true))
      return error(state, 'PATH_BLOCKED');
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
      ...(n.spawn ? { patrolTarget: { ...n.spawn } } : {}),
      facts: [],
      plan: [],
      cursor: 0,
      nextDecisionTick: next.tick + 20,
      generation: 0,
    };
    events.push({ kind: 'narrative.npc_created', actorId: npcId, mapId });
  }
  for (const action of p.actions) {
    if (action.kind === 'travel') return error(state, 'FORBIDDEN');
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
    ...(audience
      ? {
          channel: audienceIds !== undefined ? ('whisper' as const) : ('public' as const),
          audienceIds: [...audience],
        }
      : {}),
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
  audienceIds?: string[],
  playerAuthoredRoleplay = false,
): NarrativeProposal | null {
  const c = buildNarrativeContext(
    state,
    actorId,
    text,
    replyLocale,
    audienceIds,
    playerAuthoredRoleplay,
  );
  if (!c.currentScene || (!playerAuthoredRoleplay && !c.remainingTurns)) return null;
  if (!hasPosition(state.entities[actorId]) || !c.availableConnections.length)
    return {
      turnId,
      contextHash: c.contextHash,
      narration: text.replace(/\*/gu, '').trim(),
      newScene: null,
      newNpc: null,
      actions: [],
      evidenceIds: c.evidenceIds.slice(-1),
    };
  const next = (state.narrativeCanon?.revision ?? 0) + 1,
    extend =
      !audienceIds &&
      c.constraints.allowNewScenes &&
      (playerAuthoredRoleplay || !!c.remainingScenes);
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
      extend && c.constraints.allowNewNpcs && (playerAuthoredRoleplay || !!c.remainingNpcs)
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
