import { TOKEN_FOOTPRINT, footprintCells } from '@dreamwalk/contracts';
import type { PositionedGameEntity } from '@dreamwalk/contracts';
export type SceneEntity = PositionedGameEntity;
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
  if (actor) {
    const footprint = tile * TOKEN_FOOTPRINT[e.tokenSize ?? 'medium'];
    const ratio = fullBody && Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
    const width = footprint * Math.min(1, ratio);
    const height = footprint / Math.max(1, ratio);
    return {
      x: (e.x + footprintCells(e) / 2) * tile - width / 2,
      y: (e.y + footprintCells(e) / 2) * tile - height / 2,
      width,
      height,
    };
  }
  return { x: e.x * tile, y: e.y * tile, width: tile, height: tile };
}
