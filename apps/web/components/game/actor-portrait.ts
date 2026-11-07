/**
 * Player hero portraits are served by an authorized per-actor endpoint, separate from the
 * pinned art manifest (which carries NPC art and visual character packages). The server
 * checks campaign membership, actor visibility and takedowns on every request.
 */
export const ACTOR_PORTRAIT_RECHECK_MS = 60_000;
export const ACTOR_PORTRAIT_MAX_SIDE = 256;
const PLAYER_ACTOR = /^player-[a-f0-9-]{36}$/;

export function actorPortraitUrl(campaignId: string | undefined, actorId: string) {
  if (!campaignId || !PLAYER_ACTOR.test(actorId)) return undefined;
  return `/api/v1/game/campaigns/${encodeURIComponent(campaignId)}/actors/${actorId}/portrait`;
}

/** Decode into a small bounded canvas; the original bytes are never retained. */
export async function decodeActorPortrait(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, ACTOR_PORTRAIT_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('PORTRAIT_CANVAS_UNAVAILABLE');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap.close();
  }
}
