import type { Graphics } from 'pixi.js';
export type SceneMap = {
  width: number;
  height: number;
  blocked: { x: number; y: number }[];
  sceneProfile?: 'observatory-interior-v1' | 'observatory-roof-v1';
};
/** Original code-native floor dressing, not generated art or gameplay geometry. */
export function sceneCells(map: SceneMap) {
  if (!['observatory-interior-v1', 'observatory-roof-v1'].includes(map.sceneProfile || ''))
    return [];
  const blocked = new Set(map.blocked.map(({ x, y }) => `${x},${y}`));
  const cells: { x: number; y: number; edge: boolean }[] = [];
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++)
      if (!blocked.has(`${x},${y}`))
        cells.push({
          x,
          y,
          edge: x === 0 || y === 0 || x === map.width - 1 || y === map.height - 1,
        });
  return cells;
}
export function drawBundledScene(graphics: Graphics, map: SceneMap, tile: number) {
  graphics.clear();
  const roof = map.sceneProfile === 'observatory-roof-v1';
  for (const { x, y, edge } of sceneCells(map)) {
    const left = x * tile,
      top = y * tile;
    // All decoration remains inside verified walkable cells, never a drawn obstacle.
    graphics
      .roundRect(left + 3, top + 3, tile - 6, tile - 6, 5)
      .fill({ color: roof ? 0x314353 : 0x745568, alpha: roof ? 0.54 : 0.27 });
    graphics
      .moveTo(left + 7, top + 7)
      .lineTo(left + tile - 8, top + 7)
      .stroke({ color: roof ? 0x9dbccc : 0xd5b888, width: 1, alpha: edge ? 0.5 : 0.16 });
    if (roof && (x * 7 + y * 11) % 5 === 0) {
      const cx = left + tile / 2,
        cy = top + tile / 2;
      graphics
        .moveTo(cx - 5, cy)
        .lineTo(cx + 5, cy)
        .moveTo(cx, cy - 5)
        .lineTo(cx, cy + 5)
        .stroke({ color: 0xc5dbe6, width: 1, alpha: 0.45 });
    } else if (!roof && x % 3 === 2 && y % 3 === 2) {
      graphics
        .circle(left + tile / 2, top + tile / 2, tile * 0.22)
        .stroke({ color: 0xd4b77f, width: 1.2, alpha: 0.38 });
      graphics
        .moveTo(left + tile / 2, top + 11)
        .lineTo(left + tile / 2, top + tile - 11)
        .moveTo(left + 11, top + tile / 2)
        .lineTo(left + tile - 11, top + tile / 2)
        .stroke({ color: 0xd4b77f, width: 1, alpha: 0.26 });
    }
  }
}
/** Separate original book silhouette; never modifies the immutable legacy atlas. */
export function drawJournal(graphics: Graphics) {
  graphics.rect(0, 0, 64, 64).fill({ color: 0, alpha: 0 });
  graphics.ellipse(32, 54, 21, 5).fill({ color: 0x0a0a18, alpha: 0.4 });
  graphics.roundRect(13, 12, 38, 42, 4).fill(0x342537).stroke({ color: 0xd8b878, width: 2 });
  graphics.rect(17, 15, 31, 35).fill(0x79516d);
  graphics.rect(18, 48, 30, 4).fill(0xe1d1b5);
  graphics.moveTo(21, 16).lineTo(21, 47).stroke({ color: 0xc9a16d, width: 2 });
  graphics.circle(34, 30, 8).stroke({ color: 0xf1d58a, width: 1.5 });
  graphics
    .moveTo(34, 19)
    .lineTo(34, 41)
    .moveTo(23, 30)
    .lineTo(45, 30)
    .stroke({ color: 0xf1d58a, width: 1 });
}
