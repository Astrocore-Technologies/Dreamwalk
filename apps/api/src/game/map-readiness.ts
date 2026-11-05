import { hasPosition, type GameState, type PlayablePackage } from '@dreamwalk/contracts';

type SpatialWorld = Pick<GameState | PlayablePackage, 'maps' | 'entities' | 'artBindings'>;

/** A grid is playable state, not an image decoration. Legacy incomplete saves stay readable.
 * This checks geometry presence only: it never infers terrain, moves actors or changes RP rules. */
export function requiresMapRecovery(world: SpatialWorld): boolean {
  const maps = Object.values(world.maps ?? {});
  if (!maps.length) return true;
  const inBounds = (map: (typeof maps)[number], point: { x: number; y: number }) =>
    Number.isInteger(point.x) &&
    Number.isInteger(point.y) &&
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < map.width &&
    point.y < map.height;
  if (
    maps.some(
      (map) =>
        map.spatialMode === 'location_only' ||
        !!(
          map.spatialGrounding &&
          world.artBindings?.some(
            (b) =>
              b.slot === `map:${map.id}:background` &&
              (b.revisionId !== map.spatialGrounding!.imageRevisionId ||
                b.sha256 !== map.spatialGrounding!.imageSha256),
          )
        ) ||
        !Number.isInteger(map.width) ||
        !Number.isInteger(map.height) ||
        map.width <= 0 ||
        map.height <= 0 ||
        !map.spawns?.length ||
        map.spawns.some((point) => !inBounds(map, point)),
    )
  )
    return true;
  return Object.values(world.entities ?? {}).some((entity) => {
    if (entity.kind !== 'player' && entity.kind !== 'npc') return false;
    const map = world.maps[entity.mapId];
    return !map || !hasPosition(entity) || !inBounds(map, entity);
  });
}

/** Used before accepting a new paid result or admitting any new campaign. */
export function assertPlayableGrid(world: SpatialWorld): void {
  if (requiresMapRecovery(world)) throw Error('MAP_GRID_REQUIRED');
}
