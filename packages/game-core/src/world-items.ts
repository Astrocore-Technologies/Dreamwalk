import {
  npcItemIntentsSchema,
  worldItemRulesSchema,
  type GameState,
  type GameEntity,
  type GameResult,
  type GameEvent,
  type NpcItemIntent,
} from '@dreamwalk/contracts';
import { npcActionAllowed } from './living-policy';
import { visible, walkable } from './index';
const fail = (state: GameState, error: GameResult['error']): GameResult => ({
  state,
  events: [],
  error,
});
const rules = (s: GameState) => worldItemRulesSchema.parse(s.worldItemRules ?? { version: 1 });
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
function surface(
  s: GameState,
  npc: GameEntity,
  input: { surfaceId?: string; x: number; y: number },
) {
  const map = s.maps[npc.mapId];
  if (!map) return false;
  if (input.surfaceId) {
    const layer = map.composition?.layers.find(
      (l) => l.id === input.surfaceId && ['table', 'counter', 'shelf'].includes(l.visual),
    );
    if (
      !layer ||
      input.x < layer.x ||
      input.y < layer.y ||
      input.x >= layer.x + layer.width ||
      input.y >= layer.y + layer.height
    )
      return false;
  } else if (!walkable(s, npc.mapId, input, npc.id)) return false;
  return (
    distance(npc, input) <= 1 &&
    input.x > 0 &&
    input.y > 0 &&
    input.x < map.width - 1 &&
    input.y < map.height - 1 &&
    Object.values(s.entities).filter(
      (e) =>
        e.kind === 'item' &&
        !e.ownerId &&
        e.mapId === npc.mapId &&
        e.x === input.x &&
        e.y === input.y,
    ).length < rules(s).surfaceCapacity
  );
}
/** Only the NPC's approved private stock is an item-creation capability. */
export function npcItemContext(s: GameState, npcId: string) {
  const npc = s.entities[npcId];
  if (npc?.kind !== 'npc') return {};
  if (s.npcBrains?.[npcId]?.living?.personality.taboos.includes('give_valuables'))
    return {
      itemProvisioning: {
        stock: [],
        placements: [],
        ownedItems: [],
        rules: 'This NPC has no permitted provisioning capability.',
      },
    };
  const stock = (npc.itemStock ?? [])
    .filter((x) => x.quantity > 0)
    .flatMap((x) => {
      const definition = s.worldItemDefinitions?.find((d) => d.id === x.definitionId);
      return definition ? [{ ...definition, quantity: x.quantity }] : [];
    });
  const placements: { x: number; y: number; surfaceId?: string }[] = [];
  for (let y = npc.y - 1; y <= npc.y + 1; y++)
    for (let x = npc.x - 1; x <= npc.x + 1; x++) {
      const layer = s.maps[npc.mapId]?.composition?.layers.find(
        (l) =>
          ['table', 'counter', 'shelf'].includes(l.visual) &&
          x >= l.x &&
          y >= l.y &&
          x < l.x + l.width &&
          y < l.y + l.height,
      );
      const p = { x, y, ...(layer ? { surfaceId: layer.id } : {}) };
      if (surface(s, npc, p)) placements.push(p);
    }
  return {
    itemProvisioning: {
      stock,
      placements,
      inventoryCapacity: rules(s).inventoryCapacity,
      ownedItems: (npc.inventory ?? []).flatMap((id) => {
        const e = s.entities[id];
        return e?.item ? [{ id, label: e.label, item: e.item }] : [];
      }),
      rules:
        'Use only these stock definitions, owned item IDs and placement candidates. Items are created/transferred only after server acceptance.',
    },
  };
}
export function materializeNpcItems(
  state: GameState,
  npcId: string,
  recipientId: string,
  input: unknown,
  causeId: string,
): GameResult {
  const parsed = npcItemIntentsSchema.safeParse(input);
  if (!parsed.success) return fail(state, 'INVALID_ACTION');
  if (!parsed.data.length) return { state, events: [] };
  const turn = state.turnController,
    npc = state.entities[npcId];
  if (!turn || turn.phase !== 'world' || turn.pendingResolution || npc?.kind !== 'npc')
    return fail(state, 'WRONG_MODE');
  if (
    turn.worldActions + 1 > turn.ruleset.maxWorldActions ||
    (turn.worldNpcActions[npcId] ?? 0) + 1 > turn.ruleset.maxNpcActions
  )
    return fail(state, 'ROUND_LOCKED');
  if (state.npcBrains?.[npcId]?.living?.personality.taboos.includes('give_valuables'))
    return fail(state, 'FORBIDDEN');
  const s = structuredClone(state),
    events: GameEvent[] = [],
    actor = s.entities[npcId];
  for (const [index, intent] of parsed.data.entries()) {
    const giving = intent.kind === 'give_stock' || intent.kind === 'give_existing';
    const recipient = giving ? s.entities[intent.recipientId] : undefined;
    if (
      giving &&
      (!recipient ||
        recipient.id !== recipientId ||
        !['player', 'npc'].includes(recipient.kind) ||
        recipient.mapId !== actor.mapId ||
        distance(actor, recipient) > 1 ||
        (recipient.inventory?.length ?? 0) >= rules(s).inventoryCapacity)
    )
      return fail(state, 'FORBIDDEN');
    if (!giving && !surface(s, actor, intent)) return fail(state, 'OUT_OF_RANGE');
    let item: GameEntity;
    if (intent.kind === 'place_stock' || intent.kind === 'give_stock') {
      const definition = s.worldItemDefinitions?.find((d) => d.id === intent.definitionId),
        stock = actor.itemStock?.find((x) => x.definitionId === intent.definitionId);
      if (!definition || !stock || stock.quantity < 1) return fail(state, 'FORBIDDEN');
      if (
        Object.keys(s.entities).length >= 128 ||
        Object.values(s.entities).filter((e) => e.kind === 'item').length >= rules(s).maxWorldItems
      )
        return fail(state, 'RATE_LIMITED');
      const id = ('item-' + causeId + '-' + index).replace(/[^A-Za-z0-9_-]/g, '_');
      if (id.length > 80 || s.entities[id]) return fail(state, 'STALE_STATE');
      item = {
        id,
        kind: 'item',
        label: definition.label,
        publicProfile: { role: 'object', description: definition.description, appearance: '' },
        mapId: actor.mapId,
        x: actor.x,
        y: actor.y,
        revision: 0,
        item: {
          definitionId: definition.id,
          quantity: 1,
          portable: definition.portable,
          edible: definition.edible,
          restoreVitality: definition.restoreVitality,
          visual: definition.visual,
        },
      };
      s.entities[id] = item;
      stock.quantity--;
    } else {
      const existing = s.entities[intent.itemId];
      if (
        existing?.kind !== 'item' ||
        existing.ownerId !== npcId ||
        !actor.inventory?.includes(existing.id) ||
        !existing.item
      )
        return fail(state, 'FORBIDDEN');
      if (
        !giving &&
        s.npcBrains?.[npcId]?.living?.obligations.some(
          (o) => o.itemId === existing.id && ['proposed', 'accepted'].includes(o.status),
        )
      )
        return fail(state, 'FORBIDDEN');
      item = existing;
      actor.inventory = actor.inventory.filter((id) => id !== item.id);
    }
    if (giving) {
      if (!npcActionAllowed(s, npcId, { kind: 'give', targetId: recipient!.id, itemId: item.id }))
        return fail(state, 'FORBIDDEN');
      if (!item.item?.portable) return fail(state, 'FORBIDDEN');
      item.ownerId = recipient!.id;
      delete item.item.surfaceId;
      delete item.item.surfaceSlot;
      item.mapId = recipient!.mapId;
      item.x = recipient!.x;
      item.y = recipient!.y;
      (recipient!.inventory ??= []).push(item.id);
      recipient!.revision++;
    } else {
      const placement = intent as Extract<
        NpcItemIntent,
        { kind: 'place_stock' | 'place_existing' }
      >;
      delete item.ownerId;
      item.mapId = actor.mapId;
      item.x = placement.x;
      item.y = placement.y;
      const occupied = new Set(
        Object.values(s.entities)
          .filter(
            (e) =>
              e.id !== item.id &&
              e.kind === 'item' &&
              !e.ownerId &&
              e.mapId === item.mapId &&
              e.x === item.x &&
              e.y === item.y,
          )
          .map((e) => e.item?.surfaceSlot),
      );
      item.item!.surfaceSlot = Array.from({ length: rules(s).surfaceCapacity }, (_, i) => i).find(
        (i) => !occupied.has(i),
      );
      if (placement.surfaceId) item.item!.surfaceId = placement.surfaceId;
      else delete item.item!.surfaceId;
    }
    item.revision++;
    actor.revision++;

    events.push({
      kind: giving ? 'item.given' : 'item.placed',
      actorId: npcId,
      targetId: item.id,
      mapId: actor.mapId,
    });
  }
  // One bounded, atomic provisioning decision can contain at most two item intents.
  s.turnController!.worldActions++;
  s.turnController!.worldNpcActions[npcId] = (s.turnController!.worldNpcActions[npcId] ?? 0) + 1;
  s.revision++;
  return { state: s, events };
}
export function consumeWorldItem(state: GameState, actorId: string, itemId: string): GameResult {
  const actor = state.entities[actorId],
    item = state.entities[itemId];
  if (
    !actor ||
    !['player', 'npc'].includes(actor.kind) ||
    item?.kind !== 'item' ||
    !item.item?.edible
  )
    return fail(state, 'INVALID_ACTION');
  if (
    item.ownerId
      ? item.ownerId !== actorId || !actor.inventory?.includes(itemId)
      : !visible(state, actor, item) || actor.mapId !== item.mapId || distance(actor, item) > 1
  )
    return fail(state, 'OUT_OF_RANGE');
  const s = structuredClone(state),
    a = s.entities[actorId],
    i = s.entities[itemId];
  const maximum = a.maxVitality ?? s.turnController?.ruleset.vitality ?? 6;
  a.vitality = Math.min(maximum, (a.vitality ?? maximum) + i.item!.restoreVitality);
  a.revision++;
  if (i.item!.quantity > 1) {
    i.item!.quantity--;
    i.revision++;
  } else {
    a.inventory = a.inventory?.filter((id) => id !== itemId);
    delete s.entities[itemId];
  }
  s.revision++;
  return {
    state: s,
    events: [{ kind: 'item.consumed', actorId, targetId: itemId, mapId: actor.mapId }],
  };
}
