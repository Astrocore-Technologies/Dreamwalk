import {
  frozenArtBindingsSchema,
  type AuthoredGameDraft,
  type FrozenArtBinding,
  type GameState,
  type PlayablePackage,
} from '@dreamwalk/contracts';
import { visible } from './index';

export interface ArtSlotSpec {
  slot: string;
  kind: 'background' | 'sprite' | 'portrait' | 'object';
  camera: 'top-down' | 'portrait';
  mapId: string;
  entityId?: string;
}
export type ParsedArtSlot =
  | { scope: 'map'; id: string; variant: 'background' }
  | { scope: 'entity'; id: string; variant: 'sprite' | 'portrait' | 'default' | 'open' | 'closed' };
const safeId = (id: string) => /^[A-Za-z0-9_-]{1,100}$/.test(id) && !(id in Object.prototype);
export function parseArtSlot(slot: string): ParsedArtSlot | null {
  const p = slot.split(':');
  if (!safeId(p[1] ?? '')) return null;
  if (p.length === 3 && p[0] === 'map' && p[2] === 'background')
    return { scope: 'map', id: p[1], variant: 'background' };
  if (p.length === 3 && p[0] === 'entity' && (p[2] === 'sprite' || p[2] === 'portrait'))
    return { scope: 'entity', id: p[1], variant: p[2] };
  if (
    p.length === 4 &&
    p[0] === 'entity' &&
    p[2] === 'object' &&
    (p[3] === 'default' || p[3] === 'open' || p[3] === 'closed')
  )
    return { scope: 'entity', id: p[1], variant: p[3] };
  return null;
}
export function enumerateArtSlots(source: AuthoredGameDraft | PlayablePackage): ArtSlotSpec[] {
  const maps = Object.values(source.maps);
  const entities =
    'entities' in source
      ? Object.values(source.entities)
      : [...source.objects, ...source.npcs.map((n) => ({ ...n, kind: 'npc' as const }))];
  const out: ArtSlotSpec[] = maps.map((m) => ({
    slot: `map:${m.id}:background`,
    kind: 'background',
    camera: 'top-down',
    mapId: m.id,
  }));
  for (const e of entities) {
    const variants =
      e.kind === 'npc'
        ? ['sprite', 'portrait']
        : e.kind === 'door'
          ? ['default', 'open', 'closed']
          : e.kind === 'item'
            ? ['default']
            : [];
    for (const variant of variants)
      out.push({
        slot: `entity:${e.id}:${variant === 'sprite' || variant === 'portrait' ? variant : `object:${variant}`}`,
        kind: variant === 'sprite' || variant === 'portrait' ? variant : 'object',
        camera: variant === 'portrait' ? 'portrait' : 'top-down',
        mapId: e.mapId,
        entityId: e.id,
      });
  }
  return out.sort((a, b) => a.slot.localeCompare(b.slot));
}
export function validateArtBindingSlot(
  source: AuthoredGameDraft | PlayablePackage,
  slot: string,
  metadata: { kind: string; style: string; camera: string },
): boolean {
  if (!parseArtSlot(slot) || metadata.style !== 'drawn2D') return false;
  const spec = enumerateArtSlots(source).find((s) => s.slot === slot);
  return (
    !!spec &&
    spec.kind === metadata.kind &&
    (metadata.camera === spec.camera || metadata.camera === 'unrestricted')
  );
}
/** Rendering authorization uses current server visibility, not mere membership in a pinned version. */
export function projectVisibleArtBindings(
  state: GameState,
  actorId: string,
  bindings: readonly FrozenArtBinding[] = state.artBindings ?? [],
): FrozenArtBinding[] {
  const actor = state.entities[actorId];
  if (!actor || actor.kind !== 'player') return [];
  const parsed = frozenArtBindingsSchema.safeParse(bindings);
  if (!parsed.success) return [];
  return parsed.data.filter((binding) => {
    const slot = parseArtSlot(binding.slot);
    if (!slot) return false;
    if (slot.scope === 'map') return slot.id === actor.mapId;
    const entity = state.entities[slot.id];
    if (
      !entity ||
      !(
        visible(state, actor, entity) ||
        (entity.ownerId === actorId && actor.inventory?.includes(entity.id))
      )
    )
      return false;
    if (slot.variant === 'sprite' || slot.variant === 'portrait') return entity.kind === 'npc';
    if (entity.kind !== 'item' && entity.kind !== 'door') return false;
    if (slot.variant === 'default')
      return (
        entity.kind !== 'door' ||
        !parsed.data.some(
          (candidate) =>
            candidate.slot === `entity:${entity.id}:object:${entity.open ? 'open' : 'closed'}`,
        )
      );
    return entity.kind === 'door' && slot.variant === (entity.open ? 'open' : 'closed');
  });
}
