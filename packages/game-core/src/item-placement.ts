import {
  adjacentFootprintAnchors,
  footprintDistance,
  footprintInside,
  footprintIntersectsArea,
  footprintOverlaps,
  gamePointSchema,
  hasPosition,
  isActorConscious,
  occupiedCells,
  worldItemRulesSchema,
  type GameEntity,
  type GameError,
  type GamePoint,
  type GameResult,
  type GameState,
} from '@dreamwalk/contracts';
import { groundedArrivalArea } from './grounded-arrival';

const fail = (state: GameState, error: GameError): GameResult => ({ state, events: [], error });

/** Held coordinates may lag their owner after travel; identity and inventory are authoritative. */
function dropContext(state: GameState, actorId: string, itemId: string) {
  const actor = state.entities[actorId],
    item = state.entities[itemId];
  if (actor?.kind !== 'player' || !isActorConscious(actor)) return { error: 'FORBIDDEN' as const };
  if (
    item?.kind !== 'item' ||
    item.ownerId !== actorId ||
    actor.inventory?.filter((id) => id === itemId).length !== 1 ||
    item.item?.portable === false
  )
    return { error: 'FORBIDDEN' as const };
  const map = state.maps[actor.mapId];
  if (!hasPosition(actor) || !map || map.spatialMode === 'location_only' || actor.encounterId)
    return { error: 'WRONG_MODE' as const };
  if (
    !gamePointSchema.safeParse({ x: actor.x, y: actor.y }).success ||
    !footprintInside(actor, { x: 0, y: 0, width: map.width, height: map.height })
  )
    return { error: 'WRONG_MODE' as const };
  const turn = state.turnController;
  if (turn) {
    if (
      turn.phase !== 'player' ||
      turn.activeActorId !== actorId ||
      !turn.actorOrder.includes(actorId)
    )
      return { error: 'WRONG_MODE' as const };
    if (turn.pendingResolution || turn.reaction) return { error: 'ROUND_LOCKED' as const };
  }
  const encounters = Object.values(state.encounters).filter(
    (encounter) => encounter.phase === 'planning' && encounter.mapId === actor.mapId,
  );
  if (encounters.some((encounter) => footprintIntersectsArea(actor, encounter.area)))
    return { error: 'WRONG_MODE' as const };
  // Authored non-image maps retain their collision geometry. Image-backed maps
  // must never silently fall back to that geometry when evidence is absent/stale.
  const binding = state.artBindings?.find((b) => b.slot === `map:${map.id}:background`),
    admission = groundedArrivalArea(state, map.id),
    rules = worldItemRulesSchema.safeParse(state.worldItemRules ?? { version: 1 });
  if (
    (binding && !map.spatialGrounding) ||
    !admission.valid ||
    (map.locationImage &&
      (!binding ||
        binding.revisionId !== map.locationImage.revisionId ||
        binding.sha256 !== map.locationImage.sha256))
  )
    return { error: 'TARGET_UNAVAILABLE' as const };
  if (!rules.success) return { error: 'INVALID_ACTION' as const };
  return { actor, item, map, encounters, admission, capacity: rules.data.surfaceCapacity };
}

type DropContext = Extract<ReturnType<typeof dropContext>, { actor: GameEntity }>;

/** Reserve implicit slots for legacy items too, without inventing item definitions. */
function availableSlot(state: GameState, placed: GameEntity, capacity: number) {
  const neighbors = Object.values(state.entities)
    .filter(
      (entity) =>
        entity.id !== placed.id &&
        entity.kind === 'item' &&
        !entity.ownerId &&
        entity.mapId === placed.mapId &&
        footprintOverlaps(entity, placed),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  if (neighbors.length >= capacity) return undefined;
  const occupied = new Set<number>();
  let implicit = 0;
  for (const entity of neighbors) {
    const slot = entity.item?.surfaceSlot;
    if (
      slot !== undefined &&
      Number.isInteger(slot) &&
      slot >= 0 &&
      slot < capacity &&
      !occupied.has(slot)
    )
      occupied.add(slot);
    else implicit++;
  }
  const slots = Array.from({ length: capacity }, (_, index) => index);
  for (let index = 0; index < implicit; index++)
    occupied.add(slots.find((slot) => !occupied.has(slot))!);
  return slots.find((slot) => !occupied.has(slot));
}

function placement(state: GameState, context: DropContext, target: GamePoint) {
  const { actor, item, map, encounters, admission, capacity } = context,
    placed: GameEntity = {
      ...item,
      ...target,
      mapId: actor.mapId,
      spatialMode: undefined,
      sceneId: undefined,
      ownerId: undefined,
    };
  if (footprintDistance(actor, placed) !== 1) return { error: 'OUT_OF_RANGE' as const };
  if (encounters.some((encounter) => footprintIntersectsArea(placed, encounter.area)))
    return { error: 'WRONG_MODE' as const };
  if (
    !footprintInside(placed, { x: 0, y: 0, width: map.width, height: map.height }) ||
    occupiedCells(placed).some((cell) =>
      map.blocked.some((b) => b.x === cell.x && b.y === cell.y),
    ) ||
    !admission.allows(placed, target) ||
    Object.values(state.entities).some(
      (entity) =>
        !entity.ownerId &&
        entity.mapId === map.id &&
        ((entity.kind === 'door' && !entity.open) ||
          entity.kind === 'player' ||
          entity.kind === 'npc') &&
        footprintOverlaps(entity, placed),
    )
  )
    return { error: 'PATH_BLOCKED' as const };
  const slot = availableSlot(state, placed, capacity);
  return slot === undefined ? { error: 'PATH_BLOCKED' as const } : { slot };
}

/** Deterministic, server-validated ground choices around the owner's whole footprint. */
export function itemDropCandidates(state: GameState, actorId: string, itemId: string): GamePoint[] {
  const context = dropContext(state, actorId, itemId);
  if (context.error) return [];
  const item = { ...context.item, x: context.actor.x, y: context.actor.y, spatialMode: undefined };
  return adjacentFootprintAnchors(item, context.actor).filter(
    (point) => gamePointSchema.safeParse(point).success && !placement(state, context, point).error,
  );
}

/** Atomic unbudgeted mechanic. The existing turn reducer charges the additional action. */
export function dropOwnedItem(
  state: GameState,
  actorId: string,
  itemId: string,
  target: GamePoint,
): GameResult {
  const parsed = gamePointSchema.safeParse(target);
  if (!parsed.success) return fail(state, 'INVALID_ACTION');
  const context = dropContext(state, actorId, itemId);
  if (context.error) return fail(state, context.error);
  const candidate = placement(state, context, parsed.data);
  if (candidate.error) return fail(state, candidate.error);
  const next = structuredClone(state),
    actor = next.entities[actorId],
    item = next.entities[itemId];
  actor.inventory = actor.inventory!.filter((id) => id !== itemId);
  delete item.ownerId;
  delete item.spatialMode;
  delete item.sceneId;
  delete item.path;
  delete item.movementTrace;
  Object.assign(item, parsed.data, { mapId: actor.mapId });
  if (item.item) {
    delete item.item.surfaceId;
    delete item.item.surfaceSlot;
    item.item.surfaceSlot = candidate.slot;
  }
  actor.revision++;
  item.revision++;
  next.revision++;
  return {
    state: next,
    events: [{ kind: 'item.placed', actorId, targetId: itemId, mapId: actor.mapId }],
  };
}
