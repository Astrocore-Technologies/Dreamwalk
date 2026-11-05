// Synthetic state only. No live DB, provider or paid call.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { createObservatoryState } = require('../../packages/game-core/dist');
const {
  requiresMapRecovery,
  assertPlayableGrid,
} = require('../../apps/api/src/game/map-readiness.ts');
const { startMapGroundingCompatible } = require('../../apps/api/src/game/story-map-mode.ts');
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, value]) => [k, canonical(value)]),
        )
      : v;
const digest = (v) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
const configId = require.resolve('../../apps/api/dist/config');
require.cache[configId] = {
  id: configId,
  filename: configId,
  loaded: true,
  exports: {
    config: { NODE_ENV: 'test', DATABASE_URL: 'postgresql://synthetic@127.0.0.1:1/never_connect' },
  },
};
function incomplete() {
  const state = createObservatoryState(['hero']);
  const map = state.maps[state.entities.hero.mapId];
  map.spatialMode = 'location_only';
  map.spawns = [];
  return state;
}
test('real positioned maps remain playable without imposing new RP terrain rules', () => {
  const state = createObservatoryState(['hero']);
  const before = structuredClone(state);
  assert.equal(requiresMapRecovery(state), false);
  assert.doesNotThrow(() => assertPlayableGrid(state));
  assert.equal(startMapGroundingCompatible({}, state), true);
  assert.deepEqual(state, before);
});
test('location-only, empty anchors, missing position and out-of-bounds actor never pass admission', () => {
  const states = [incomplete()];
  for (const mutate of [
    (s) => {
      s.maps[s.entities.hero.mapId].spawns = [];
    },
    (s) => {
      delete s.entities.hero.x;
    },
    (s) => {
      s.entities.hero.x = -1;
    },
  ]) {
    const state = createObservatoryState(['hero']);
    mutate(state);
    states.push(state);
  }
  for (const state of states) {
    const before = structuredClone(state);
    assert.equal(requiresMapRecovery(state), true);
    assert.throws(() => assertPlayableGrid(state), /MAP_GRID_REQUIRED/);
    assert.equal(startMapGroundingCompatible({}, state), false);
    assert.deepEqual(state, before, 'no inferred positions or automatic actor migration');
  }
});
test('read-only legacy load does not resume, rewrite actor generations, or checkpoint on advance', async () => {
  const { GameService } = require('../../apps/api/dist/game/game.service');
  const state = incomplete(),
    before = structuredClone(state),
    queries = [];
  const service = Object.create(GameService.prototype);
  service.live = new Map();
  service.ai = { pending: async () => false };
  service.db = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.startsWith('SELECT c.*'))
        return [
          {
            state,
            snapshot_state: state,
            checksum: digest(state),
            revision: 7,
            event_seq: 4,
            updated_at: new Date(),
            runtime_clock: { paused: true, capturedAtMs: 1, rounds: {}, jobs: {} },
          },
        ];
      if (sql.startsWith('SELECT')) return [];
      assert.fail('legacy read must not write: ' + sql);
    },
  };
  service.persist = async () => assert.fail('no checkpoint/resume');
  const live = await service.load('synthetic', false);
  assert.equal(live.dirty, false);
  assert.equal(live.paused, true);
  assert.deepEqual(live.state, before);
  await service.advance('synthetic');
  await assert.rejects(() => service.load('synthetic'), /MAP_GRID_RECOVERY_REQUIRED/);
  await assert.rejects(
    () => service.touch('synthetic', live, 'hero'),
    /MAP_GRID_RECOVERY_REQUIRED/,
  );
  assert.deepEqual(live.state, before);
  assert.ok(queries.every((sql) => sql.startsWith('SELECT')));
});
test('mutation fence rejects incomplete uncached state before enrichment or provider work', async () => {
  const { GameService } = require('../../apps/api/dist/game/game.service');
  const state = incomplete(),
    before = structuredClone(state);
  const service = Object.create(GameService.prototype);
  service.live = new Map();
  service.db = { query: async () => [{ state, snapshot_state: state, checksum: digest(state) }] };
  await assert.rejects(() => service.load('synthetic'), /MAP_GRID_RECOVERY_REQUIRED/);
  assert.equal(service.live.size, 0);
  assert.deepEqual(state, before);
});

test('pinned raster hash mismatch requires recovery even when revision ID matches', () => {
  const state = createObservatoryState(['hero']);
  const map = state.maps[state.entities.hero.mapId];
  const revisionId = randomUUID();
  map.spatialGrounding = {
    version: 1,
    imageRevisionId: revisionId,
    imageSha256: 'a'.repeat(64),
    confidence: 0.95,
    rows: Array(24).fill('.'.repeat(24)),
    landmarks: [],
  };
  state.artBindings = [
    {
      slot: `map:${map.id}:background`,
      revisionId,
      sha256: 'b'.repeat(64),
      mime: 'image/png',
      width: 768,
      height: 768,
    },
  ];
  assert.equal(requiresMapRecovery(state), true);
  state.artBindings[0].sha256 = 'a'.repeat(64);
  assert.equal(requiresMapRecovery(state), false);
});
