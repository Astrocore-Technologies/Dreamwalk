import { hasPosition } from '@dreamwalk/contracts';
import { sharesScene } from './scene-presence';
import { isActorConscious } from '@dreamwalk/contracts';
import { occupiedCells, type GameEntity, type GameState } from '@dreamwalk/contracts';
import { visible } from './index';
/** Conscious perception shares the public/contact visibility boundary. Movement stays independent. */
export function observedVisible(state: GameState, actor: GameEntity, target: GameEntity): boolean {
  if (!hasPosition(actor) || !hasPosition(target))
    return isActorConscious(actor) && sharesScene(state, actor, target);
  return isActorConscious(actor) && visible(state, actor, target);
}

/** Image evidence fences observation/contact, never collision or ordinary RP movement. */
export function imageLineOfSight(state: GameState, actor: GameEntity, target: GameEntity): boolean {
  if (!hasPosition(actor) || !hasPosition(target)) return sharesScene(state, actor, target);
  const map = state.maps[actor.mapId],
    g = map?.spatialGrounding;
  const bound = state.artBindings?.find((b) => b.slot === `map:${map.id}:background`);
  if (!g) return true;
  if (bound && (bound.revisionId !== g.imageRevisionId || bound.sha256 !== g.imageSha256))
    return false;
  const opaque = (x: number, y: number) => imageCellOpaque(state, actor.mapId, x, y);
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

/** Conservative information topology. This is not movement collision. */
export function imageCellOpaque(state: GameState, mapId: string, x: number, y: number): boolean {
  const g = state.maps[mapId]?.spatialGrounding;
  if (!g) return false;
  const bound = state.artBindings?.find((b) => b.slot === `map:${mapId}:background`);
  if (bound && (bound.revisionId !== g.imageRevisionId || bound.sha256 !== g.imageSha256))
    return true;
  const cell = g.rows[y]?.[x] ?? '?';
  if (cell === 'D') {
    const door = Object.values(state.entities).find(
      (e) => e.mapId === mapId && e.kind === 'door' && hasPosition(e) && e.x === x && e.y === y,
    );
    if (door) return !door.open;
  }
  return (
    ['#', 'X', '?'].includes(cell) ||
    (cell === 'D' && !(g.doors ?? []).some((d) => d.x === x && d.y === y && d.open))
  );
}
