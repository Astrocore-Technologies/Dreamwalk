import {
  authoredGameDraftSchema,
  bundledGameAssetManifest,
  type AuthoredGameDraft,
  type GameState,
  type PlayablePackage,
} from '@dreamwalk/contracts';
import { createLivingMemory, refreshLivingPerception } from './living';
import { addPlayer, createObservatoryState, findPath, validateMapState, walkable } from './index';
export function createAuthoredDraft(
  template: 'observatory' | 'courtyard' = 'observatory',
): AuthoredGameDraft {
  const state = createObservatoryState();
  const maps = Object.values(state.maps).map(({ revision: _revision, ...m }) => ({
    ...m,
    label: m.id === 'roof' ? 'Rooftop' : 'Observatory',
  }));
  if (template === 'courtyard') {
    maps[0] = {
      id: 'courtyard',
      label: 'Courtyard',
      width: 12,
      height: 10,
      blocked: [],
      spawns: [
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 2, y: 3 },
        { x: 3, y: 3 },
      ],
      exits: [
        { id: 'garden-exit', x: 10, y: 5, destinationMapId: 'garden', destination: { x: 2, y: 2 } },
      ],
    };
    maps[1] = {
      id: 'garden',
      label: 'Garden',
      width: 10,
      height: 8,
      blocked: [
        { x: 5, y: 3 },
        { x: 5, y: 4 },
      ],
      spawns: [{ x: 2, y: 2 }],
      exits: [
        {
          id: 'courtyard-exit',
          x: 1,
          y: 2,
          destinationMapId: 'courtyard',
          destination: { x: 9, y: 5 },
        },
      ],
    };
  }
  const mapId = maps[0].id;
  return {
    schemaVersion: 1,
    title: template === 'observatory' ? 'The Observatory' : 'The Courtyard',
    startMapId: mapId,
    maps,
    objects: [
      { id: 'key', kind: 'item', label: 'Brass key', mapId, x: 5, y: 6, visual: 'key' },
      {
        id: 'door',
        kind: 'door',
        label: 'Old door',
        mapId,
        x: template === 'observatory' ? 10 : 8,
        y: 5,
        visual: 'door',
        locked: true,
        open: false,
        keyId: 'key',
      },
      {
        id: 'token',
        kind: 'item',
        label: 'Keeper token',
        mapId,
        x: 6,
        y: 4,
        visual: 'token',
        ownerNpcId: 'keeper',
      },
    ],
    npcs: [
      {
        id: 'keeper',
        label: 'Keeper',
        mapId,
        x: 6,
        y: 4,
        visual: 'keeper',
        goal: 'help',
        patrolTarget: { x: 7, y: 4 },
      },
    ],
    roundPolicy: { maxRounds: 5, planningMs: 30000 },
  };
}
export function compilePlayableDraft(input: unknown): {
  playable?: PlayablePackage;
  errors: string[];
} {
  const parsed = authoredGameDraftSchema.safeParse(input);
  if (!parsed.success)
    return {
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 32),
    };
  const d = parsed.data,
    errors: string[] = [];
  const maps: PlayablePackage['maps'] = {},
    entities: PlayablePackage['entities'] = {},
    npcBrains: PlayablePackage['npcBrains'] = {};
  for (const m of d.maps) {
    if (maps[m.id]) errors.push(`map:${m.id}:duplicate`);
    const { sourceLocationId: _sourceLocationId, ...publicMap } = m;
    maps[m.id] = { ...structuredClone(publicMap), revision: 0 };
  }
  if (!maps[d.startMapId]) errors.push('startMapId:missing');
  const ids = new Set<string>();
  for (const o of [...d.objects, ...d.npcs]) {
    if (ids.has(o.id)) errors.push(`entity:${o.id}:duplicate`);
    if (o.id.startsWith('player-')) errors.push(`entity:${o.id}:reserved-player-prefix`);
    ids.add(o.id);
  }
  for (const m of Object.values(maps))
    for (const e of m.exits) e.label = maps[e.destinationMapId]?.label;
  for (const o of d.objects) {
    if (
      o.kind === 'item' &&
      (o.locked !== undefined ||
        o.open !== undefined ||
        o.keyId !== undefined ||
        o.visual === 'door')
    )
      errors.push(`entity:${o.id}:item-fields`);
    if (o.kind === 'door' && (o.ownerNpcId || o.visual !== 'door' || (o.locked && o.open)))
      errors.push(`entity:${o.id}:door-fields`);
    entities[o.id] = {
      id: o.id,
      kind: o.kind,
      label: o.label,
      visual: o.visual,
      mapId: o.mapId,
      x: o.x,
      y: o.y,
      revision: 0,
      ...(o.kind === 'door'
        ? { locked: o.locked ?? false, open: o.open ?? false, keyId: o.keyId }
        : { ownerId: o.ownerNpcId }),
    };
  }
  for (const n of d.npcs) {
    entities[n.id] = {
      id: n.id,
      kind: 'npc',
      label: n.label,
      visual: n.visual,
      mapId: n.mapId,
      x: n.x,
      y: n.y,
      revision: 0,
      inventory: [],
      movementGeneration: 0,
      lastInputSeq: 0,
    };
    npcBrains[n.id] = {
      ...(d.npcBehavior === 'reactive-v1'
        ? {
            living: createLivingMemory(
              n.personality ?? {
                role: n.goal === 'help' ? 'helper' : 'guard',
                values: n.goal === 'help' ? ['kindness'] : ['duty'],
                taboos: ['steal', 'disclose_private'],
                speechStyle: 'reserved',
              },
            ),
          }
        : {}),
      traits: ['cautious', 'helpful'],
      goal: n.goal,
      patrolTarget: n.patrolTarget ?? { x: n.x, y: n.y },
      facts: [],
      plan: [],
      cursor: 0,
      nextDecisionTick: 0,
      generation: 0,
    };
  }
  for (const e of Object.values(entities))
    if (e.ownerId) {
      const owner = entities[e.ownerId];
      if (owner?.kind !== 'npc') errors.push(`entity:${e.id}:owner`);
      else owner.inventory!.push(e.id);
    }
  for (const e of Object.values(entities))
    if (
      e.kind === 'door' &&
      ((e.locked && !e.keyId) || (e.keyId && entities[e.keyId]?.kind !== 'item'))
    )
      errors.push(`entity:${e.id}:key`);
  if (d.npcBehavior === 'reactive-v1')
    for (const n of d.npcs) {
      const memory = npcBrains[n.id].living!;
      memory.goalDefinitions = structuredClone(n.initialGoals ?? []);
      memory.promiseTemplates = structuredClone(n.promiseTemplates ?? []);
      const validConditions = (conditions: NonNullable<typeof n.initialGoals>[number]['when']) =>
        conditions.every((c) =>
          c.kind === 'near_entity'
            ? !!entities[c.entityId]
            : c.kind === 'owns_item'
              ? entities[c.itemId]?.kind === 'item'
              : c.kind === 'observed' && c.targetId
                ? !!entities[c.targetId]
                : true,
        );
      const goalIds = new Set<string>();
      for (const goal of n.initialGoals ?? []) {
        if (goalIds.has(goal.id)) errors.push(`npc:${n.id}:goal-duplicate`);
        goalIds.add(goal.id);
        if (
          (goal.kind !== 'patrol' && !goal.targetId) ||
          (goal.targetId && !entities[goal.targetId])
        )
          errors.push(`npc:${n.id}:goal-target`);
        if (goal.kind === 'guard' && entities[goal.targetId ?? '']?.kind !== 'door')
          errors.push(`npc:${n.id}:goal-door`);
        if (
          goal.kind === 'assist' &&
          (!goal.itemId ||
            entities[goal.itemId]?.ownerId !== n.id ||
            entities[goal.targetId ?? '']?.kind !== 'npc')
        )
          errors.push(`npc:${n.id}:goal-owned-item`);
        if (!validConditions([...goal.when, ...goal.success, ...goal.cancelWhen]))
          errors.push(`npc:${n.id}:goal-condition`);
      }
      for (const goal of n.initialGoals ?? []) {
        const visited = new Set<string>();
        let current: typeof goal | undefined = goal;
        while (current?.fallbackGoalId) {
          if (visited.has(current.id) || !goalIds.has(current.fallbackGoalId)) {
            errors.push(`npc:${n.id}:goal-fallback`);
            break;
          }
          visited.add(current.id);
          current = n.initialGoals?.find((g) => g.id === current!.fallbackGoalId);
        }
      }
      const promises = new Set<string>();
      for (const t of n.promiseTemplates ?? []) {
        if (
          promises.has(t.id) ||
          (t.itemId
            ? entities[t.itemId]?.ownerId !== n.id
            : !t.promisedAction ||
              !entities[t.promisedAction.targetId] ||
              (t.promisedAction.kind === 'open' &&
                entities[t.promisedAction.targetId]?.kind !== 'door')) ||
          !validConditions(t.conditions) ||
          (t.alternativeGoalId && !goalIds.has(t.alternativeGoalId))
        )
          errors.push(`npc:${n.id}:promise-template`);
        promises.add(t.id);
      }
      const facts = new Set<string>();
      for (const fact of n.initialFacts ?? []) {
        if (facts.has(fact.id) || (fact.topicEntityId && !entities[fact.topicEntityId]))
          errors.push(`npc:${n.id}:fact-reference`);
        facts.add(fact.id);
        const evidenceId = `initial:${n.id}:fact:${fact.id}`;
        memory.observations.push({
          id: evidenceId,
          eventId: evidenceId,
          rootId: evidenceId,
          kind: 'authored_fact',
          tick: 0,
          mapId: entities[n.id].mapId,
          channel: 'direct',
          confidence: 'witnessed',
          targetId: fact.topicEntityId,
          factId: fact.id,
          title: fact.title,
          definitionText: fact.text,
          publicQuestion: fact.publicQuestion,
          depth: 0,
          disclosure: fact.disclosure === 'public' ? 'public' : 'private',
          audienceIds: [],
          ...(fact.disclosure === 'public' ? {} : { revealCondition: fact.disclosure }),
        });
      }

      const linked = new Set<string>();
      for (const link of n.personality?.links ?? []) {
        if (link.npcId === n.id || entities[link.npcId]?.kind !== 'npc' || linked.has(link.npcId))
          errors.push(`npc:${n.id}:personality-link`);
        linked.add(link.npcId);
        if (entities[link.npcId]?.kind === 'npc' && link.npcId !== n.id) {
          const evidenceId = `initial-link:${n.id}:${link.npcId}`;
          memory.observations.push({
            id: evidenceId,
            eventId: evidenceId,
            rootId: evidenceId,
            kind: 'known_entity',
            tick: 0,
            mapId: entities[n.id].mapId,
            channel: 'direct',
            confidence: 'witnessed',
            actorId: link.npcId,
            targetId: link.npcId,
            depth: 0,
            disclosure: 'private',
            audienceIds: [],
            revealCondition: 'never',
          });
          memory.relationships[link.npcId] = {
            trust: link.relation === 'rival' ? -1 : link.relation === 'mentor' ? 2 : 1,
            alertness: link.relation === 'rival' ? 1 : 0,
            debt: link.relation === 'mentor' ? 1 : 0,
            evidenceIds: [evidenceId],
          };
        }
      }
      for (const [i, k] of (n.initialKnowledge ?? []).entries()) {
        const entity = entities[k.entityId];
        if (!entity) {
          errors.push(`npc:${n.id}:knowledge-target`);
          continue;
        }
        memory.observations.push({
          id: `initial:${n.id}:${i}`,
          eventId: `initial:${n.id}:${i}`,
          rootId: `initial:${n.id}:${i}`,
          kind: 'known_entity',
          tick: 0,
          mapId: entity.mapId,
          point: { x: entity.x, y: entity.y },
          channel: 'direct',
          confidence: 'witnessed',
          targetId: entity.id,
          depth: 0,
          disclosure: 'private',
          audienceIds: [],
          revealCondition: k.revealCondition,
        });
      }
    }
  const playable: PlayablePackage = {
    assetManifest: { ...bundledGameAssetManifest },
    schemaVersion: 1,
    rulesetVersion: d.npcBehavior === 'reactive-v1' ? 'hybrid-v3' : 'hybrid-v2',
    title: d.title,
    startMapId: d.startMapId,
    maps,
    entities,
    npcBrains,
    roundPolicy: { ...d.roundPolicy },
  };
  const state = createStateFromPlayable(playable, [], 1);
  errors.push(...validateMapState(state));
  for (const m of Object.values(maps)) {
    for (const p of m.blocked)
      if (p.x >= m.width || p.y >= m.height) errors.push(`map:${m.id}:blocked-bounds`);
    if (new Set(m.exits.map((e) => e.id)).size !== m.exits.length)
      errors.push(`map:${m.id}:duplicate-exit`);
    for (const e of m.exits) {
      if (!walkable(state, m.id, e)) errors.push(`exit:${e.id}:blocked`);
      if (e.doorId && (entities[e.doorId]?.kind !== 'door' || entities[e.doorId].mapId !== m.id))
        errors.push(`exit:${e.id}:door`);
    }
  }
  const solid = new Set<string>();
  for (const e of Object.values(entities)) {
    if (e.ownerId) continue;
    const map = maps[e.mapId];
    if (!map) continue;
    if (map.blocked.some((p) => p.x === e.x && p.y === e.y)) errors.push(`entity:${e.id}:wall`);
    if (e.kind !== 'item') {
      const cell = `${e.mapId}:${e.x}:${e.y}`;
      if (solid.has(cell)) errors.push(`entity:${e.id}:overlap`);
      solid.add(cell);
    }
    if (e.kind === 'npc' && !findPath(state, e.mapId, e, npcBrains[e.id].patrolTarget, e.id))
      errors.push(`npc:${e.id}:patrol-path`);
  }
  // Discover map entrances and keys together: an unreachable second map cannot donate a key.
  const open = structuredClone(state);
  for (const e of Object.values(open.entities)) if (e.kind === 'door' && !e.locked) e.open = true;
  const entrances = new Map<string, { x: number; y: number }[]>();
  if (maps[d.startMapId]) entrances.set(d.startMapId, [...maps[d.startMapId].spawns]);
  const keys = new Set<string>();
  let changed = true;
  for (let iteration = 0; changed && iteration < 128; iteration++) {
    changed = false;
    const reachable = (mapId: string, p: { x: number; y: number }) =>
      (entrances.get(mapId) ?? []).some((sp) => findPath(open, mapId, sp, p) !== null);
    for (const item of Object.values(open.entities).filter((e) => e.kind === 'item')) {
      const place = item.ownerId ? open.entities[item.ownerId] : item;
      if (place && reachable(place.mapId, place) && !keys.has(item.id)) {
        keys.add(item.id);
        changed = true;
      }
    }
    for (const door of Object.values(open.entities).filter((e) => e.kind === 'door' && e.locked)) {
      if (
        door.keyId &&
        keys.has(door.keyId) &&
        [
          { x: door.x - 1, y: door.y },
          { x: door.x + 1, y: door.y },
          { x: door.x, y: door.y - 1 },
          { x: door.x, y: door.y + 1 },
        ].some((p) => reachable(door.mapId, p))
      ) {
        door.locked = false;
        door.open = true;
        changed = true;
      }
    }
    for (const m of Object.values(maps))
      for (const exit of m.exits) {
        if (!reachable(m.id, exit) || (exit.doorId && !open.entities[exit.doorId]?.open)) continue;
        if (!maps[exit.destinationMapId]) continue;
        const points = entrances.get(exit.destinationMapId) ?? [];
        if (!points.some((p) => p.x === exit.destination.x && p.y === exit.destination.y)) {
          points.push(exit.destination);
          entrances.set(exit.destinationMapId, points);
          changed = true;
        }
      }
  }
  for (const id of Object.keys(maps)) if (!entrances.has(id)) errors.push(`map:${id}:unreachable`);
  for (const door of Object.values(open.entities).filter((e) => e.kind === 'door' && e.locked))
    errors.push(`entity:${door.id}:unreachable-key`);
  for (const m of Object.values(maps))
    for (const exit of m.exits)
      if (!(entrances.get(m.id) ?? []).some((sp) => findPath(open, m.id, sp, exit) !== null))
        errors.push(`exit:${exit.id}:unreachable`);

  return errors.length ? { errors: [...new Set(errors)].slice(0, 32) } : { playable, errors: [] };
}
export function createStateFromPlayable(
  playable: PlayablePackage,
  actorIds: string[] = [],
  seed = 1,
): GameState {
  let state: GameState = {
    assetManifest: { ...playable.assetManifest },
    ...(playable.artBindings ? { artBindings: structuredClone(playable.artBindings) } : {}),
    schemaVersion: 1,
    rulesetVersion: playable.rulesetVersion,
    seed,
    tick: 0,
    revision: 0,
    startMapId: playable.startMapId,
    maps: structuredClone(playable.maps),
    entities: structuredClone(playable.entities),
    encounters: {},
    npcBrains: structuredClone(playable.npcBrains),
    roundPolicy: { ...playable.roundPolicy },
  };
  for (const id of actorIds) {
    if (state.entities[id]) throw new Error('ACTOR_ID_COLLISION');
    const added = addPlayer(state, id);
    if (added.error) throw new Error(added.error);
    state = added.state;
  }
  return state.rulesetVersion === 'hybrid-v3' ? refreshLivingPerception(state).state : state;
}
