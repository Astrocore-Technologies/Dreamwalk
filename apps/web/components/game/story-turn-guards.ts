import type { GameProjection } from '@dreamwalk/contracts';
/** Grid speech has listeners, not a selected addressee. Keep old saves compatible. */
export function storyRecipientForProjection(
  projection: Pick<GameProjection, 'turn'>,
  recipient: { id: string; label: string } | null,
) {
  return projection.turn ? null : recipient;
}
/** A stale selected recipient fails closed; area whispers require turn-based play. */
export function storyTargetVisible(projection: GameProjection, targetNpcId?: string) {
  return (
    !targetNpcId ||
    projection.entities.some((entity) => entity.kind === 'npc' && entity.id === targetNpcId)
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
