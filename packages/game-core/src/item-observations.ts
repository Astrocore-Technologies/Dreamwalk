import type { GameEvent, GameState, NpcObservation } from '@dreamwalk/contracts';

/** A witnessed acquisition is not evidence of a prior owner or of theft. */
export const isUnestablishedStoryPickup = (observation: NpcObservation) =>
  observation.kind === 'item_taken' && observation.itemOwnershipContext === 'unestablished';

/** Stamp only the first authoritative pickup in the prop's own admitted story turn.
 * Never infer this exception from a name, an ID prefix, or player/model assertions.
 * Existing items and later dropped/reacquired props retain their existing semantics.
 */
export function storyPickupOwnershipContext(
  before: GameState,
  after: GameState,
  event: GameEvent,
  operationId: string,
): 'unestablished' | undefined {
  const item = event.targetId ? before.entities[event.targetId] : undefined;
  if (
    event.kind !== 'action.pick_up' ||
    !event.actorId ||
    item?.kind !== 'item' ||
    item.ownerId ||
    item.revision !== 0 ||
    item.item?.definitionId !== item.id ||
    !item.item.portable ||
    item.item.edible ||
    item.item.restoreVitality !== 0 ||
    item.keyId ||
    after.entities[item.id]?.ownerId !== event.actorId ||
    !after.entities[event.actorId]?.inventory?.includes(item.id)
  )
    return undefined;
  return before.narrativeCanon?.turns.some(
    (turn) =>
      turn.actorId === event.actorId &&
      turn.introducedItem?.id === item.id &&
      operationId.startsWith(`turn:${turn.id}:`),
  )
    ? 'unestablished'
    : undefined;
}
