import type { GameProjection } from '@dreamwalk/contracts';

/** Presentation fence only; the server owns admission and saved-state recovery. */
export function isSpatialRecoveryRequired(projection: GameProjection | null | undefined) {
  return (
    projection?.spatialRecoveryRequired === true || projection?.map?.spatialMode === 'location_only'
  );
}
