import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the exact pure TypeScript helpers in memory; no browser or build outputs.
function loadHelper(name) {
  const source = readFileSync(
    new URL(`../../apps/web/components/game/${name}.ts`, import.meta.url),
    'utf8',
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  new Function('exports', 'require', outputText)(exports, (path) => {
    assert.equal(path, './camera-geometry');
    return loadHelper('camera-geometry');
  });
  return exports;
}
const { mapCamera, containRaster, mapRasterBounds, MIN_MAP_ZOOM, MAX_MAP_ZOOM } =
  loadHelper('map-camera');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const fixture = { viewportWidth: 1020, viewportHeight: 570, worldWidth: 384, worldHeight: 384 };

test('screenshot-sized square expands to viewport height with undistorted centered margins', () => {
  const c = mapCamera(fixture);
  close(c.scale, 570 / 384);
  close(c.x, 225);
  close(c.y, 0);
  close(fixture.worldWidth * c.scale, 570);
});
test('wide, tall and tiny maps contain-fit; actor position does not displace a fully visible map', () => {
  for (const [worldWidth, worldHeight] of [
    [2000, 400],
    [400, 2000],
    [48, 48],
    [1536, 768],
  ]) {
    const c = mapCamera({ ...fixture, worldWidth, worldHeight, focusX: 0, focusY: 0 });
    assert.ok(worldWidth * c.scale <= fixture.viewportWidth + 1e-8);
    assert.ok(worldHeight * c.scale <= fixture.viewportHeight + 1e-8);
    assert.ok(c.x >= -1e-8 && c.y >= -1e-8);
    assert.deepEqual(
      c,
      mapCamera({ ...fixture, worldWidth, worldHeight, focusX: worldWidth, focusY: worldHeight }),
    );
  }
});
test('manual zoom remains relative across mobile resize; reset restores whole scene', () => {
  for (const viewport of [
    { viewportWidth: 1020, viewportHeight: 570 },
    { viewportWidth: 320, viewportHeight: 480 },
    { viewportWidth: 844, viewportHeight: 390 },
  ]) {
    const options = { ...fixture, ...viewport, focusX: 370, focusY: 370 };
    const zoomed = mapCamera({ ...options, zoom: 2 });
    const reset = mapCamera({ ...options, zoom: 1 });
    close(zoomed.scale, reset.fitScale * 2);
    assert.ok(reset.x >= -1e-8 && reset.y >= -1e-8);
    for (const [position, extent, view] of [
      [zoomed.x, fixture.worldWidth * zoomed.scale, viewport.viewportWidth],
      [zoomed.y, fixture.worldHeight * zoomed.scale, viewport.viewportHeight],
    ]) {
      if (extent > view) assert.ok(position <= 0 && position >= view - extent);
      else close(position, (view - extent) / 2);
    }
  }
});
test('same world transform round-trips pointer coordinates at every supported zoom and resize', () => {
  for (const zoom of [MIN_MAP_ZOOM, 1, 1.8, MAX_MAP_ZOOM])
    for (const viewportWidth of [320, 1020]) {
      const c = mapCamera({ ...fixture, viewportWidth, zoom, focusX: 350, focusY: 350 });
      for (const p of [
        { x: 0, y: 0 },
        { x: 96, y: 144 },
        { x: 383.99, y: 383.99 },
      ]) {
        const screen = { x: p.x * c.scale + c.x, y: p.y * c.scale + c.y };
        close((screen.x - c.x) / c.scale, p.x);
        close((screen.y - c.y) / c.scale, p.y);
      }
    }
});
test('invalid dimensions remain finite and relative zoom is bounded', () => {
  for (const bad of [0, -1, NaN, Infinity]) {
    const c = mapCamera({
      viewportWidth: bad,
      viewportHeight: bad,
      worldWidth: bad,
      worldHeight: bad,
      zoom: bad,
    });
    assert.ok(Object.values(c).every(Number.isFinite));
    assert.ok(c.scale > 0);
  }
  close(mapCamera({ ...fixture, zoom: 100 }).scale / mapCamera(fixture).scale, MAX_MAP_ZOOM);
  close(mapCamera({ ...fixture, zoom: 0.1 }).scale / mapCamera(fixture).scale, MIN_MAP_ZOOM);
});
test('canvas preserves local pointer conversion and blur containment; mandatory grid is an independent overlay', () => {
  const source = readFileSync(
    new URL('../../apps/web/components/game/game-canvas.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /world\.toLocal\(event\.global\)/);
  assert.match(source, /background\?\.width \?\? texture\.width/);
  assert.match(source, /background\?\.height \?\? texture\.height/);
  assert.match(source, /event\.currentTarget\.contains\(event\.relatedTarget\)/);
  assert.match(source, /world\.scale\.set\(camera\.scale\)/);
  assert.match(source, /cameraScale: camera\.scale/);
  assert.match(source, /cameraX: camera\.x/);
  assert.match(source, /cameraY: camera\.y/);
  assert.match(source, /cameraZoom: zoomRef\.current/);
  assert.match(source, /onClick=\{\(\) => setZoom\(1\)\}/);
  assert.doesNotMatch(source, /gridVisible|showGrid|Сетка клеток/);
});

test('raster containment preserves aspect and centers letterboxing in world, independent of camera', () => {
  for (const [imageWidth, imageHeight, worldWidth, worldHeight] of [
    [1024, 1024, 768, 384],
    [1536, 1024, 384, 768],
    [1024, 1536, 768, 384],
    [1536, 1024, 768, 512],
  ]) {
    const r = containRaster(imageWidth, imageHeight, worldWidth, worldHeight);
    close(r.width / r.height, imageWidth / imageHeight);
    close(r.x * 2 + r.width, worldWidth);
    close(r.y * 2 + r.height, worldHeight);
    assert.ok(r.x >= -1e-8 && r.y >= -1e-8);
    assert.ok(r.width <= worldWidth + 1e-8 && r.height <= worldHeight + 1e-8);
    const camera = mapCamera({ viewportWidth: 320, viewportHeight: 480, worldWidth, worldHeight });
    close((r.width * camera.scale) / (r.height * camera.scale), imageWidth / imageHeight);
  }
});

test('legacy square artwork is contained without stretching; world coordinates are unchanged', () => {
  const map = { id: 'legacy', width: 16, height: 8 };
  const r = mapRasterBounds(1024, 1024, 768, 384, undefined, map);
  assert.deepEqual(r, { x: 192, y: 0, width: 384, height: 384 });
  for (const viewportWidth of [320, 1020]) {
    const c = mapCamera({ viewportWidth, viewportHeight: 570, worldWidth: 768, worldHeight: 384 });
    // Pixel at the old halfway landmark, layer origin and actor feet retain one world point.
    const world = { x: 384, y: 192 };
    close(r.x + r.width * 0.5, world.x);
    close(r.y + r.height * 0.5, world.y);
    const screen = { x: world.x * c.scale + c.x, y: world.y * c.scale + c.y };
    close((screen.x - c.x) / c.scale, world.x);
    close((screen.y - c.y) / c.scale, world.y);
  }
});
test('all raster paths contain without distortion, regardless of legacy framing metadata', () => {
  const map = { id: 'new', width: 16, height: 8 };
  const frame = {
    version: 1,
    mapId: 'new',
    mapWidth: 16,
    mapHeight: 8,
    width: 1536,
    height: 768,
    fit: 'contain',
  };
  assert.deepEqual(mapRasterBounds(1536, 768, 768, 384, frame, map), {
    x: 0,
    y: 0,
    width: 768,
    height: 384,
  });
  const fallback = { ...frame, width: 1024, height: 1024 };
  assert.deepEqual(mapRasterBounds(1024, 1024, 768, 384, fallback, map), {
    x: 192,
    y: 0,
    width: 384,
    height: 384,
  });
  for (const invalid of [
    { ...fallback, mapId: 'other' },
    { ...fallback, mapWidth: 12 },
    { ...fallback, width: 512 },
    { ...fallback, version: 2 },
  ])
    assert.deepEqual(mapRasterBounds(1024, 1024, 768, 384, invalid, map), {
      x: 192,
      y: 0,
      width: 384,
      height: 384,
    });
});
