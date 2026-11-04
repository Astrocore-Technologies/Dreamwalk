import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { mapCamera } from '../../apps/web/components/game/map-camera.ts';
import {
  MAP_RULER_SIZE,
  mapCoordinateAt,
  mapCoordinateTicks,
} from '../../apps/web/components/game/map-coordinates.ts';
import {
  runtimeMapTransform,
  runtimeMapCoordinateLabels,
  renderRuntimeMapRaster,
} from '../../apps/api/src/game/runtime-map-raster.ts';

test('cell readout is zero-based x-right/y-down and rejects padding and invalid points', () => {
  const map = { width: 24, height: 16 };
  for (const [x, y] of [
    [0, 0],
    [2, 3],
    [23, 15],
  ]) {
    assert.deepEqual(mapCoordinateAt({ x: (x + 0.5) * 48, y: (y + 0.5) * 48 }, map, 48), { x, y });
  }
  assert.deepEqual(mapCoordinateAt({ x: 48, y: 96 }, map, 48), { x: 1, y: 2 });
  for (const point of [
    { x: -0.1, y: 0 },
    { x: 0, y: -0.1 },
    { x: 24 * 48, y: 0 },
    { x: 0, y: 16 * 48 },
    { x: NaN, y: 0 },
    { x: 0, y: Infinity },
  ])
    assert.equal(mapCoordinateAt(point, map, 48), null);
});

test('mobile, desktop, zoom and camera follow keep rulers on the actual engine cell centers', () => {
  for (const [viewportWidth, viewportHeight] of [
    [320, 360],
    [390, 600],
    [1200, 720],
  ]) {
    for (const zoom of [0.6, 1, 2, 3]) {
      for (const focus of [
        { x: 0, y: 0 },
        { x: 11, y: 8 },
        { x: 23, y: 23 },
      ]) {
        const camera = mapCamera({
          viewportWidth,
          viewportHeight,
          worldWidth: 1152,
          worldHeight: 1152,
          zoom,
          focusX: (focus.x + 0.5) * 48,
          focusY: (focus.y + 0.5) * 48,
        });
        for (const axis of ['x', 'y']) {
          const extent = axis === 'x' ? viewportWidth : viewportHeight;
          const ticks = mapCoordinateTicks(24, camera[axis], camera.scale * 48, extent);
          assert.ok(ticks.length > 0);
          for (const tick of ticks) {
            assert.equal(tick.position, camera[axis] + (tick.value + 0.5) * 48 * camera.scale);
            assert.ok(tick.position >= 0 && tick.position < extent - MAP_RULER_SIZE);
            assert.ok(tick.value >= 0 && tick.value < 24);
          }
          const labels = ticks.filter((tick) => tick.label);
          for (let i = 1; i < labels.length; i++) {
            assert.ok(labels[i].position - labels[i - 1].position >= 26 - 1e-9);
          }
        }
      }
    }
  }
});

test('rulers include zero, distinguish x from y, never label the padded 24-cell world', () => {
  const columns = mapCoordinateTicks(12, 30, 32, 900);
  const rows = mapCoordinateTicks(9, 70, 32, 900);
  assert.deepEqual(
    columns.map((tick) => tick.value),
    Array.from({ length: 12 }, (_, i) => i),
  );
  assert.deepEqual(
    rows.map((tick) => tick.value),
    Array.from({ length: 9 }, (_, i) => i),
  );
  assert.equal(columns[0].position, 46);
  assert.equal(rows[0].position, 86);
  assert.equal(columns[2].position, 110);
  assert.equal(rows[3].position, 182);
  assert.equal(mapCoordinateTicks(64, 0, 4, 320).filter((tick) => tick.label)[0].value, 0);
  assert.deepEqual(mapCoordinateTicks(65, 0, 32, 900), []);
  assert.deepEqual(mapCoordinateTicks(24, NaN, 32, 900), []);
  assert.deepEqual(mapCoordinateTicks(24, 0, 0, 900), []);
  assert.deepEqual(mapCoordinateTicks(24, 0, 32, 0), []);
});

test('AI raster and player rulers use identical 0-based cells for origin, sample and last cells', () => {
  for (const map of [
    { width: 24, height: 24 },
    { width: 12, height: 9 },
    { width: 64, height: 64 },
  ]) {
    const transform = runtimeMapTransform(map, 512, 288);
    const labels = runtimeMapCoordinateLabels(map, transform);
    assert.equal(labels.x.length, map.width);
    assert.equal(labels.y.length, map.height);
    assert.equal(labels.x[0].value, 0);
    assert.equal(labels.y[0].value, 0);
    for (const [x, y] of [
      [0, 0],
      [2, 3],
      [map.width - 1, map.height - 1],
    ]) {
      const coordinate = mapCoordinateAt({ x: (x + 0.5) * 48, y: (y + 0.5) * 48 }, map, 48);
      assert.equal(labels.x[x].value, coordinate.x);
      assert.equal(labels.y[y].value, coordinate.y);
      assert.equal(labels.x[x].x, (x + 0.5) * transform.cellPixels);
      assert.equal(labels.y[y].y, (y + 0.5) * transform.cellPixels);
    }
    // Both zero glyphs have separate horizontal bounds even on a 64-cell map.
    const xZeroLeft = labels.x[0].x - (labels.x[0].height * 0.55) / 2;
    const yZeroRight = labels.y[0].x + (labels.y[0].height * 0.55) / 2;
    assert.ok(yZeroRight < xZeroLeft);
    for (const label of [...labels.x, ...labels.y]) {
      assert.ok(label.x > 0 && label.x < transform.mapRect.width);
      assert.ok(label.y > 0 && label.y < transform.mapRect.height);
      assert.ok(label.height >= 5.4 && label.height <= 10);
    }
  }
});

test('coordinate overlays do not reveal hidden raster pixels or hidden entity information', async () => {
  const view = {
    version: 1,
    mapId: 'room',
    width: 24,
    height: 24,
    mapRevision: 0,
    observerIds: ['hero'],
    visibleCells: [],
    markers: [],
  };
  const rendered = [];
  for (const color of ['#ff0000', '#00ff00']) {
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: color } })
      .png()
      .toBuffer();
    rendered.push(
      await renderRuntimeMapRaster(
        bytes,
        {
          revisionId: '123e4567-e89b-42d3-a456-426614174000',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        view,
      ),
    );
  }
  assert.equal(rendered[0].dataUrl, rendered[1].dataUrl);
  assert.deepEqual(rendered[0].view, view);
  const { data, info } = await sharp(Buffer.from(rendered[0].dataUrl.split(',')[1], 'base64'))
    .raw()
    .toBuffer({ resolveWithObject: true });
  // White vector strokes for x=0 and y=0 remain visibly present over unknown cells.
  for (const { x, y } of [
    { x: 16, y: 1 },
    { x: 4, y: 11 },
  ]) {
    const pixel = data.subarray(
      (y * info.width + x) * info.channels,
      (y * info.width + x) * info.channels + 3,
    );
    assert.ok(
      [...pixel].every((value) => value > 150),
      `Origin label at ${x},${y}`,
    );
  }
});

test('coordinate overlay is passive, scoped to current map, and preserves renderer pause lifecycle', () => {
  const source = readFileSync(
    new URL('../../apps/web/components/game/game-canvas.tsx', import.meta.url),
    'utf8',
  );
  const css = readFileSync(
    new URL('../../apps/web/components/game/game.module.css', import.meta.url),
    'utf8',
  );
  assert.match(source, /pointedCell\?\.mapId === projection.map.id/);
  assert.match(source, /world\.on\('pointermove'/);
  assert.match(source, /world\.on\('pointerleave', clearPointedCell\)/);
  assert.match(source, /if \(event.pointerType !== 'touch'\) setPointedCell\(null\)/);
  assert.match(source, /pointToCell\(local\)/);
  assert.match(source, /mapCoordinateTicks/);
  assert.match(source, /app\.canvas\.removeEventListener\('pointerleave', clearPointedCell\)/);
  assert.match(source, /coordinateKey = nextCoordinateKey/);
  assert.match(source, /ref=\{coordinateRulers\}[^>]+aria-hidden="true"/);
  assert.match(css, /\.mapCoordinates\s*\{[^}]*pointer-events: none/s);
  assert.match(css, /\.mapCoordinateReadout\s*\{[^}]*font: 11px/s);
  assert.doesNotMatch(source, /showCoordinates|setShowCoordinates|coordinateMenu/);
});

test('document-wide Pixi pointer movement over HTML controls cannot masquerade as a canvas hover', () => {
  const source = readFileSync(
    new URL('../../apps/web/components/game/game-canvas.tsx', import.meta.url),
    'utf8',
  );
  const start = source.indexOf("      world.on('pointermove', (event) => {");
  const end = source.indexOf("      world.on('pointerleave'", start);
  assert.ok(start > 0 && end > start);
  let pointerMove;
  const world = {
    on: (name, callback) => {
      assert.equal(name, 'pointermove');
      pointerMove = callback;
    },
    toLocal: (point) => point,
  };
  const canvas = {},
    button = {};
  const calls = [];
  new Function('world', 'app', 'pointToCell', 'clearPointedCell', source.slice(start, end))(
    world,
    { canvas },
    (point) => calls.push(['cell', point]),
    (event) => calls.push(['leave', event.pointerType]),
  );
  const global = { x: 120, y: 168 };
  pointerMove({ nativeEvent: { target: button }, pointerType: 'mouse', global });
  assert.deepEqual(calls, [['leave', 'mouse']]);
  calls.length = 0;
  pointerMove({ nativeEvent: { target: canvas }, pointerType: 'mouse', global });
  assert.deepEqual(calls, [['cell', global]]);
  calls.length = 0;
  pointerMove({ nativeEvent: { target: canvas }, pointerType: 'touch', global });
  assert.deepEqual(calls, [['cell', global]]);
  calls.length = 0;
  pointerMove({ nativeEvent: { target: button }, pointerType: 'touch', global });
  assert.deepEqual(
    calls,
    [['leave', 'touch']],
    'Touch persistence remains with the existing leave handler',
  );
});
