/** Immutable bundled asset allowlist. No server/user URL is ever loaded. */
export const prototypeAtlas = {
  id: 'observatory-prototype-atlas-v1',
  sha256: 'dbfdb127d64aabc022b094d261ecb3825a1760e4301e3f2abeb73f9cd0c47886',
  path: '/game/observatory-atlas.dbfdb127.svg',
} as const;
export function resolveGameAtlas(manifest?: { id: string; sha256: string }): string {
  if (!manifest || (manifest.id === prototypeAtlas.id && manifest.sha256 === prototypeAtlas.sha256))
    return prototypeAtlas.path;
  throw new Error('Unsupported bundled game atlas');
}
