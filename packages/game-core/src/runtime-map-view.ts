import { sharesScene } from './scene-presence';
import { hasPosition } from '@dreamwalk/contracts';
import { actorLifeState, type ActorLifeState } from '@dreamwalk/contracts';
import {
  occupiedCells,
  type GameEntity,
  type GamePoint,
  type GameState,
} from '@dreamwalk/contracts';
import { observedVisible } from './observation-visibility';

export interface RuntimeMapMarker {
  /** One-based numeric label, stable for the same visible set regardless of movement/order. */
  marker: number;
  id: string;
  kind: GameEntity['kind'];
  label?: string;
  lifeState?: ActorLifeState;
  x: number;
  y: number;
  occupiedCells: GamePoint[];
}

/** A public, current-map-only observation. Never an action/collision authority. */
export interface RuntimeMapView {
  version: 1;
  spatialMode?: 'location_only';
  sceneId?: string;
  mapId: string;
  width: number;
  height: number;
  mapRevision: number;
  /** Internal audience fence. Do not disclose unseen observer identities in provider prose. */
  observerIds: string[];
  visibleCells: GamePoint[];
  markers: RuntimeMapMarker[];
}

const pointKey = ({ x, y }: GamePoint) => `${x},${y}`;
const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Intersect, never union, all observers' perceptions for shared narration/speech.
 * Reads only committed runtime state. No draft, brain, memory, inventory or other-map
 * content enters the result. Hidden parts of a footprint are not inferred from its anchor.
 */
export function runtimeMapView(state: GameState, observerIds: string[]): RuntimeMapView {
  const ids = [...new Set(observerIds)].sort(compareIds);
  if (!ids.length || ids.length > 256) throw new Error('RUNTIME_MAP_OBSERVERS_REQUIRED');
  const observers = ids.map((id) => state.entities[id]);
  if (observers.some((actor) => !actor || !['player', 'npc'].includes(actor.kind) || actor.ownerId))
    throw new Error('RUNTIME_MAP_OBSERVER_UNAVAILABLE');
  const map = state.maps[observers[0].mapId];
  if (!map || observers.some((actor) => actor.mapId !== map.id))
    throw new Error('RUNTIME_MAP_OBSERVERS_DIFFERENT_MAPS');
  if (map.spatialMode === 'location_only') {
    const sceneId = observers[0].sceneId;
    if (!sceneId || observers.some((actor) => !sharesScene(state, observers[0], actor)))
      throw new Error('RUNTIME_MAP_OBSERVERS_DIFFERENT_SCENES');
    return {
      version: 1,
      spatialMode: 'location_only',
      sceneId,
      mapId: map.id,
      width: map.width,
      height: map.height,
      mapRevision: map.revision,
      observerIds: ids,
      visibleCells: [],
      markers: [],
    };
  }
  if (
    !Number.isSafeInteger(map.width) ||
    !Number.isSafeInteger(map.height) ||
    map.width < 1 ||
    map.height < 1 ||
    map.width > 64 ||
    map.height > 64
  )
    throw new Error('RUNTIME_MAP_INVALID_GEOMETRY');
  const visibleCells: GamePoint[] = [];
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++) {
      const cell: GameEntity = {
        id: 'runtime-map-cell',
        kind: 'item',
        revision: 0,
        mapId: map.id,
        x,
        y,
      };
      if (observers.every((actor) => observedVisible(state, actor, cell)))
        visibleCells.push({ x, y });
    }
  const perceived = new Set(visibleCells.map(pointKey));
  const markers = Object.values(state.entities)
    .filter(hasPosition)
    .filter(
      (entity) =>
        entity.mapId === map.id &&
        !entity.ownerId &&
        observers.every((actor) => observedVisible(state, actor, entity)) &&
        occupiedCells(entity).every((cell) => perceived.has(pointKey(cell))),
    )
    .sort((a, b) => compareIds(a.id, b.id))
    .map((entity, index): RuntimeMapMarker => ({
      marker: index + 1,
      id: entity.id,
      kind: entity.kind,
      ...(['npc', 'player'].includes(entity.kind) && actorLifeState(entity) !== 'conscious'
        ? { lifeState: actorLifeState(entity) }
        : {}),
      ...(entity.label ? { label: entity.label } : {}),
      x: entity.x,
      y: entity.y,
      occupiedCells: occupiedCells(entity),
    }));
  return {
    version: 1,
    mapId: map.id,
    width: map.width,
    height: map.height,
    mapRevision: map.revision,
    observerIds: ids,
    visibleCells,
    markers,
  };
}
