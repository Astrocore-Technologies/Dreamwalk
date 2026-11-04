import type { StoryPlanSource } from './story-plan';
import type { AuthoringTextProfile } from '../live-test/authoring-provider';
import type { PlayablePackage } from '@dreamwalk/contracts';

/** A cached text-only layout must not stand in for a source whose images can now be analyzed.
 * This only selects a reusable preparation. It never regenerates or moves an existing campaign. */
export function startMapGroundingCompatible(source: StoryPlanSource, compiled: PlayablePackage) {
  return (source.mapImages ?? []).every((image) => {
    const map = compiled.maps?.[image.locationId],
      grounding = map?.spatialGrounding;
    return (
      map?.backgroundMode !== 'schematic' &&
      grounding?.imageRevisionId === image.revisionId &&
      grounding.imageSha256 === image.sha256 &&
      grounding.confidence >= 0.85
    );
  });
}

/** Only a missing vision capability permits fallback. Invalid/expired configured policies still fail. */
export function schematicStorySource(source: StoryPlanSource, profile?: AuthoringTextProfile) {
  if (!profile || profile.storyVision || !source.mapImages?.length) return source;
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
