import { entityPresentationLabels, type PresentationAliases } from './presentation-aliases';
import {
  establishedRoleplayEventSchema,
  hasPosition,
  actorLifeState,
  footprintInside,
  footprintOverlaps,
  footprintIntersectsArea,
  type EstablishedRoleplayEvent,
  type GameState,
  type GameResult,
  type GameEntity,
  type StoryTurnInput,
} from '@dreamwalk/contracts';
import { visible, walkable } from './index';
import { observedVisible } from './observation-visibility';
import { groundedArrivalArea } from './grounded-arrival';
import { entityPlacement, copyEntityPlacement, enterScene } from './scene-presence';
import { npcContextFingerprint } from './living';
import { recordNpcEvents } from './npc';
import { transitionNpcLifeState } from './lifecycle';
import { matchesTurnFence } from './turns';
import { synchronizePendingSpeechEvidence } from './pending-speech';
import { travelLocations } from './location-travel';

const tokens = (text: string) =>
  text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.join(' ') ?? '';
const named = (text: string, labels: string[]) =>
  labels.some((label) => {
    const name = label ? tokens(label) : '';
    return name.length > 1 && ` ${tokens(text)} `.includes(` ${name} `);
  });
/** Public scene references plus only the player's named carried objects. No keys,
 * private stock, unseen identities, other inventories, or executable patches. */
export function establishedRoleplayContext(
  state: GameState,
  actorId: string,
  text: string,
  aliases?: PresentationAliases,
) {
  const actor = state.entities[actorId];
  const entities = Object.values(state.entities).filter(
    (entity) =>
      actor &&
      (entity.id === actorId ||
        (!entity.ownerId && observedVisible(state, actor, entity)) ||
        (entity.ownerId === actorId &&
          actor.inventory?.includes(entity.id) &&
          named(text, entityPresentationLabels(state, actorId, entity, aliases)))),
  );
  const map = actor && state.maps[actor.mapId];
  return {
    entities: entities.map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      label: entity.label,
      revision: entity.revision,
      ...entityPlacement(entity),
      mapId: entity.mapId,
      ...(entity.ownerId === actorId ? { carriedByActor: true } : {}),
      ...(entity.kind === 'door' ? { open: !!entity.open, locked: !!entity.locked } : {}),
      ...(entity.publicCondition ? { publicCondition: entity.publicCondition } : {}),
      ...(['player', 'npc'].includes(entity.kind)
        ? {
            lifeState: actorLifeState(entity),
            vitality: entity.vitality,
            maxVitality: entity.maxVitality,
          }
        : {}),
    })),
    destinations: travelLocations(state),
    surfaces:
      map?.composition?.layers
        .filter((layer) => ['table', 'counter', 'shelf'].includes(layer.visual))
        .filter(
          (layer) =>
            hasPosition(actor) &&
            visible(state, actor, {
              id: 'surface',
              kind: 'item',
              mapId: actor.mapId,
              x: layer.x,
              y: layer.y,
              revision: 0,
            }),
        )
        .map(({ id, visual, x, y, width, height }) => ({ id, visual, x, y, width, height })) ?? [],
    geometryHash: npcContextFingerprint({
      maps: Object.values(state.maps).map(
        ({
          id,
          revision,
          width,
          height,
          blocked,
          composition,
          spatialGrounding,
          locationImage,
          spawns,
          scenePresence,
        }) => ({
          id,
          revision,
          width,
          height,
          blocked,
          composition,
          spatialGrounding,
          locationImage,
          spawns,
          scenePresence,
        }),
      ),
      positions: Object.values(state.entities).map(
        ({ id, mapId, x, y, spatialMode, sceneId, ownerId, open, tokenSize }) => ({
          id,
          mapId,
          x,
          y,
          spatialMode,
          sceneId,
          ownerId,
          open,
          tokenSize,
        }),
      ),
      bindings: state.artBindings,
    }),
  };
}

function imageSafe(
  state: GameState,
  entity: GameEntity,
  mapId: string,
  point: { x: number; y: number },
) {
  const map = state.maps[mapId];
  if (!map || map.spatialMode === 'location_only') return false;
  const binding = state.artBindings?.find((entry) => entry.slot === `map:${mapId}:background`);
  if ((binding || map.locationImage) && !map.spatialGrounding) return false;
  if (
    map.locationImage &&
    (!binding ||
      binding.revisionId !== map.locationImage.revisionId ||
      binding.sha256 !== map.locationImage.sha256)
  )
    return false;
  const admission = groundedArrivalArea(state, mapId);
  return admission.valid && admission.allows(entity, point);
}

/** One ordered event is atomic. Its parent commits all events together with prose.
 * Fictional difficulty and action/inventory capacity are not authorization gates. */
export function applyEstablishedRoleplayEvent(
  state: GameState,
  actorId: string,
  turnId: string,
  segmentIndex: number,
  eventIndex: number,
  raw: EstablishedRoleplayEvent,
  input: StoryTurnInput,
  audienceIds: string[],
  allowedIds: string[],
  allowedMapIds: string[],
): GameResult {
  const reject = (error: GameResult['error'] = 'FORBIDDEN'): GameResult => ({
    state,
    events: [],
    error,
  });
  const parsed = establishedRoleplayEventSchema.safeParse(raw);
  const actor = state.entities[actorId],
    turn = state.narrativeCanon?.turns.find((entry) => entry.id === turnId);
  if (!parsed.success || actor?.kind !== 'player' || !turn || turn.actorId !== actorId)
    return reject();
  const event = parsed.data;
  const requestHash = npcContextFingerprint({
    actorId,
    segmentIndex,
    eventIndex,
    event,
    audienceIds,
  });
  const previous = turn.establishedEvents?.find(
    (entry) => entry.segmentIndex === segmentIndex && entry.eventIndex === eventIndex,
  );
  if (previous)
    return previous.requestHash === requestHash ? { state, events: [] } : reject('STALE_STATE');
  const controller = state.turnController;
  if (controller && !controller.actorOrder.includes(actorId)) return reject();
  if (
    controller &&
    (!input.turnFence ||
      !matchesTurnFence(state, input.turnFence) ||
      controller.pendingResolution ||
      controller.phase !== 'world')
  )
    return reject('STALE_STATE');
  if (event.entityIds.some((id) => !allowedIds.includes(id))) return reject();
  const changedIds = event.effects.flatMap((effect) =>
    'targetId' in effect
      ? [effect.targetId]
      : 'itemId' in effect
        ? [effect.itemId, ...('recipientId' in effect ? [effect.recipientId] : [])]
        : [],
  );
  if (event.entityIds.some((id) => !changedIds.includes(id))) return reject();
  let next = structuredClone(state);
  const events: GameResult['events'] = [];
  // An old queued intent by this same author must not replay a just-established result.
  if (actor.encounterId && next.encounters[actor.encounterId])
    delete next.encounters[actor.encounterId].intents[actorId];
  const refs = new Map<string, string>();
  const resolve = (id: string) => refs.get(id) ?? id;
  const accessible = (id: string): GameEntity | undefined => {
    const entity = next.entities[resolve(id)],
      currentActor = next.entities[actorId];
    if (!entity || (!allowedIds.includes(entity.id) && ![...refs.values()].includes(entity.id)))
      return undefined;
    return entity.id === actorId ||
      (entity.ownerId === actorId && currentActor.inventory?.includes(entity.id)) ||
      (!entity.ownerId && observedVisible(next, currentActor, entity))
      ? entity
      : undefined;
  };
  const ownItem = (id: string) => {
    const item = accessible(id);
    return item?.kind === 'item' &&
      item.ownerId === actorId &&
      next.entities[actorId].inventory?.includes(item.id)
      ? item
      : undefined;
  };
  const affectedActor = (id: string, allowInitialParticipant = false) => {
    const initial = state.entities[resolve(id)];
    const target =
      accessible(id) ??
      (allowInitialParticipant &&
      initial?.kind === 'npc' &&
      allowedIds.includes(initial.id) &&
      observedVisible(state, actor, initial)
        ? next.entities[initial.id]
        : undefined);
    return target && (target.id === actorId || target.kind === 'npc') ? target : undefined;
  };
  const removeFromScene = (id: string) => {
    for (const map of Object.values(next.maps))
      for (const scene of map.scenePresence?.scenes ?? [])
        if (scene.participantIds.includes(id)) {
          scene.participantIds = scene.participantIds.filter((value) => value !== id);
          map.revision++;
        }
  };
  const leaveEncounter = (target: GameEntity) => {
    for (const encounter of Object.values(next.encounters)) {
      if (
        !encounter.participants.includes(target.id) &&
        !encounter.pendingJoinIds?.includes(target.id)
      )
        continue;
      encounter.participants = encounter.participants.filter((id) => id !== target.id);
      delete encounter.intents[target.id];
      encounter.pendingJoinIds = encounter.pendingJoinIds?.filter((id) => id !== target.id);
      encounter.endVotes = encounter.endVotes?.filter((id) => id !== target.id);
      if (encounter.coordinatorId === target.id)
        encounter.coordinatorId = encounter.participants.find(
          (id) => next.entities[id]?.kind === 'player',
        );
    }
    delete target.encounterId;
  };
  for (const [index, effect] of event.effects.entries()) {
    const before = structuredClone(next);
    const emitted: GameResult['events'] = [];
    const currentActor = next.entities[actorId];
    const emit = (kind: string, targetId: string, itemId?: string) =>
      emitted.push({
        kind,
        actorId,
        targetId,
        mapId: currentActor.mapId,
        ...(itemId ? { itemId } : {}),
      });
    if (effect.kind === 'create_prop') {
      if (input.channel !== 'say' || refs.has(effect.ref) || allowedIds.includes(effect.ref))
        return reject();
      const id = `rp-${turnId}-${segmentIndex}-${eventIndex}-${index}`;
      if (next.entities[id]) return reject('STALE_STATE');
      next.entities[id] = {
        id,
        kind: 'item',
        label: effect.name,
        publicCondition: effect.description,
        mapId: currentActor.mapId,
        ...entityPlacement(currentActor),
        revision: 1,
        ownerId: actorId,
        item: {
          definitionId: id,
          quantity: 1,
          portable: true,
          edible: false,
          restoreVitality: 0,
          visual: 'object',
        },
      };
      (currentActor.inventory ??= []).push(id);
      currentActor.revision++;
      refs.set(effect.ref, id);
      emit('action.pick_up', id);
    } else if (effect.kind === 'door_state') {
      const target = accessible(effect.targetId);
      if (target?.kind !== 'door' || (effect.open && effect.locked)) return reject();
      if (
        !effect.open &&
        Object.values(next.entities).some(
          (entity) =>
            ['npc', 'player'].includes(entity.kind) &&
            entity.mapId === target.mapId &&
            hasPosition(entity) &&
            hasPosition(target) &&
            footprintOverlaps(entity, target),
        )
      )
        return reject('PATH_BLOCKED');
      const oldOpen = !!target.open,
        oldLocked = !!target.locked;
      target.open = effect.open;
      target.locked = effect.locked;
      target.revision++;
      next.maps[target.mapId].revision++;
      if (oldLocked !== target.locked)
        emit(target.locked ? 'action.lock' : 'action.unlock', target.id);
      if (oldOpen !== target.open) emit(target.open ? 'action.open' : 'action.close', target.id);
    } else if (effect.kind === 'item_custody') {
      const item = accessible(effect.itemId),
        recipient = accessible(effect.recipientId);
      if (
        item?.kind !== 'item' ||
        !recipient ||
        !['player', 'npc'].includes(recipient.kind) ||
        (item.ownerId && item.ownerId !== actorId) ||
        (item.ownerId === actorId && !currentActor.inventory?.includes(item.id))
      )
        return reject();
      if (!item.ownerId && recipient.id !== actorId) return reject();
      if (item.ownerId === recipient.id) continue;
      const giving = item.ownerId === actorId;
      currentActor.inventory = currentActor.inventory?.filter((id) => id !== item.id);
      removeFromScene(item.id);
      item.ownerId = recipient.id;
      (recipient.inventory ??= []).push(item.id);
      copyEntityPlacement(item, recipient);
      if (item.item) {
        delete item.item.surfaceId;
        delete item.item.surfaceSlot;
      }
      item.revision++;
      currentActor.revision++;
      recipient.revision++;
      emit(
        giving ? 'action.give' : 'action.pick_up',
        giving ? recipient.id : item.id,
        giving ? item.id : undefined,
      );
    } else if (effect.kind === 'item_placement') {
      const item = ownItem(effect.itemId),
        map = next.maps[currentActor.mapId];
      if (
        !item ||
        !hasPosition(currentActor) ||
        !map ||
        !imageSafe(next, item, map.id, effect.point)
      )
        return reject();
      // A verified floor raster does not prove a tabletop, shelf, or counter.
      // Until surfaces have image-bound evidence, only non-image authored surfaces qualify.
      if (
        effect.surfaceId &&
        (map.locationImage ||
          next.artBindings?.some((entry) => entry.slot === `map:${map.id}:background`))
      )
        return reject();
      const layer = effect.surfaceId
        ? map.composition?.layers.find(
            (entry) =>
              entry.id === effect.surfaceId && ['table', 'counter', 'shelf'].includes(entry.visual),
          )
        : undefined;
      if (
        effect.surfaceId &&
        (!layer ||
          !visible(next, currentActor, {
            id: 'surface',
            kind: 'item',
            mapId: map.id,
            ...effect.point,
            revision: 0,
          }) ||
          !footprintInside({ ...item, ...effect.point, spatialMode: undefined }, layer))
      )
        return reject();
      if (!effect.surfaceId && !walkable(next, map.id, effect.point, item.id, true))
        return reject('PATH_BLOCKED');
      if (
        Object.values(next.encounters).some(
          (encounter) =>
            encounter.phase === 'planning' &&
            encounter.mapId === map.id &&
            footprintIntersectsArea(
              { ...item, ...effect.point, spatialMode: undefined },
              encounter.area,
            ),
        )
      )
        return reject();
      currentActor.inventory = currentActor.inventory!.filter((id) => id !== item.id);
      delete item.ownerId;
      delete item.spatialMode;
      delete item.sceneId;
      Object.assign(item, effect.point, { mapId: map.id });
      // Older saves carry ordinary items without the later world-item metadata.
      // A named surface must remain state, not disappear into placement prose.
      if (effect.surfaceId && !item.item)
        item.item = {
          definitionId: item.id,
          quantity: 1,
          portable: true,
          edible: false,
          restoreVitality: 0,
          visual: 'object',
        };
      if (item.item) {
        delete item.item.surfaceSlot;
        if (effect.surfaceId) item.item.surfaceId = effect.surfaceId;
        else delete item.item.surfaceId;
      }
      item.revision++;
      currentActor.revision++;
      emit('item.placed', item.id);
    } else if (effect.kind === 'item_consumed') {
      const item = ownItem(effect.itemId);
      if (!item) return reject();
      if (item.item && item.item.quantity > 1) {
        item.item.quantity--;
        item.revision++;
      } else {
        currentActor.inventory = currentActor.inventory!.filter((id) => id !== item.id);
        delete next.entities[item.id];
      }
      currentActor.revision++;
      emit('item.consumed', item.id);
    } else if (effect.kind === 'public_condition') {
      const target = accessible(effect.targetId);
      if (input.channel !== 'say' || !target || (target.kind === 'player' && target.id !== actorId))
        return reject();
      target.publicCondition = effect.description;
      target.revision++;
      emit('roleplay.condition', target.id);
    } else if (effect.kind === 'actor_state') {
      const target = affectedActor(effect.targetId);
      if (
        !target ||
        (effect.lifeState === 'conscious' && effect.vitality === 0) ||
        (effect.lifeState === 'dead' && effect.vitality !== 0)
      )
        return reject();
      const old = actorLifeState(target),
        oldVitality = target.vitality ?? target.maxVitality ?? 6;
      target.vitality = effect.vitality;
      target.maxVitality = Math.max(target.maxVitality ?? 6, effect.vitality);
      if (target.kind === 'npc') transitionNpcLifeState(next, target.id, effect.lifeState);
      else {
        target.lifeState = effect.lifeState;
        if (effect.lifeState !== 'conscious') {
          leaveEncounter(target);
          if (next.turnController)
            next.turnController.deferredSpeech = next.turnController.deferredSpeech.filter(
              (speech) => speech.actorId !== target.id && speech.recipientId !== target.id,
            );
          synchronizePendingSpeechEvidence(next);
        }
        target.lifeRevision = (target.lifeRevision ?? 0) + 1;
        delete target.path;
        delete target.movementTrace;
        target.movementGeneration = (target.movementGeneration ?? 0) + 1;
      }
      target.revision++;
      if (effect.vitality < oldVitality) emit('action.hit', target.id);
      if (old !== effect.lifeState)
        emit(
          effect.lifeState === 'dead'
            ? 'actor.died'
            : effect.lifeState === 'unconscious'
              ? 'actor.lost_consciousness'
              : old === 'dead'
                ? 'actor.revived'
                : 'actor.regained_consciousness',
          target.id,
        );
    } else if (effect.kind === 'relocate') {
      const target = affectedActor(effect.targetId, true),
        map = next.maps[effect.mapId];
      if (!target || !map || !allowedMapIds.includes(map.id)) return reject();
      leaveEncounter(target);
      if (map.spatialMode === 'location_only') {
        if (
          effect.point ||
          !enterScene(
            next,
            target,
            map.id,
            map.id === currentActor.mapId && currentActor.spatialMode === 'location_only'
              ? currentActor.sceneId
              : undefined,
          )
        )
          return reject();
      } else {
        if (
          !effect.point ||
          !imageSafe(next, target, map.id, effect.point) ||
          !walkable(next, map.id, effect.point, target.id, true) ||
          Object.values(next.encounters).some(
            (encounter) =>
              encounter.phase === 'planning' &&
              encounter.mapId === map.id &&
              footprintIntersectsArea(
                { ...target, ...effect.point, spatialMode: undefined },
                encounter.area,
              ),
          )
        )
          return reject('PATH_BLOCKED');
        removeFromScene(target.id);
        delete target.spatialMode;
        delete target.sceneId;
        Object.assign(target, effect.point, { mapId: map.id });
      }
      delete target.path;
      delete target.movementTrace;
      target.movementGeneration = (target.movementGeneration ?? 0) + 1;
      target.revision++;
      for (const itemId of target.inventory ?? [])
        if (next.entities[itemId]) copyEntityPlacement(next.entities[itemId], target);
      emitted.push({ kind: 'actor.transitioned', actorId: target.id, mapId: map.id });
    }
    next.revision++;
    next = recordNpcEvents(
      before,
      next,
      emitted,
      `established:${turnId}:${segmentIndex}:${eventIndex}:${index}`,
    ).state;
    events.push(...emitted);
  }
  const receipt = {
    ...event,
    // Local author/model aliases are not durable object identity or personal data.
    // Resolve them before persistence, while requestHash still binds the original proposal.
    effects: event.effects.map((effect) =>
      Object.fromEntries(
        Object.entries(effect).map(([key, value]) =>
          ['ref', 'targetId', 'itemId', 'recipientId'].includes(key) && typeof value === 'string'
            ? [key, resolve(value)]
            : [key, value],
        ),
      ),
    ) as EstablishedRoleplayEvent['effects'],
    id: `rp-${turnId}-${segmentIndex}-${eventIndex}`,
    segmentIndex,
    eventIndex,
    actorId,
    audienceIds: [...audienceIds],
    requestHash,
    authority: 'authored_fiction' as const,
  };
  (next.narrativeCanon!.turns.find((entry) => entry.id === turnId)!.establishedEvents ??= []).push(
    receipt,
  );
  // Descriptive prose is established fiction, never witnessed physical evidence.
  // Only recordNpcEvents above emits typed, perceived mechanical observations.
  next.revision++;
  events.push({
    kind: 'narrative.event_established',
    actorId,
    mapId: next.entities[actorId].mapId,
  });
  return { state: next, events };
}
