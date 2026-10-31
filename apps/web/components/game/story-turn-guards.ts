import type { GameProjection } from '@dreamwalk/contracts';
/** Missing private recipients never silently become public narration. */
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
  return storyTargetVisible(projection, targetNpcId) && (channel !== 'whisper' || !!targetNpcId);
}
export function storyDraftKey(
  text: string,
  channel: 'say' | 'whisper',
  targetNpcId: string | undefined,
  mapId: string,
) {
  return JSON.stringify([text.trim(), channel, targetNpcId || '', mapId]);
}
