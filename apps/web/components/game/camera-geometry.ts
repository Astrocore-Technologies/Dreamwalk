/** Center a small map; otherwise follow the actor without revealing empty space beyond its bounds. */
export function cameraAxis(
  viewport: number,
  mapPixels: number,
  focusPixels: number,
  zoom: number,
): number {
  const extent = mapPixels * zoom;
  if (extent <= viewport) return (viewport - extent) / 2;
  return Math.max(viewport - extent, Math.min(0, viewport / 2 - focusPixels * zoom));
}
