import sharp from 'sharp';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '../config';
import { fail } from '../errors';
export const MAX_RASTER_BYTES = 5 * 1024 * 1024;
export interface NormalizedRaster {
  bytes: Buffer;
  width: number;
  height: number;
  sha256: string;
  mime: 'image/webp';
}
/** Sole upload/generated-image decoder: bounded static raster, no remote URLs or SVG decoder. */
export async function normalizeRaster(
  buffer: Buffer,
  mime: string,
  requireAlpha = false,
): Promise<NormalizedRaster> {
  if (
    !buffer.length ||
    buffer.length > MAX_RASTER_BYTES ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(mime)
  )
    fail(400, 'INVALID_RASTER', 'INVALID_RASTER');
  const png =
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const webp =
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP';
  if (!png && !jpeg && !webp) fail(400, 'INVALID_RASTER', 'INVALID_RASTER');
  try {
    const meta = await sharp(buffer, { limitInputPixels: 4096 * 4096 }).metadata();
    if (
      !['png', 'jpeg', 'webp'].includes(meta.format ?? '') ||
      !meta.width ||
      !meta.height ||
      meta.width > 4096 ||
      meta.height > 4096 ||
      (meta.pages ?? 1) > 1
    )
      fail(400, 'INVALID_RASTER', 'INVALID_RASTER');
    if (requireAlpha) {
      if (!meta.hasAlpha) fail(400, 'ALPHA_REQUIRED', 'ALPHA_REQUIRED');
      const alpha = await sharp(buffer, { limitInputPixels: 4096 * 4096 })
        .ensureAlpha()
        .extractChannel('alpha')
        .raw()
        .toBuffer();
      if (!alpha.some((v) => v < 255) || !alpha.some((v) => v > 0))
        fail(400, 'ALPHA_REQUIRED', 'ALPHA_REQUIRED');
    }
    const out = await sharp(buffer, { limitInputPixels: 4096 * 4096 })
      .rotate()
      .webp({ quality: 88 })
      .toBuffer({ resolveWithObject: true });
    if (out.data.length > MAX_RASTER_BYTES)
      fail(413, 'ASSET_QUOTA_EXCEEDED', 'ASSET_QUOTA_EXCEEDED');
    return {
      bytes: out.data,
      width: out.info.width,
      height: out.info.height,
      sha256: createHash('sha256').update(out.data).digest('hex'),
      mime: 'image/webp',
    };
  } catch (error) {
    if (error instanceof Error && 'getStatus' in error) throw error;
    return fail(400, 'INVALID_RASTER', 'INVALID_RASTER');
  }
}
export async function lockRasterQuota(
  c: PoolClient,
  ownerId: string,
  extraBytes: number,
  excludeJobId?: string,
) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `raster-quota:${ownerId}`,
  ]);
  if (
    !(await c.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [ownerId]))
      .rowCount
  )
    fail(401, 'UNAUTHORIZED', 'UNAUTHORIZED');
  const stored = (
    await c.query(
      'SELECT count(*)::int AS n,COALESCE(sum(bytes),0)::bigint AS bytes FROM assets WHERE owner_id=$1',
      [ownerId],
    )
  ).rows[0];
  const held = (
    await c.query(
      'SELECT count(*)::int AS n,COALESCE(sum(quota_reserved_bytes),0)::bigint AS bytes FROM image_generation_jobs WHERE actor_id=$1 AND quota_reserved_bytes>0 AND ($2::uuid IS NULL OR id<>$2)',
      [ownerId, excludeJobId ?? null],
    )
  ).rows[0];
  if (
    Number(stored.n) + Number(held.n) >= 200 ||
    Number(stored.bytes) + Number(held.bytes) + extraBytes > 100 * 1024 * 1024
  )
    fail(413, 'ASSET_QUOTA_EXCEEDED', 'ASSET_QUOTA_EXCEEDED');
}
/** Caller owns transaction and rollback cleanup. Existing same-ID file must match exactly. */
export async function storeRasterTx(
  c: PoolClient,
  ownerId: string,
  id: string,
  raster: NormalizedRaster,
  excludeJobId?: string,
) {
  await lockRasterQuota(c, ownerId, raster.bytes.length, excludeJobId);
  const filename = `${id}.webp`,
    filePath = resolve(config.ASSET_DIR, filename);
  await mkdir(resolve(config.ASSET_DIR), { recursive: true });
  try {
    await writeFile(filePath, raster.bytes, { flag: 'wx' });
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code !== 'EEXIST' ||
      createHash('sha256')
        .update(await readFile(filePath))
        .digest('hex') !== raster.sha256
    )
      throw e;
  }
  return (
    await c.query(
      "INSERT INTO assets(id,owner_id,filename,mime,width,height,bytes,sha256) VALUES($1,$2,$3,'image/webp',$4,$5,$6,$7) RETURNING id,mime,width,height,created_at",
      [id, ownerId, filename, raster.width, raster.height, raster.bytes.length, raster.sha256],
    )
  ).rows[0];
}
