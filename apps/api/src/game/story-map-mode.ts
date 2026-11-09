import type { StoryPlanSource } from './story-plan';
import type { AuthoringTextProfile } from '../live-test/authoring-provider';
import type { PlayablePackage } from '@dreamwalk/contracts';
import { requiresMapRecovery } from './map-readiness';
import { fail } from '../errors';

/** A cached text-only layout must not stand in for a source whose images can now be analyzed.
 * This only selects a reusable preparation. It never regenerates or moves an existing campaign. */
export function startMapGroundingCompatible(source: StoryPlanSource, compiled: PlayablePackage) {
  if (requiresMapRecovery(compiled) || source.omittedMapImages?.length) return false;
  return (source.mapImages ?? []).every((image) => {
    const map = compiled.maps?.[image.locationId],
      grounding = map?.spatialGrounding;
    return (
      map?.backgroundMode !== 'schematic' &&
      grounding?.imageRevisionId === image.revisionId &&
      grounding.imageSha256 === image.sha256
    );
  });
}

/** Images must be analyzed by the quoted policy; never silently replace them with a text map. */
export function schematicStorySource(source: StoryPlanSource, profile?: AuthoringTextProfile) {
  if (
    source.omittedMapImages?.length ||
    (profile && !profile.storyVision && source.mapImages?.length)
  )
    fail(409, 'MAP_VISION_POLICY_REQUIRED', 'MAP_VISION_POLICY_REQUIRED');
  return source;
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
