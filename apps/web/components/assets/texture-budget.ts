/** Client display derivatives only. Stored originals and pinned hashes are never changed. */
export const ART_TEXTURE_LIMITS = {
  concurrent: 4,
  pixels: 8 * 1024 * 1024,
  backgroundSide: 2048,
  objectSide: 512,
} as const;
export function textureDimensions(slot: string, width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096
  )
    return null;
  const side =
    slot.startsWith('map:') && slot.endsWith(':background')
      ? ART_TEXTURE_LIMITS.backgroundSide
      : ART_TEXTURE_LIMITS.objectSide;
  const scale = Math.min(1, side / Math.max(width, height));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}
export class TextureBudget {
  private entries = new Map<string, { pixels: number; pending: boolean }>();
  private closed = false;
  get pixels() {
    return [...this.entries.values()].reduce((sum, entry) => sum + entry.pixels, 0);
  }
  get pending() {
    return [...this.entries.values()].filter((entry) => entry.pending).length;
  }
  admit(key: string, width: number, height: number) {
    const pixels = width * height;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      this.closed ||
      this.entries.has(key) ||
      !Number.isSafeInteger(pixels) ||
      pixels < 1 ||
      this.pending >= ART_TEXTURE_LIMITS.concurrent ||
      this.pixels + pixels > ART_TEXTURE_LIMITS.pixels
    )
      return false;
    this.entries.set(key, { pixels, pending: true });
    return true;
  }
  complete(key: string, keep: boolean) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (!keep || this.closed) this.entries.delete(key);
    else entry.pending = false;
  }
  release(key: string) {
    if (!this.entries.get(key)?.pending) this.entries.delete(key);
  }
  close() {
    this.closed = true;
    for (const [key, entry] of this.entries) if (!entry.pending) this.entries.delete(key);
  }
}
