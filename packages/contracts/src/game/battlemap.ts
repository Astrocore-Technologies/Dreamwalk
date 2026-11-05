import { z } from 'zod';
/** One cell is the existing movement unit; this does not introduce D&D combat rules. */
export const BATTLEMAP_CELLS = 24;
export const BATTLEMAP_TILE = 48;
export const BATTLEMAP_IMAGE_SIZE = 1024;
/** Explicit creature size. Action costs and damage rules stay unchanged. */
export const tokenSizeSchema = z.enum(['tiny', 'small', 'medium', 'large', 'huge']);
export type TokenSize = z.infer<typeof tokenSizeSchema>;
export const TOKEN_FOOTPRINT: Readonly<Record<TokenSize, number>> = {
  tiny: 0.4,
  small: 0.6,
  medium: 0.85,
  large: 1.7,
  huge: 2.55,
};

type Occupant = {
  x?: number;
  y?: number;
  spatialMode?: 'location_only';
  kind?: string;
  tokenSize?: TokenSize;
};
/** Unknown positions never acquire a placeholder coordinate or collision footprint. */
export function hasPosition<T extends { x?: number; y?: number; spatialMode?: 'location_only' }>(
  entity: T | undefined | null,
): entity is T & { x: number; y: number } {
  return (
    !!entity &&
    entity.spatialMode !== 'location_only' &&
    Number.isFinite(entity.x) &&
    Number.isFinite(entity.y)
  );
}
export function isLocationOnlyMap(
  map: { spatialMode?: 'location_only' } | undefined | null,
): boolean {
  return map?.spatialMode === 'location_only';
}

export function footprintCells(entity?: { kind?: string; tokenSize?: TokenSize }): number {
  if (entity?.kind !== 'npc' && entity?.kind !== 'player') return 1;
  return entity.tokenSize === 'huge' ? 3 : entity.tokenSize === 'large' ? 2 : 1;
}
export function occupiedCells(entity: Occupant) {
  if (!hasPosition(entity)) return [];
  const edge = footprintCells(entity);
  return Array.from({ length: edge * edge }, (_, i) => ({
    x: entity.x + (i % edge),
    y: entity.y + Math.floor(i / edge),
  }));
}
/** Manhattan distance between nearest occupied cells (zero means overlap). */
export function footprintDistance(a: Occupant, b: Occupant): number {
  if (!hasPosition(a) || !hasPosition(b)) return Infinity;
  const aw = footprintCells(a),
    bw = footprintCells(b);
  return (
    Math.max(0, a.x - (b.x + bw - 1), b.x - (a.x + aw - 1)) +
    Math.max(0, a.y - (b.y + bw - 1), b.y - (a.y + aw - 1))
  );
}
export function footprintOverlaps(a: Occupant, b: Occupant): boolean {
  return footprintDistance(a, b) === 0;
}
export function footprintInside(
  entity: Occupant,
  area: { x: number; y: number; width: number; height: number },
) {
  if (!hasPosition(entity)) return false;
  const edge = footprintCells(entity);
  return (
    entity.x >= area.x &&
    entity.y >= area.y &&
    entity.x + edge <= area.x + area.width &&
    entity.y + edge <= area.y + area.height
  );
}

export function footprintIntersectsArea(
  entity: Occupant,
  area: { x: number; y: number; width: number; height: number },
) {
  if (!hasPosition(entity)) return false;
  const edge = footprintCells(entity);
  return (
    entity.x < area.x + area.width &&
    entity.x + edge > area.x &&
    entity.y < area.y + area.height &&
    entity.y + edge > area.y
  );
}

/** Candidate top-left anchors whose footprint touches a target edge. */
export function adjacentFootprintAnchors(actor: Occupant, target: Occupant) {
  if (!hasPosition(actor) || !hasPosition(target)) return [];
  const own = footprintCells(actor),
    other = footprintCells(target);
  const points: { x: number; y: number }[] = [];
  for (let y = target.y - own; y <= target.y + other; y++)
    for (let x = target.x - own; x <= target.x + other; x++)
      if (footprintDistance({ ...actor, x, y }, target) === 1) points.push({ x, y });
  return points;
}

/** Legacy saved geometry is editable, but new/resized maps cannot bypass the fixed extent. */
export function fixedMapExtentsAllowed(
  maps: readonly { id: string; width: number; height: number }[],
  prior: readonly { id: string; width: number; height: number }[] = [],
): boolean {
  return maps.every(
    (map) =>
      (map.width === BATTLEMAP_CELLS && map.height === BATTLEMAP_CELLS) ||
      prior.some(
        (old) => old.id === map.id && old.width === map.width && old.height === map.height,
      ),
  );
}
