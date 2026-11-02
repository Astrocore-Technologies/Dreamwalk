import { cameraAxis } from './camera-geometry';

export const MIN_MAP_ZOOM = 0.6;
export const MAX_MAP_ZOOM = 3;
const positive = (value: number, fallback: number) =>
  Number.isFinite(value) && value > 0 ? value : fallback;

/** Zoom is relative to the largest undistorted view containing the entire world.
 * Recomputed from the viewport each frame: resizing never resets the user's zoom.
 * Above fit, keep the actor visible without exposing space beyond larger map axes.
 */
export function mapCamera({
  viewportWidth,
  viewportHeight,
  worldWidth,
  worldHeight,
  zoom = 1,
  focusX,
  focusY,
}: {
  viewportWidth: number;
  viewportHeight: number;
  worldWidth: number;
  worldHeight: number;
  zoom?: number;
  focusX?: number;
  focusY?: number;
}) {
  const width = positive(worldWidth, 1);
  const height = positive(worldHeight, 1);
  const viewportX = positive(viewportWidth, 1);
  const viewportY = positive(viewportHeight, 1);
  const fitScale = Math.min(viewportX / width, viewportY / height);
  const relativeZoom = Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, positive(zoom, 1)));
  const scale = fitScale * relativeZoom;
  return {
    fitScale,
    scale,
    x: cameraAxis(viewportX, width, Number.isFinite(focusX) ? focusX! : width / 2, scale),
    y: cameraAxis(viewportY, height, Number.isFinite(focusY) ? focusY! : height / 2, scale),
  };
}

/** Preserve raster aspect inside authoritative world bounds; never crop or stretch. */
export function containRaster(
  imageWidth: number,
  imageHeight: number,
  worldWidth: number,
  worldHeight: number,
) {
  const imageX = positive(imageWidth, 1);
  const imageY = positive(imageHeight, 1);
  const worldX = positive(worldWidth, 1);
  const worldY = positive(worldHeight, 1);
  const scale = Math.min(worldX / imageX, worldY / imageY);
  const width = imageX * scale;
  const height = imageY * scale;
  return { x: (worldX - width) / 2, y: (worldY - height) / 2, width, height };
}

/** Legacy assets retain their pinned full-world mapping. Only server-validated,
 * versioned framing for this map opts into aspect-preserving containment. */
export function mapRasterBounds(
  imageWidth: number,
  imageHeight: number,
  worldWidth: number,
  worldHeight: number,
  framing?: {
    version: 1;
    mapId: string;
    mapWidth: number;
    mapHeight: number;
    width: number;
    height: number;
    fit: 'contain';
  },
  map?: { id: string; width: number; height: number },
) {
  if (
    framing?.version === 1 &&
    framing.fit === 'contain' &&
    map &&
    framing.mapId === map.id &&
    framing.mapWidth === map.width &&
    framing.mapHeight === map.height &&
    framing.width === imageWidth &&
    framing.height === imageHeight
  ) {
    return containRaster(imageWidth, imageHeight, worldWidth, worldHeight);
  }
  return { x: 0, y: 0, width: positive(worldWidth, 1), height: positive(worldHeight, 1) };
}
