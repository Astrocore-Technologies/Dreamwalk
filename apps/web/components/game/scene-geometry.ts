import type { GameProjection } from '@dreamwalk/contracts';
export type SceneEntity = GameProjection['entities'][number];
export type SceneRect = { x: number; y: number; width: number; height: number };
export function containsScenePoint(r: SceneRect, p: { x: number; y: number }) {
  return p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;
}
/** Same layout for rendering, pointer hit testing and tests; shared table items have distinct slots. */
export function entityLayout(
  e: SceneEntity,
  entities: SceneEntity[],
  tile = 48,
  aspect = 1,
  fullBody = false,
): SceneRect {
  if (e.kind === 'item' && e.item) {
    const peers = entities
      .filter((o) => o.kind === 'item' && o.item && o.x === e.x && o.y === e.y)
      .sort((a, b) => a.id.localeCompare(b.id));
    const i =
      e.item.surfaceSlot ??
      Math.max(
        0,
        peers.findIndex((o) => o.id === e.id),
      );
    return {
      x: e.x * tile + tile * (0.08 + (i % 2) * 0.44),
      y: e.y * tile + tile * ((e.item.surfaceId ? -0.42 : 0.08) + Math.floor(i / 2) * 0.44),
      width: tile * 0.38,
      height: tile * 0.38,
    };
  }
  const actor = e.kind === 'npc' || e.kind === 'player';
  const height = fullBody && actor ? tile * 1.5 : tile;
  const width = fullBody && actor ? Math.min(tile, height * aspect) : tile;
  return { x: e.x * tile + (tile - width) / 2, y: e.y * tile - (height - tile), width, height };
}
