import { occupiedCells, type GameEntity, type GameState } from '@dreamwalk/contracts';

/** Image-grounded scene-cut admission only, never movement or pathfinding collision. */
export function groundedArrivalArea(state: GameState, mapId: string) {
  const map = state.maps[mapId];
  if (!map) return { valid: false, allows: () => false };
  // Scene admission is conservative even though ordinary RP movement is not
  // restricted by the image observation raster. Never auto-place on uncertainty.
  const grounding = map.spatialGrounding;
  const reachable = new Set<string>();
  const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
  if (grounding) {
    const binding = state.artBindings?.find((b) => b.slot === `map:${mapId}:background`);
    const anchor = map.spawns[0];
    if (
      !binding ||
      binding.revisionId !== grounding.imageRevisionId ||
      binding.sha256 !== grounding.imageSha256 ||
      grounding.confidence < 0.85 ||
      !anchor ||
      grounding.rows[anchor.y]?.[anchor.x] !== '.'
    )
      return { valid: false, allows: () => false };
    const queue = [anchor];
    for (let i = 0; i < queue.length; i++) {
      const cell = queue[i];
      if (reachable.has(key(cell))) continue;
      reachable.add(key(cell));
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const neighbor = { x: cell.x + dx, y: cell.y + dy };
        if (
          '.D'.includes(grounding.rows[neighbor.y]?.[neighbor.x] ?? '?') &&
          !reachable.has(key(neighbor))
        )
          queue.push(neighbor);
      }
    }
  }
  return {
    valid: true,
    allows: (entity: GameEntity, point: { x: number; y: number }) =>
      !grounding ||
      occupiedCells({ ...entity, ...point, spatialMode: undefined }).every(
        (cell) => grounding.rows[cell.y]?.[cell.x] === '.' && reachable.has(key(cell)),
      ),
  };
}
