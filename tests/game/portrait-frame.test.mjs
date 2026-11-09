import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  portraitFrameSchema,
  portraitCropRect,
  defaultPortraitFrame,
  portraitFrameLayout,
  heroSchema,
  npcSchema,
} from '../../packages/contracts/dist/index.js';
import { framedPortrait } from '../../apps/api/src/game/portrait-frame.ts';

test('a portrait frame is a bounded focal point and zoom; unknown keys are refused', () => {
  assert.ok(portraitFrameSchema.safeParse({ x: 0, y: 1, zoom: 4 }).success);
  for (const bad of [
    { x: -0.1, y: 0.5, zoom: 1 },
    { x: 0.5, y: 1.1, zoom: 1 },
    { x: 0.5, y: 0.5, zoom: 0.9 },
    { x: 0.5, y: 0.5, zoom: 4.1 },
    { x: 0.5, y: 0.5, zoom: 1, extra: true },
    { x: 'a', y: 0.5, zoom: 1 },
  ])
    assert.equal(portraitFrameSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('heroes and NPCs carry an optional frame without changing existing data', () => {
  const hero = heroSchema.parse({ name: 'Hero' });
  assert.equal(
    'portraitFrame' in hero,
    false,
    'absent stays absent (pinned snapshots keep their digest)',
  );
  assert.deepEqual(
    heroSchema.parse({ name: 'Hero', portraitFrame: { x: 0.5, y: 0.2, zoom: 2 } }).portraitFrame,
    { x: 0.5, y: 0.2, zoom: 2 },
  );
  assert.equal(npcSchema.parse({ name: 'Npc', portraitFrame: null }).portraitFrame, null);
  assert.throws(() => npcSchema.parse({ name: 'Npc', portraitFrame: { x: 2, y: 0, zoom: 1 } }));
});

test('crop rectangle: default crop is unchanged and a frame selects a bounded square', () => {
  assert.deepEqual(portraitCropRect(400, 800), { sx: 0, sy: 100, side: 400 });
  assert.deepEqual(portraitCropRect(800, 400), { sx: 200, sy: 0, side: 400 });
  assert.deepEqual(portraitCropRect(400, 800, { x: 0.5, y: 0.1, zoom: 2 }), {
    sx: 100,
    sy: 0,
    side: 200,
  });
  // The square never leaves the image, however extreme the focal point.
  const edge = portraitCropRect(400, 800, { x: 1, y: 1, zoom: 4 });
  assert.deepEqual(edge, { sx: 300, sy: 700, side: 100 });
  const huge = portraitCropRect(400, 800, { x: 0.5, y: 0.5, zoom: 99 });
  assert.equal(huge.side, 100, 'zoom is capped at 4');
});

test('the default frame reproduces the default crop; layout percentages place the image', () => {
  for (const [w, h] of [
    [400, 800],
    [800, 400],
    [500, 500],
  ]) {
    const frame = defaultPortraitFrame(w, h),
      a = portraitCropRect(w, h),
      b = portraitCropRect(w, h, frame);
    assert.ok(
      Math.abs(a.sx - b.sx) < 1 && Math.abs(a.sy - b.sy) < 1 && a.side === b.side,
      `${w}x${h}`,
    );
  }
  assert.deepEqual(portraitFrameLayout(400, 800, { x: 0.5, y: 0.1, zoom: 2 }), {
    width: '200%',
    height: '400%',
    left: '-50%',
    top: '0%',
  });
});

async function portrait() {
  // 200x400: red top half, blue bottom half.
  const top = await sharp({
    create: { width: 200, height: 200, channels: 3, background: '#ff0000' },
  })
    .png()
    .toBuffer();
  const bottom = await sharp({
    create: { width: 200, height: 200, channels: 3, background: '#0000ff' },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width: 200, height: 400, channels: 3, background: '#000000' } })
    .composite([
      { input: top, top: 0, left: 0 },
      { input: bottom, top: 200, left: 0 },
    ])
    .png()
    .toBuffer();
}
const dominant = async (bytes) => {
  const { dominant } = await sharp(bytes).stats();
  return dominant;
};

test('hero portraits are cut server-side to the chosen part; invalid frames fall back safely', async () => {
  const bytes = await portrait();
  const upper = await framedPortrait(bytes, { x: 0.5, y: 0.1, zoom: 1 });
  const lower = await framedPortrait(bytes, { x: 0.5, y: 0.9, zoom: 1 });
  const meta = await sharp(upper).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, meta.height, 'a square');
  assert.ok(
    (await dominant(upper)).r > 200 && (await dominant(upper)).b < 60,
    'the upper part is red',
  );
  assert.ok(
    (await dominant(lower)).b > 200 && (await dominant(lower)).r < 60,
    'the lower part is blue',
  );
  const zoomed = await sharp(await framedPortrait(bytes, { x: 0.5, y: 0.1, zoom: 4 })).metadata();
  assert.equal(zoomed.width, 50);
  // No frame, a malformed frame or undecodable bytes: the original bytes are returned untouched.
  assert.equal(await framedPortrait(bytes, null), bytes);
  assert.equal(await framedPortrait(bytes, { x: 9, y: 0, zoom: 1 }), bytes);
  const junk = Buffer.from('not an image');
  assert.equal(await framedPortrait(junk, { x: 0.5, y: 0.5, zoom: 1 }), junk);
});
