import {
  isActorConscious,
  type GameEvent,
  type GameState,
  type NpcObservation,
} from '@dreamwalk/contracts';
import { observedVisible } from './observation-visibility';

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

/** A typed committed handoff is perceived at the actors' contact, not the stale
 * coordinates of a carried item. Never reconstruct past transfers from custody alone. */
export function witnessedItemTransfer(
  before: GameState,
  after: GameState,
  event: GameEvent,
  observerId: string,
  eventId: string,
): NpcObservation | undefined {
  if (!['action.give', 'item.given'].includes(event.kind) || !event.actorId) return undefined;
  const itemId = event.kind === 'action.give' ? event.itemId : event.targetId;
  const item = itemId ? after.entities[itemId] : undefined;
  const previous = itemId ? before.entities[itemId] : undefined;
  const giver = before.entities[event.actorId];
  const recipientId = event.kind === 'action.give' ? event.targetId : item?.ownerId;
  const recipient = recipientId ? before.entities[recipientId] : undefined;
  if (
    !giver ||
    !recipient ||
    giver.id === recipient.id ||
    item?.kind !== 'item' ||
    item.ownerId !== recipient.id ||
    !after.entities[recipient.id]?.inventory?.includes(item.id) ||
    after.entities[giver.id]?.inventory?.includes(item.id) ||
    (previous
      ? previous.kind !== 'item' ||
        previous.ownerId !== giver.id ||
        !giver.inventory?.includes(item.id) ||
        item.revision <= previous.revision
      : event.kind !== 'item.given')
  )
    return undefined;
  const participants = [giver.id, recipient.id];
  const witnesses = Object.values(before.entities).filter((observer) => {
    if (!['player', 'npc'].includes(observer.kind) || !isActorConscious(observer)) return false;
    if (participants.includes(observer.id)) return true;
    const memory = before.npcBrains?.[observer.id]?.living;
    if (
      memory &&
      (memory.distractedUntilTick > before.tick || (memory.affect?.attention ?? 100) < 60)
    )
      return false;
    return observedVisible(before, observer, giver) && observedVisible(before, observer, recipient);
  });
  if (!witnesses.some((observer) => observer.id === observerId)) return undefined;
  const observer = before.entities[observerId];
  const knowsGiver = observerId === giver.id || observedVisible(before, observer, giver);
  const knowsRecipient =
    observerId === recipient.id || observedVisible(before, observer, recipient);
  return {
    id: `${observerId}:${eventId}:transfer`,
    eventId,
    rootId: eventId,
    kind: 'item_given',
    tick: after.tick,
    mapId: observer.mapId,
    channel: 'direct',
    confidence: 'witnessed',
    depth: 0,
    disclosure: 'participants',
    // Participation establishes contact, not necessarily recognition through an
    // opaque corner. A richer snapshot cannot reveal identities to a less-informed listener.
    audienceIds: witnesses
      .filter(
        (witness) =>
          (!knowsGiver || witness.id === giver.id || observedVisible(before, witness, giver)) &&
          (!knowsRecipient ||
            witness.id === recipient.id ||
            observedVisible(before, witness, recipient)),
      )
      .map((entity) => entity.id)
      .sort(),
    ...(knowsGiver ? { actorId: giver.id } : {}),
    targetId: item.id,
    itemTransfer: {
      itemId: item.id,
      ...(item.label ? { label: item.label } : {}),
      revision: item.revision,
      ...(knowsRecipient ? { recipientId: recipient.id } : {}),
    },
  };
}
