import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import sharp from 'sharp';
import type { PoolClient } from 'pg';
import { config } from '../config';
import { AssetReuseService } from '../assets/reuse.service';
import { fail } from '../errors';
import { storyMapImageSchema, type StoryMapImage } from '../ai/story-vision';
/** Read only already-authorized immutable raster revisions. Never fetch a caller URL. */
export async function prepareStoryMapImages(
  c: PoolClient,
  assets: AssetReuseService,
  owner: string,
  images: { location_id: string; revision_id: string }[],
): Promise<StoryMapImage[]> {
  if (images.length > 4) fail(400, 'STORY_PLAN_CAPACITY', 'STORY_PLAN_CAPACITY');
  const result: StoryMapImage[] = [];
  for (const image of images) {
    const { row } = await assets.reusableRevisionTx(c, owner, image.revision_id);
    if (
      !row.filename ||
      basename(row.filename) !== row.filename ||
      row.metadata.kind !== 'background' ||
      row.metadata.camera !== 'top-down'
    )
      fail(409, 'MAP_IMAGE_UNAVAILABLE', 'MAP_IMAGE_UNAVAILABLE');
    const bytes = await readFile(resolve(config.ASSET_DIR, row.filename!)).catch(() =>
      fail(409, 'MAP_IMAGE_UNAVAILABLE', 'MAP_IMAGE_UNAVAILABLE'),
    );
    if (
      bytes.length > 5 * 1024 * 1024 ||
      createHash('sha256').update(bytes).digest('hex') !== row.sha256
    )
      fail(409, 'ASSET_INTEGRITY_FAILED', 'ASSET_INTEGRITY_FAILED');
    // Same contain framing as the map renderer; padding is not playable floor.
    // Analysis-only coordinate guide matches the engine grid; original artwork is unchanged.
    const digits = [
      '111101101101111',
      '010110010010111',
      '111001111100111',
      '111001111001111',
      '101101111001001',
      '111100111001111',
      '111100111101111',
      '111001001001001',
      '111101111101111',
      '111101111001111',
    ];
    const label = (number: number, x: number, y: number) =>
      [...String(number)]
        .map((digit, index) =>
          [...digits[Number(digit)]]
            .map((bit, cell) =>
              bit === '1'
                ? `<rect x="${x + index * 8 + (cell % 3) * 2}" y="${y + Math.floor(cell / 3) * 2}" width="2" height="2"/>`
                : '',
            )
            .join(''),
        )
        .join('');
    const guide = Buffer.from(`<svg width="768" height="768" xmlns="http://www.w3.org/2000/svg">
      <g stroke="white" stroke-opacity="0.35" stroke-width="0.6">${Array.from(
        { length: 25 },
        (_, i) => `<path d="M ${i * 32} 0 V 768 M 0 ${i * 32} H 768"/>`,
      ).join('')}</g>
      <g fill="white" stroke="black" stroke-width="0.4">${Array.from(
        { length: 24 },
        (_, i) => label(i, i * 32 + 9, 2) + label(i, 2, i * 32 + 11),
      ).join('')}</g>
    </svg>`);
    const raster = await sharp(bytes, { limitInputPixels: 4096 * 4096 })
      .resize(768, 768, { fit: 'contain', background: '#000000' })
      .flatten({ background: '#000000' })
      .composite([{ input: guide, top: 0, left: 0 }])
      .jpeg({ quality: 85 })
      .toBuffer();
    result.push(
      storyMapImageSchema.parse({
        locationId: image.location_id,
        revisionId: image.revision_id,
        sha256: row.sha256,
        inputSha256: createHash('sha256').update(raster).digest('hex'),
        width: 768,
        height: 768,
        framing: 'contain-24x24',
        dataUrl: 'data:image/jpeg;base64,' + raster.toString('base64'),
      }),
    );
  }
  return result;
}
