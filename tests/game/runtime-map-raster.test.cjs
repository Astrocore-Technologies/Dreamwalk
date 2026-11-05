/** Synthetic rasters only. No file, database, provider or network work. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { runtimeMapView, occupiedCells } = require('../../packages/game-core/dist');
const {
  runtimeMapTransform,
  renderRuntimeMapRaster,
} = require('../../apps/api/dist/game/runtime-map-raster');
const revisionId = '123e4567-e89b-42d3-a456-426614174000';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const actor = (id, x, y, extra = {}) => ({
  id,
  kind: 'player',
  x,
  y,
  mapId: 'room',
  revision: 0,
  ...extra,
});
function fixture(width = 16, height = 9) {
  return {
    schemaVersion: 1,
    rulesetVersion: 'hybrid-v3',
    seed: 1,
    tick: 0,
    revision: 0,
    maps: {
      room: {
        id: 'room',
        width,
        height,
        revision: 2,
        blocked: [],
        spawns: [{ x: 7, y: 4 }],
        exits: [],
      },
      elsewhere: {
        id: 'elsewhere',
        width: 16,
        height: 9,
        revision: 0,
        blocked: [],
        spawns: [{ x: 1, y: 1 }],
        exits: [],
      },
    },
    entities: { hero: actor('hero', 7, 4, { label: 'Public hero' }) },
    encounters: {},
  };
}
async function image(width = 512, height = 288, color = '#ad4567') {
  return sharp({ create: { width, height, channels: 4, background: color } })
    .png()
    .toBuffer();
}
async function render(bytes, view) {
  return renderRuntimeMapRaster(bytes, { revisionId, sha256: hash(bytes) }, view);
}
const decode = (raster) =>
  sharp(Buffer.from(raster.dataUrl.split(',')[1], 'base64'))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
const pixel = (decoded, x, y) => [
  ...decoded.data.subarray((y * decoded.info.width + x) * 3, (y * decoded.info.width + x) * 3 + 3),
];

test('contain transform preserves rectangular map and image aspects inside a top-left minimum 24-cell square', () => {
  const wide = runtimeMapTransform({ width: 16, height: 9 }, 400, 400);
  assert.equal(wide.squareCells, 24);
  assert.equal(wide.cellPixels, 32);
  assert.deepEqual(wide.mapRect, { x: 0, y: 0, width: 512, height: 288 });
  assert.deepEqual(wide.imageRect, { x: 112, y: 0, width: 288, height: 288 });
  const tall = runtimeMapTransform({ width: 9, height: 32 }, 1600, 900);
  assert.equal(tall.squareCells, 32);
  assert.equal(tall.cellPixels, 24);
  assert.deepEqual(tall.mapRect, { x: 0, y: 0, width: 216, height: 768 });
  assert.equal(tall.imageRect.x, 0);
  assert.equal(tall.imageRect.y, 323.25);
  assert.equal(tall.imageRect.width, 216);
  assert.ok(Math.abs(tall.imageRect.height - 121.5) < 1e-9);
  assert.ok(Math.abs(tall.imageRect.width / tall.imageRect.height - 1600 / 900) < 1e-9);
  assert.equal(tall.fit, 'contain');
  assert.equal(tall.origin, 'top-left');
  assert.equal(tall.xDirection, 'right');
  assert.equal(tall.yDirection, 'down');
  for (const [w, h] of [
    [0, 12],
    [65, 12],
    [3.5, 12],
    [NaN, 12],
  ])
    assert.throws(() => runtimeMapTransform({ width: w, height: h }, 20, 20), /GEOMETRY/);
});

test('projection uses only current runtime public positions and removes inventories, secrets, drafts and other maps', () => {
  const state = fixture();
  state.entities.npc = actor('npc', 8, 4, {
    kind: 'npc',
    label: 'Public keeper',
    inventory: ['secret-token'],
    knownIds: ['PRIVATE'],
    itemStock: { secrets: 'PRIVATE' },
  });
  state.entities['secret-token'] = actor('secret-token', 8, 4, {
    kind: 'item',
    ownerId: 'npc',
    label: 'PRIVATE',
  });
  state.entities.remote = actor('remote', 8, 4, { mapId: 'elsewhere', label: 'PRIVATE' });
  state.npcBrains = { npc: { facts: ['PRIVATE'], privateBiography: 'PRIVATE' } };
  state.authorDraft = { labels: ['PRIVATE'] };
  const before = structuredClone(state);
  const view = runtimeMapView(state, ['hero']);
  assert.equal(view.mapId, 'room');
  assert.deepEqual(
    view.markers.map(({ id }) => id),
    ['hero', 'npc'],
  );
  assert.deepEqual(view.markers[1], {
    marker: 2,
    id: 'npc',
    kind: 'npc',
    label: 'Public keeper',
    x: 8,
    y: 4,
    occupiedCells: [{ x: 8, y: 4 }],
  });
  assert.doesNotMatch(
    JSON.stringify(view),
    /PRIVATE|inventory|knownIds|authorDraft|remote|secret-token|elsewhere/,
  );
  assert.deepEqual(state, before);
  state.revision++;
  state.npcBrains.npc.facts.push('unrelated memory');
  assert.deepEqual(
    runtimeMapView(state, ['hero']),
    view,
    'unrelated private changes do not invalidate this view',
  );
});

test('multiple observers get the cell and entity intersection, never a union or unseen identities', () => {
  const state = fixture();
  state.entities.hero.x = 1;
  state.entities.listener = actor('listener', 13, 4);
  state.entities.shared = actor('shared', 7, 4, { kind: 'npc', label: 'Shared NPC' });
  state.entities.hidden = actor('hidden', 1, 5, { kind: 'npc', label: 'Secret NPC' });
  const a = runtimeMapView(state, ['hero']);
  const b = runtimeMapView(state, ['listener']);
  const shared = runtimeMapView(state, ['listener', 'hero', 'listener']);
  const bCells = new Set(b.visibleCells.map((p) => `${p.x},${p.y}`));
  assert.deepEqual(
    shared.visibleCells,
    a.visibleCells.filter((p) => bCells.has(`${p.x},${p.y}`)),
  );
  assert.deepEqual(
    shared.markers.map((m) => m.id),
    ['shared'],
  );
  assert.deepEqual(shared.observerIds, ['hero', 'listener']);
  assert.doesNotMatch(JSON.stringify(shared.markers), /hidden|Secret NPC|listener|hero/);
  assert.throws(() => runtimeMapView(state, []), /OBSERVERS_REQUIRED/);
  assert.throws(() => runtimeMapView(state, ['missing']), /OBSERVER_UNAVAILABLE/);
  state.entities.listener.mapId = 'elsewhere';
  assert.throws(() => runtimeMapView(state, ['hero', 'listener']), /DIFFERENT_MAPS/);
});

test('perception masks NPCs behind painted walls while leaving engine collision unchanged', () => {
  const state = fixture(24, 24);
  state.entities.hero.x = 4;
  state.entities.hero.y = 6;
  state.entities.hidden = actor('hidden', 8, 6, { kind: 'npc', label: 'Hidden name' });
  state.maps.room.spatialGrounding = {
    version: 1,
    imageRevisionId: revisionId,
    imageSha256: 'a'.repeat(64),
    confidence: 0.9,
    rows: Array.from({ length: 24 }, () => '......#.................'),
    landmarks: [],
  };
  const view = runtimeMapView(state, ['hero']);
  assert.equal(
    view.markers.some((m) => m.id === 'hidden'),
    false,
  );
  assert.equal(
    view.visibleCells.some((p) => p.x === 8 && p.y === 6),
    false,
  );
  assert.deepEqual(state.maps.room.blocked, []);
  assert.equal(Object.hasOwn(view, 'blocked'), false);
  assert.equal(Object.hasOwn(view, 'terrain'), false);
  assert.doesNotMatch(JSON.stringify(view), /safe floor|walkable|Hidden name/);
});

test('numeric markers use authoritative occupiedCells, hide partially perceived footprints and remain stable on movement', () => {
  const state = fixture(24, 24);
  state.entities.hero.x = 2;
  state.entities.hero.y = 3;
  state.entities.giant = actor('giant', 5, 3, { kind: 'npc', tokenSize: 'huge', label: 'Giant' });
  state.entities.partial = actor('partial', 10, 3, {
    kind: 'npc',
    tokenSize: 'large',
    label: 'Partially seen',
  });
  const view = runtimeMapView(state, ['hero']);
  assert.deepEqual(view.markers[0].occupiedCells, occupiedCells(state.entities.giant));
  assert.equal(view.markers[0].occupiedCells.length, 9);
  assert.equal(
    view.markers.some((m) => m.id === 'partial'),
    false,
  );
  state.entities = Object.fromEntries(Object.entries(state.entities).reverse());
  state.entities.giant.x = 4;
  const moved = runtimeMapView(state, ['hero']);
  assert.deepEqual(
    moved.markers.map((m) => [m.id, m.marker]),
    view.markers.map((m) => [m.id, m.marker]),
  );
  assert.equal(moved.markers[0].x, 4);
});

test('raster masking happens before compression: changing hidden source pixels cannot affect output', async () => {
  const view = runtimeMapView(fixture(), ['hero']);
  const width = 512,
    height = 288;
  const sourceA = Buffer.alloc(width * height * 3),
    sourceB = Buffer.alloc(width * height * 3);
  const visible = new Set(view.visibleCells.map((p) => `${p.x},${p.y}`));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      sourceA.set([173, 69, 103], at);
      sourceB.set(
        visible.has(`${Math.floor(x / 32)},${Math.floor(y / 32)}`) ? [173, 69, 103] : [0, 255, 0],
        at,
      );
    }
  const bytesA = await sharp(sourceA, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  const bytesB = await sharp(sourceB, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  assert.notEqual(hash(bytesA), hash(bytesB));
  const a = await render(bytesA, view),
    b = await render(bytesB, view);
  assert.equal(a.inputSha256, b.inputSha256);
  assert.equal(a.dataUrl, b.dataUrl);
  const decoded = await decode(a);
  assert.equal(decoded.info.width, 768);
  assert.equal(decoded.info.height, 768);
  for (const [x, y] of [
    [16, 16],
    [700, 700],
    [600, 100],
  ])
    assert.ok(
      pixel(decoded, x, y).every((n, i) => Math.abs(n - [16, 20, 27][i]) <= 3),
      `masked pixel ${x},${y}`,
    );
  assert.ok(pixel(decoded, 176, 144)[0] > 140, 'perceived artwork remains visible');
});

test('contained image, grid and footprint markers align without stretching to the square', async () => {
  const state = fixture();
  state.entities.hero = actor('hero', 7, 4, { tokenSize: 'large' });
  const raster = await render(await image(200, 200), runtimeMapView(state, ['hero']));
  assert.deepEqual(raster.transform.imageRect, { x: 112, y: 0, width: 288, height: 288 });
  const decoded = await decode(raster);
  assert.ok(pixel(decoded, 80, 144)[0] < 40, 'contain letterbox stays dark');
  assert.ok(pixel(decoded, 176, 144)[0] > 140, 'art is within image rectangle');
  const markerPixel = pixel(decoded, 260, 157);
  assert.ok(markerPixel[2] > markerPixel[0], 'blue player marker is centered on its 2x2 footprint');
});

test('identical input is deterministic; public labels never become SVG or image content', async () => {
  const bytes = await image();
  const view = runtimeMapView(fixture(), ['hero']);
  const a = await render(bytes, view);
  const b = await render(bytes, view);
  assert.deepEqual(a, b);
  assert.equal(a.inputSha256, hash(Buffer.from(a.dataUrl.split(',')[1], 'base64')));
  const renamed = structuredClone(view);
  renamed.markers[0].label = '<image href="file:///never-read"/><script>bad()</script>';
  assert.equal((await render(bytes, renamed)).dataUrl, a.dataUrl);
});

test('stale content hashes, non-raster formats, invalid geometry and unsafe projections fail closed', async () => {
  const bytes = await image();
  const view = runtimeMapView(fixture(), ['hero']);
  await assert.rejects(
    () => renderRuntimeMapRaster(bytes, { revisionId, sha256: '0'.repeat(64) }, view),
    /INTEGRITY/,
  );
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  await assert.rejects(() => render(svg, view), /INVALID_RASTER/);
  await assert.rejects(() => render(Buffer.from('not an image'), view), /INVALID_RASTER/);
  await assert.rejects(() => render(Buffer.alloc(5 * 1024 * 1024 + 1), view), /INVALID_RASTER/);
  const oversized = await image(4097, 1);
  await assert.rejects(() => render(oversized, view), /INVALID_RASTER/);
  const outside = structuredClone(view);
  outside.markers[0].occupiedCells.push({ x: 15, y: 8 });
  await assert.rejects(() => render(bytes, outside), /INVALID_VIEW/);
  const extra = { ...view, privateBrain: { secret: true } };
  await assert.rejects(() => render(bytes, extra));
  await assert.rejects(() => render(bytes, { ...view, width: 65 }));
});

test('an empty shared perception produces no source pixels or markers, never an unmasked fallback', async () => {
  const state = fixture(24, 24);
  state.entities.hero = actor('hero', 0, 0);
  state.entities.listener = actor('listener', 23, 23);
  const view = runtimeMapView(state, ['hero', 'listener']);
  assert.deepEqual(view.visibleCells, []);
  assert.deepEqual(view.markers, []);
  const red = await render(await image(768, 768, '#ff0000'), view);
  const green = await render(await image(768, 768, '#00ff00'), view);
  assert.equal(red.inputSha256, green.inputSha256);
  const decoded = await decode(red);
  assert.ok(pixel(decoded, 400, 400).every((n, i) => Math.abs(n - [16, 20, 27][i]) <= 3));
});

test('render snapshots pinned bytes, identity and view before asynchronous image decoding', async () => {
  const source = await image();
  const view = runtimeMapView(fixture(), ['hero']);
  const identity = { revisionId, sha256: hash(source) };
  const expected = await render(source, view);
  const pending = renderRuntimeMapRaster(source, identity, view);
  source.fill(0);
  identity.sha256 = '0'.repeat(64);
  view.visibleCells.length = 0;
  view.markers.length = 0;
  assert.deepEqual(await pending, expected);
});

test('all 32 admitted public-speech observers participate in the mask', async () => {
  const state = fixture();
  const ids = Array.from({ length: 32 }, (_, i) => `observer_${i}`);
  state.entities = Object.fromEntries(ids.map((id) => [id, actor(id, 7, 4)]));
  const view = runtimeMapView(state, ids);
  assert.equal(view.observerIds.length, 32);
  assert.equal(view.markers.length, 32);
  const result = await render(await image(), view);
  assert.equal(result.view.observerIds.length, 32);
});

test('visible bodies retain lifecycle in the validated runtime raster view', async () => {
  const state = fixture();
  state.entities.body = actor('body', 8, 4, { kind: 'npc', lifeState: 'dead', vitality: 0 });
  const view = runtimeMapView(state, ['hero']);
  assert.equal(view.markers.find((marker) => marker.id === 'body').lifeState, 'dead');
  const raster = await render(await image(), view);
  assert.equal(raster.view.markers.find((marker) => marker.id === 'body').lifeState, 'dead');
});
