import {
  type GameEntity,
  type GameMap,
  type GameState,
  scenePresenceSchema,
} from '@dreamwalk/contracts';

/** Canonically admitted encounter membership, not a guess about a location's distances. */
export function sharesScene(
  state: GameState,
  a: GameEntity | undefined,
  b: GameEntity | undefined,
): boolean {
  if (
    !a ||
    !b ||
    a.spatialMode !== 'location_only' ||
    b.spatialMode !== 'location_only' ||
    a.mapId !== b.mapId ||
    a.sceneId !== b.sceneId ||
    a.ownerId ||
    b.ownerId
  )
    return false;
  const map = state.maps[a.mapId];
  if (map?.spatialMode !== 'location_only') return false;
  const scene = map.scenePresence?.scenes.find((s) => s.id === a.sceneId);
  return !!scene && scene.participantIds.includes(a.id) && scene.participantIds.includes(b.id);
}

export function scenePresenceErrors(state: GameState, map: GameMap): string[] {
  if (map.spatialMode !== 'location_only') return [];
  const errors: string[] = [];
  if (
    !scenePresenceSchema.safeParse(map.scenePresence).success ||
    map.spawns.length ||
    map.blocked.length ||
    map.exits.length ||
    map.spatialGrounding ||
    map.composition
  )
    return [`map:${map.id}:scene-presence`];
  for (const scene of map.scenePresence!.scenes)
    for (const id of scene.participantIds) {
      const e = state.entities[id];
      if (
        !e ||
        e.mapId !== map.id ||
        e.spatialMode !== 'location_only' ||
        e.sceneId !== scene.id ||
        e.ownerId
      )
        errors.push(`entity:${id}:scene-membership`);
    }
  for (const e of Object.values(state.entities).filter((e) => e.mapId === map.id)) {
    if (
      e.spatialMode !== 'location_only' ||
      e.x !== undefined ||
      e.y !== undefined ||
      e.path?.length ||
      e.movementTrace ||
      e.encounterId
    )
      errors.push(`entity:${e.id}:invented-position`);
    if (
      !e.ownerId &&
      !map.scenePresence!.scenes.some((s) => s.id === e.sceneId && s.participantIds.includes(e.id))
    )
      errors.push(`entity:${e.id}:missing-scene-presence`);
  }
  return errors;
}

/** Mutating helper used only inside the existing writer/reducer transaction. */
export function enterScene(
  state: GameState,
  entity: GameEntity,
  mapId: string,
  sceneId?: string,
): boolean {
  const map = state.maps[mapId];
  if (map?.spatialMode !== 'location_only' || !map.scenePresence) return false;
  const destination = map.scenePresence.scenes.find(
    (s) => s.id === (sceneId ?? map.scenePresence!.entrySceneId),
  );
  if (!destination) return false;
  for (const oldMap of Object.values(state.maps))
    for (const scene of oldMap.scenePresence?.scenes ?? []) {
      if (scene.participantIds.includes(entity.id)) {
        scene.participantIds = scene.participantIds.filter((id) => id !== entity.id);
        oldMap.revision++;
      }
    }
  // Delete spatial fields instead of preserving invisible placeholder geometry.
  const record = entity as unknown as Record<string, unknown>;
  for (const key of ['x', 'y', 'path', 'movementTrace', 'feedback', 'lastMoveTick', 'encounterId'])
    delete record[key];
  Object.assign(entity, { spatialMode: 'location_only', sceneId: destination.id, mapId });
  if (!entity.ownerId) {
    destination.participantIds.push(entity.id);
    map.revision++;
  }
  for (const id of entity.inventory ?? []) {
    const item = state.entities[id];
    if (!item) continue;
    copyEntityPlacement(item, entity);
  }
  return true;
}

export function publicSceneMap(state: GameState, viewer: GameEntity): GameMap {
  const map = structuredClone(state.maps[viewer.mapId]);
  if (map.spatialMode !== 'location_only' || !map.scenePresence) return map;
  // Authored other scenes and their identities are not public just because the image is shared.
  map.scenePresence.scenes = map.scenePresence.scenes
    .filter((s) => s.id === viewer.sceneId)
    .map((s) => ({
      ...s,
      participantIds: s.participantIds.filter((id) =>
        sharesScene(state, viewer, state.entities[id]),
      ),
      evidence: { kind: 'committed_event', reference: 'current_public_scene' },
    }));
  map.scenePresence.entrySceneId = viewer.sceneId!;
  return map;
}

/** Copy only committed placement; inventory follows its carrier without becoming perceived. */
export function entityPlacement(
  entity: GameEntity,
):
  | { spatialMode: 'location_only'; sceneId: string; x?: never; y?: never }
  | { x: number; y: number; spatialMode?: undefined; sceneId?: undefined } {
  return entity.spatialMode === 'location_only'
    ? { spatialMode: 'location_only', sceneId: entity.sceneId }
    : { x: entity.x, y: entity.y };
}
export function copyEntityPlacement(item: GameEntity, owner: GameEntity) {
  if (
    item.mapId !== owner.mapId ||
    item.sceneId !== owner.sceneId ||
    item.x !== owner.x ||
    item.y !== owner.y
  )
    item.revision++;
  const record = item as unknown as Record<string, unknown>;
  for (const key of ['spatialMode', 'sceneId', 'x', 'y', 'path', 'movementTrace'])
    delete record[key];
  Object.assign(item, { mapId: owner.mapId, ...entityPlacement(owner) });
}
