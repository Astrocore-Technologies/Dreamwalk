import { occupiedCells, type GameEntity, type GameState } from '@dreamwalk/contracts';
import { visible } from './index';
/** Perception only. Never use image observations to authorize or block an action. */
export function observedVisible(state: GameState, actor: GameEntity, target: GameEntity): boolean {
  if (!visible(state, actor, target)) return false;
  const map = state.maps[actor.mapId],
    g = map?.spatialGrounding;
  const bound = state.artBindings?.find((b) => b.slot === `map:${map.id}:background`);
  if (!g || (bound && bound.revisionId !== g.imageRevisionId)) return true;
  const opaque = (x: number, y: number) => {
    const cell = g.rows[y]?.[x] ?? '?';
    return (
      ['#', 'X', '?'].includes(cell) ||
      (cell === 'D' && !(g.doors ?? []).some((d) => d.x === x && d.y === y && d.open))
    );
  };
  const clear = (from: { x: number; y: number }, targetX: number, targetY: number) => {
    let x = from.x,
      y = from.y;
    const dx = targetX - x,
      dy = targetY - y,
      nx = Math.abs(dx),
      ny = Math.abs(dy),
      sx = Math.sign(dx),
      sy = Math.sign(dy);
    let ix = 0,
      iy = 0;
    while (ix < nx || iy < ny) {
      const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
      if (decision === 0) {
        // Supercover: no sight through the crack between two corner cells.
        if (opaque(x + sx, y) || opaque(x, y + sy)) return false;
        x += sx;
        y += sy;
        ix++;
        iy++;
      } else if (decision < 0) {
        x += sx;
        ix++;
      } else {
        y += sy;
        iy++;
      }
      if (x === targetX && y === targetY) return true;
      if (opaque(x, y)) return false;
    }
    return true;
  };
  return occupiedCells(actor).some((from) =>
    occupiedCells(target).some(
      (to) =>
        Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) <= 9 && clear(from, to.x, to.y),
    ),
  );
}
