import type { GameProjection } from '@dreamwalk/contracts';
import { artPreviewUrl } from './types';
import type { SceneIllustration, VisibleArtBinding } from './use-campaign-art';
type ArtProjection = Pick<GameProjection, 'map' | 'entities' | 'artBindings'>;
/** Explicit empty allowlist removes cached metadata immediately. Older projections may omit it. */
export function authorizedArt(projection: ArtProjection, art: VisibleArtBinding[]) {
  return projection.artBindings === undefined
    ? art
    : art.filter((entry) =>
        projection.artBindings!.some(
          (binding) =>
            binding.slot === entry.slot &&
            binding.revisionId === entry.revisionId &&
            binding.sha256 === entry.sha256,
        ),
      );
}
/** A late network result cannot restore art for an entity/map no longer visible. */
export function visibleSceneArt(projection: ArtProjection, art: VisibleArtBinding[]) {
  const allowed = authorizedArt(projection, art);
  return allowed.filter(
    (entry) =>
      entry.slot === `map:${projection.map.id}:background` ||
      (entry.slot.startsWith(`map:${projection.map.id}:layer:`) &&
        !!projection.map.composition?.layers.some(
          (layer) => entry.slot === `map:${projection.map.id}:layer:${layer.id}`,
        )) ||
      projection.entities.some((entity) => {
        if (entity.kind === 'npc' || entity.kind === 'player')
          return entry.slot === `entity:${entity.id}:sprite`;
        if (entity.kind === 'item') return entry.slot === `entity:${entity.id}:object:default`;
        if (entity.kind === 'door') {
          const active = `entity:${entity.id}:object:${entity.open ? 'open' : 'closed'}`;
          return (
            entry.slot === active ||
            (entry.slot === `entity:${entity.id}:object:default` &&
              !allowed.some((candidate) => candidate.slot === active))
          );
        }
        return false;
      }),
  );
}

/** A server-authorized saved illustration is a backdrop, never spatial evidence.
 * Keep it separate from the normal allowlist: it may restore only this map's
 * background and cannot admit entity art, layers, another map, or external URLs.
 */
export function canvasSceneArt(
  projection: ArtProjection,
  art: VisibleArtBinding[],
  illustration: SceneIllustration | null = null,
): VisibleArtBinding[] {
  const visible = visibleSceneArt(projection, art);
  const slot = `map:${projection.map.id}:background`;
  if (
    projection.map.backgroundMode === 'schematic' &&
    !projection.map.spatialGrounding &&
    illustration?.mapId === projection.map.id &&
    illustration.slot === slot &&
    artPreviewUrl(illustration.url) &&
    !visible.some((entry) => entry.slot === slot)
  )
    return [illustration, ...visible];
  return visible;
}
