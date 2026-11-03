import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { gameIdSchema, type RuntimeMapView } from '@dreamwalk/game-core';

const OUTPUT_SIZE = 768;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_EDGE = 4096;
const MASK = [16, 20, 27] as const;
const pointSchema = z
  .object({ x: z.number().int().min(0).max(63), y: z.number().int().min(0).max(63) })
  .strict();
const viewSchema = z
  .object({
    version: z.literal(1),
    mapId: gameIdSchema,
    width: z.number().int().min(1).max(64),
    height: z.number().int().min(1).max(64),
    mapRevision: z.number().int().nonnegative(),
    observerIds: z.array(gameIdSchema).min(1).max(256),
    visibleCells: z.array(pointSchema).max(4096),
    markers: z
      .array(
        z
          .object({
            marker: z.number().int().min(1).max(4096),
            id: gameIdSchema,
            kind: z.enum(['player', 'npc', 'item', 'door']),
            label: z.string().max(120).optional(),
            x: z.number().int().min(0).max(63),
            y: z.number().int().min(0).max(63),
            occupiedCells: z.array(pointSchema).min(1).max(9),
          })
          .strict(),
      )
      .max(4096),
  })
  .strict();

export interface RuntimeMapImageIdentity {
  revisionId: string;
  sha256: string;
}
export interface RuntimeMapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface RuntimeMapTransform {
  fit: 'contain';
  origin: 'top-left';
  xDirection: 'right';
  yDirection: 'down';
  squareCells: number;
  cellPixels: number;
  /** Both rectangles are in the 768-square output's pixel coordinates. */
  mapRect: RuntimeMapRect;
  imageRect: RuntimeMapRect;
  sourceWidth: number;
  sourceHeight: number;
}
export interface RuntimeMapRaster extends RuntimeMapImageIdentity {
  inputSha256: string;
  width: 768;
  height: 768;
  dataUrl: string;
  view: RuntimeMapView;
  transform: RuntimeMapTransform;
}

/** Same contain convention as the web map camera, within the top-left map rectangle.
 * The square is the renderer's max(24, map.width, map.height) world, not the image.
 */
export function runtimeMapTransform(
  map: Pick<RuntimeMapView, 'width' | 'height'>,
  sourceWidth: number,
  sourceHeight: number,
): RuntimeMapTransform {
  if (
    ![map.width, map.height, sourceWidth, sourceHeight].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    map.width > 64 ||
    map.height > 64 ||
    sourceWidth > MAX_EDGE ||
    sourceHeight > MAX_EDGE
  )
    throw new Error('RUNTIME_MAP_INVALID_GEOMETRY');
  const squareCells = Math.max(24, map.width, map.height);
  const cellPixels = OUTPUT_SIZE / squareCells;
  const mapRect = { x: 0, y: 0, width: map.width * cellPixels, height: map.height * cellPixels };
  const scale = Math.min(mapRect.width / sourceWidth, mapRect.height / sourceHeight);
  const width = sourceWidth * scale,
    height = sourceHeight * scale;
  return {
    fit: 'contain',
    origin: 'top-left',
    xDirection: 'right',
    yDirection: 'down',
    squareCells,
    cellPixels,
    mapRect,
    imageRect: { x: (mapRect.width - width) / 2, y: (mapRect.height - height) / 2, width, height },
    sourceWidth,
    sourceHeight,
  };
}

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const pointKey = ({ x, y }: { x: number; y: number }) => `${x},${y}`;

function checkedView(input: RuntimeMapView): RuntimeMapView {
  const view = viewSchema.parse(input);
  const keys = new Set(view.visibleCells.map(pointKey));
  if (
    keys.size !== view.visibleCells.length ||
    new Set(view.observerIds).size !== view.observerIds.length ||
    view.visibleCells.some((cell) => cell.x >= view.width || cell.y >= view.height) ||
    new Set(view.markers.map((marker) => marker.marker)).size !== view.markers.length ||
    new Set(view.markers.map((marker) => marker.id)).size !== view.markers.length ||
    view.markers.some(
      (marker) =>
        !keys.has(pointKey(marker)) ||
        new Set(marker.occupiedCells.map(pointKey)).size !== marker.occupiedCells.length ||
        !marker.occupiedCells.some((cell) => cell.x === marker.x && cell.y === marker.y) ||
        marker.occupiedCells.some((cell) => !keys.has(pointKey(cell))),
    )
  )
    throw new Error('RUNTIME_MAP_INVALID_VIEW');
  return view;
}

/** Fixed vector digits avoid font files/caches and host-dependent font substitution. */
function numericDigits(
  value: number,
  centerX: number,
  centerY: number,
  height: number,
  color: string,
  outline = false,
): string {
  const segments = [
    [0, 0, 1, 0],
    [1, 0, 1, 0.5],
    [1, 0.5, 1, 1],
    [0, 1, 1, 1],
    [0, 0.5, 0, 1],
    [0, 0, 0, 0.5],
    [0, 0.5, 1, 0.5],
  ];
  const digits = [
    '012345',
    '12',
    '01643',
    '01263',
    '5612',
    '05623',
    '054326',
    '012',
    '0123456',
    '012356',
  ];
  const text = String(value),
    width = height * 0.55,
    gap = height * 0.2;
  const left = centerX - (text.length * width + (text.length - 1) * gap) / 2;
  const paths = [...text]
    .map((digit, index) => {
      const x = left + index * (width + gap),
        y = centerY - height / 2;
      return [...digits[Number(digit)]]
        .map((segment) => {
          const [x1, y1, x2, y2] = segments[Number(segment)];
          return `M ${x + x1 * width} ${y + y1 * height} L ${x + x2 * width} ${y + y2 * height}`;
        })
        .join(' ');
    })
    .join(' ');
  const stroke = Math.max(0.65, height * 0.12);
  return `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${outline ? `<path d="${paths}" stroke="#10141b" stroke-width="${stroke + 2}"/>` : ''}<path d="${paths}" stroke="${color}" stroke-width="${stroke}"/></g>`;
}

/** Trusted numeric geometry only: no label, ID, URL, author text or image href enters SVG. */
function numericGuide(view: RuntimeMapView, transform: RuntimeMapTransform): Buffer {
  const unit = transform.cellPixels;
  const parts: string[] = [];
  for (let x = 0; x <= view.width; x++)
    parts.push(`<path d="M ${x * unit} 0 V ${view.height * unit}"/>`);
  for (let y = 0; y <= view.height; y++)
    parts.push(`<path d="M 0 ${y * unit} H ${view.width * unit}"/>`);
  const labels: string[] = [];
  const digitHeight = Math.min(8, unit * 0.3);
  for (let x = 0; x < view.width; x++)
    labels.push(
      numericDigits(x, (x + 0.5) * unit, digitHeight / 2 + 3, digitHeight, '#ffffff', true),
    );
  for (let y = 1; y < view.height; y++)
    labels.push(
      numericDigits(y, Math.min(9, unit * 0.4), (y + 0.5) * unit, digitHeight, '#ffffff', true),
    );
  const colors = { player: '#5bc0ff', npc: '#ffbc69', item: '#f5e779', door: '#c8d0db' };
  const markers = view.markers.map((marker) => {
    const right = Math.max(...marker.occupiedCells.map((cell) => cell.x)) + 1;
    const bottom = Math.max(...marker.occupiedCells.map((cell) => cell.y)) + 1;
    const x = ((marker.x + right) * unit) / 2,
      y = ((marker.y + bottom) * unit) / 2;
    const radius = Math.max(4, Math.min(13, unit * 0.33));
    const length = String(marker.marker).length;
    const height = Math.min(radius * 1.1, (radius * 1.5) / (length * 0.55 + (length - 1) * 0.2));
    return `<g fill="${colors[marker.kind]}" stroke="#10141b" stroke-width="1.5">${marker.occupiedCells.map((cell) => `<rect x="${cell.x * unit + 1}" y="${cell.y * unit + 1}" width="${unit - 2}" height="${unit - 2}" fill-opacity="0.2"/>`).join('')}<circle cx="${x}" cy="${y}" r="${radius}"/>${numericDigits(marker.marker, x, y, height, '#10141b')}</g>`;
  });
  return Buffer.from(
    `<svg width="768" height="768" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="0.6">${parts.join('')}</g>${labels.join('')}${markers.join('')}</svg>`,
  );
}

/** Pure compositor: caller must authorize and pin the immutable raster beforehand.
 * No file/DB/network reads, no terrain classification and no collision/safety claims.
 * Only perceived source samples are copied to a raw output. Nearest sampling avoids
 * resize-kernel leakage from hidden source pixels; masking precedes all compression.
 */
export async function renderRuntimeMapRaster(
  bytes: Buffer,
  identity: RuntimeMapImageIdentity,
  input: RuntimeMapView,
): Promise<RuntimeMapRaster> {
  const view = checkedView(input);
  const pinned = z
    .object({ revisionId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .parse(identity);
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES)
    throw new Error('RUNTIME_MAP_INVALID_RASTER');
  // Snapshot before the first await: mutation by the caller cannot race the hash/decode.
  const source = Buffer.from(bytes);
  if (hash(source) !== pinned.sha256) throw new Error('RUNTIME_MAP_IMAGE_INTEGRITY_FAILED');
  const png = source.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = source[0] === 255 && source[1] === 216 && source[2] === 255;
  const webp =
    source.toString('ascii', 0, 4) === 'RIFF' && source.toString('ascii', 8, 12) === 'WEBP';
  if (!png && !jpeg && !webp) throw new Error('RUNTIME_MAP_INVALID_RASTER');
  let decoded;
  try {
    const image = sharp(source, { limitInputPixels: MAX_EDGE * MAX_EDGE, failOn: 'warning' });
    const metadata = await image.metadata();
    if (
      !['png', 'jpeg', 'webp'].includes(metadata.format ?? '') ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_EDGE ||
      metadata.height > MAX_EDGE ||
      (metadata.pages ?? 1) > 1
    )
      throw new Error('RUNTIME_MAP_INVALID_RASTER');
    decoded = await image
      .rotate()
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new Error('RUNTIME_MAP_INVALID_RASTER');
  }
  const transform = runtimeMapTransform(view, decoded.info.width, decoded.info.height);
  const { imageRect, cellPixels } = transform;
  const perceived = new Set(view.visibleCells.map(pointKey));
  const canvas = Buffer.alloc(OUTPUT_SIZE * OUTPUT_SIZE * 3);
  for (let y = 0; y < OUTPUT_SIZE; y++)
    for (let x = 0; x < OUTPUT_SIZE; x++) {
      const offset = (y * OUTPUT_SIZE + x) * 3;
      let sourceOffset = -1;
      if (
        perceived.has(
          `${Math.floor((x + 0.5) / cellPixels)},${Math.floor((y + 0.5) / cellPixels)}`,
        ) &&
        x + 0.5 >= imageRect.x &&
        x + 0.5 < imageRect.x + imageRect.width &&
        y + 0.5 >= imageRect.y &&
        y + 0.5 < imageRect.y + imageRect.height
      ) {
        const sx = Math.floor(((x + 0.5 - imageRect.x) * decoded.info.width) / imageRect.width);
        const sy = Math.floor(((y + 0.5 - imageRect.y) * decoded.info.height) / imageRect.height);
        // A source pixel itself must belong to a perceived cell, even at fractional boundaries.
        const cellX = Math.floor(
          (imageRect.x + ((sx + 0.5) * imageRect.width) / decoded.info.width) / cellPixels,
        );
        const cellY = Math.floor(
          (imageRect.y + ((sy + 0.5) * imageRect.height) / decoded.info.height) / cellPixels,
        );
        if (perceived.has(`${cellX},${cellY}`)) sourceOffset = (sy * decoded.info.width + sx) * 4;
      }
      const alpha = sourceOffset < 0 ? 0 : decoded.data[sourceOffset + 3] / 255;
      for (let channel = 0; channel < 3; channel++)
        canvas[offset + channel] =
          sourceOffset < 0
            ? MASK[channel]
            : Math.round(
                decoded.data[sourceOffset + channel] * alpha + MASK[channel] * (1 - alpha),
              );
    }
  const raster = await sharp(canvas, {
    raw: { width: OUTPUT_SIZE, height: OUTPUT_SIZE, channels: 3 },
  })
    .composite([{ input: numericGuide(view, transform) }])
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4', progressive: false, mozjpeg: false })
    .toBuffer();
  return {
    ...pinned,
    inputSha256: hash(raster),
    width: OUTPUT_SIZE,
    height: OUTPUT_SIZE,
    dataUrl: `data:image/jpeg;base64,${raster.toString('base64')}`,
    view,
    transform,
  };
}
