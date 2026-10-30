/** Decode at most one admitted request; retain only a bounded display canvas. */
export async function decodeArt(blob: Blob, width: number, height: number, signal: AbortSignal) {
  if (signal.aborted) throw new Error('ART_ABORTED');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('ART_CANVAS_UNAVAILABLE');
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'high',
      });
      try {
        if (signal.aborted) throw new Error('ART_ABORTED');
        context.drawImage(bitmap, 0, 0, width, height);
      } finally {
        bitmap.close();
      }
    } else {
      const url = URL.createObjectURL(blob),
        image = new Image();
      try {
        image.src = url;
        await image.decode();
        if (signal.aborted) throw new Error('ART_ABORTED');
        context.drawImage(image, 0, 0, width, height);
      } finally {
        image.src = '';
        URL.revokeObjectURL(url);
      }
    }
    return canvas;
  } catch (error) {
    canvas.width = 0;
    canvas.height = 0;
    throw error;
  }
}
