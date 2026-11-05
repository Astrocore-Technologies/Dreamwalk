import type { GameState } from '@dreamwalk/contracts';
import type { StoryPlanSource } from './story-plan';
import { visualDigest } from '../visual-authoring/fingerprint';
/** Resolve the pre-freeze content proof to the immutable package identity once,
 * at campaign creation. Never create eligibility from generic offstage placement. */
export function bindUnresolvedScenePresence(
  state: GameState,
  content: StoryPlanSource['content'],
  checksum: string,
) {
  for (const entity of Object.values(state.entities)) {
    const marker = entity.unresolvedScenePresence;
    if (!marker) continue;
    const map = state.maps[entity.mapId],
      scene = map?.scenePresence?.scenes.find((s) => s.id === entity.sceneId);
    if (
      entity.kind !== 'npc' ||
      entity.spatialMode !== 'location_only' ||
      map?.spatialMode !== 'location_only' ||
      marker.sourceChecksum !== visualDigest(content) ||
      marker.sourceMapId !== entity.mapId ||
      marker.sourceSceneId !== entity.sceneId ||
      !content.npcIds.includes(entity.id) ||
      !content.locations.some((l) => l.id === entity.mapId) ||
      content.scenes.some((s) => s.participantNpcIds?.includes(entity.id)) ||
      map.scenePresence?.entrySceneId === entity.sceneId ||
      scene?.participantIds.length !== 1 ||
      scene.participantIds[0] !== entity.id
    )
      throw new Error('STORY_SCENE_UNRESOLVED_SOURCE_INVALID');
    entity.unresolvedScenePresence = { ...marker, sourceChecksum: checksum };
  }
}
