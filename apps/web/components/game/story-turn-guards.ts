import { npcUnavailable } from './turn-ui';
import type { GameProjection } from '@dreamwalk/contracts';
/** Grid speech uses ranged listeners; scene-only play preserves an explicit addressee. */
export function storyRecipientForProjection(
  projection: Pick<GameProjection, 'turn'> & Partial<Pick<GameProjection, 'map'>>,
  recipient: { id: string; label: string } | null,
) {
  return projection.turn && projection.map?.spatialMode !== 'location_only' ? null : recipient;
}
/** A stale selected recipient fails closed; area whispers require turn-based play. */
export function storyTargetVisible(projection: GameProjection, targetNpcId?: string) {
  return (
    !targetNpcId ||
    projection.entities.some(
      (entity) => entity.kind === 'npc' && entity.id === targetNpcId && !npcUnavailable(entity),
    )
  );
}
export function storyTargetValid(
  projection: GameProjection,
  channel: 'say' | 'whisper',
  targetNpcId?: string,
) {
  return (
    (channel === 'say' || channel === 'whisper') &&
    storyTargetVisible(projection, targetNpcId) &&
    (channel !== 'whisper' || !!targetNpcId || !!projection.turn)
  );
}
/** Selection keeps identity; its display name follows the current localized projection. */
export function storyRecipientLabel(
  projection: Pick<GameProjection, 'entities'>,
  recipient: { id: string; label: string } | null,
) {
  if (!recipient) return null;
  return (
    projection.entities.find((entity) => entity.kind === 'npc' && entity.id === recipient.id)
      ?.label || recipient.label
  );
}
export function storyDraftKey(
  text: string,
  channel: 'say' | 'whisper',
  targetNpcId: string | undefined,
  mapId: string,
) {
  return JSON.stringify([text.trim(), channel, targetNpcId || '', mapId]);
}
