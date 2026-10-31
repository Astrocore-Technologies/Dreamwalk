import type { GameProjection } from '@dreamwalk/contracts';
/** Clicking a visible NPC selects a recipient; only a free floor click requests movement. */
export function sceneClick(
  projection: GameProjection,
  x: number,
  y: number,
): { kind: 'npc'; npcId: string } | { kind: 'move'; target: { x: number; y: number } } | null {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= projection.map.width ||
    y >= projection.map.height
  )
    return null;
  const npc = projection.entities.find(
    (entry) => entry.kind === 'npc' && entry.x === x && entry.y === y,
  );
  if (npc) return { kind: 'npc', npcId: npc.id };
  if (
    projection.map.blocked.some((point) => point.x === x && point.y === y) ||
    projection.entities.some(
      (entry) => entry.kind === 'door' && !entry.open && entry.x === x && entry.y === y,
    )
  )
    return null;
  return { kind: 'move', target: { x, y } };
}
