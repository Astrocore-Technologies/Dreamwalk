import type { GamePoint } from '@dreamwalk/contracts';

export const MAP_RULER_SIZE = 22;
const LABEL_SPACING = 26;

export interface MapCoordinateTick {
  value: number;
  position: number;
  label: boolean;
}

/** Coordinates refer to engine cells, never sprite centers or the padded square.
 * Screen-space rulers keep their type size when the camera moves/zooms. Dense
 * views retain every tick but label only enough cells to avoid overlapping text.
 */
export function mapCoordinateTicks(
  count: number,
  origin: number,
  cellPixels: number,
  viewportPixels: number,
): MapCoordinateTick[] {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 64 ||
    !Number.isFinite(origin) ||
    !Number.isFinite(cellPixels) ||
    cellPixels <= 0 ||
    !Number.isFinite(viewportPixels) ||
    viewportPixels <= MAP_RULER_SIZE
  )
    return [];
  const step = Math.max(1, Math.ceil(LABEL_SPACING / cellPixels));
  return Array.from({ length: count }, (_, value) => ({
    value,
    position: origin + (value + 0.5) * cellPixels,
    label: value % step === 0,
  })).filter(({ position }) => position >= 0 && position < viewportPixels - MAP_RULER_SIZE);
}

/** Shares pointer movement's top-left, x-right/y-down, 0-based cell convention. */
export function mapCoordinateAt(
  point: GamePoint,
  map: { width: number; height: number },
  tile: number,
): GamePoint | null {
  if (!Number.isFinite(tile) || tile <= 0) return null;
  const x = Math.floor(point.x / tile),
    y = Math.floor(point.y / tile);
  return Number.isSafeInteger(x) &&
    Number.isSafeInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < map.width &&
    y < map.height
    ? { x, y }
    : null;
}
