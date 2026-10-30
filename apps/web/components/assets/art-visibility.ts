import type { GameProjection } from '@dreamwalk/contracts';
import type { VisibleArtBinding } from './use-campaign-art';
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
      projection.entities.some((entity) => {
        if (entity.kind === 'npc') return entry.slot === `entity:${entity.id}:sprite`;
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
