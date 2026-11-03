import type { StoryPlanSource } from './story-plan';
import type { AuthoringTextProfile } from '../live-test/authoring-provider';

/** Only a missing vision capability permits fallback. Invalid/expired configured policies still fail. */
export function schematicStorySource(source: StoryPlanSource, profile?: AuthoringTextProfile) {
  if (!profile || profile.storyVision !== undefined || !source.mapImages?.length) return source;
  const { mapImages, ...text } = source;
  return {
    ...text,
    omittedMapImages: mapImages.map(({ locationId, revisionId, sha256 }) => ({
      locationId,
      revisionId,
      sha256,
    })),
  };
}
/** Author bindings stay saved; only the playable view omits a schematic map's raster. */
export function playableMapBindings<T extends { slot: string }>(
  bindings: T[],
  maps: Record<string, { id: string; backgroundMode?: 'schematic' }>,
) {
  const omitted = new Set(
    Object.values(maps)
      .filter((m) => m.backgroundMode === 'schematic')
      .map((m) => `map:${m.id}:background`),
  );
  return bindings.filter((b) => !omitted.has(b.slot));
}
