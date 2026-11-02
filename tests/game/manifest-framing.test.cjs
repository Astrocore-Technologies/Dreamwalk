/** Actual audience-filtered manifest projection with isolated persistence; no asset/provider calls. */
const test = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const configModule = require.resolve('../../apps/api/dist/config');
require.cache[configModule] = {
  id: configModule,
  filename: configModule,
  loaded: true,
  exports: {
    config: { NODE_ENV: 'test', DATABASE_URL: 'postgresql://synthetic@127.0.0.1:1/never_connect' },
  },
};
const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service');
const { deriveMapImageFraming } = require('../../packages/contracts/dist');
const { createObservatoryState, addPlayer } = require('../../packages/game-core/dist');
function fixture() {
  const state = addPlayer(createObservatoryState(), 'viewer').state,
    mapId = state.entities.viewer.mapId,
    map = state.maps[mapId],
    framing = deriveMapImageFraming(mapId, map.width, map.height),
    revision = randomUUID();
  const binding = {
    slot: `map:${mapId}:background`,
    revisionId: revision,
    sha256: 'a'.repeat(64),
    mime: 'image/png',
    width: framing.width,
    height: framing.height,
  };
  state.artBindings = [binding];
  return {
    state,
    mapId,
    framing,
    binding,
    evidence: {
      revision_id: revision,
      framing_version: 1,
      image_framing: framing,
      kind: 'background',
      width: framing.width,
      height: framing.height,
    },
  };
}
async function project(
  f,
  { rows = [f.evidence], pins = [f.binding], unavailable = [], actor = 'viewer' } = {},
) {
  const queries = [];
  const db = {
    query: async (sql, args) => {
      queries.push([sql, args]);
      if (sql.includes('SELECT r.id FROM art_asset_revisions'))
        return args[0].filter((id) => !unavailable.includes(id)).map((id) => ({ id }));
      if (sql.includes('FROM art_playable_pins'))
        return pins.map((b) => ({
          slot: b.slot,
          revision_id: b.revisionId,
          rights_snapshot: {
            attribution: 'Public credit',
            licenseLabel: 'Fixture license',
            private: 'NEVER_EXPOSE_RIGHTS_PRIVATE',
          },
        }));
      if (sql.includes('FROM image_generation_jobs')) return rows;
      throw Error('Unexpected fixture query');
    },
  };
  const manifest = await new AssetReuseService(db).visibleManifestForState(
    'campaign',
    'viewer' === actor ? actor : 'missing-actor',
    f.state,
    'source',
  );
  return { manifest, queries };
}
test('only validated admitted geometry is exposed, with actual map/raster dimensions; no source/prompt leakage', async () => {
  const f = fixture();
  f.evidence.private_prompt = 'PRIVATE_AUTHORING_PROMPT';
  const { manifest, queries } = await project(f);
  assert.deepEqual(manifest.bindings[0].imageFraming, f.framing);
  const output = JSON.stringify(manifest);
  assert.ok(!output.includes('PRIVATE_AUTHORING_PROMPT'));
  assert.ok(!output.includes('NEVER_EXPOSE_RIGHTS_PRIVATE'));
  const [sql, args] = queries.find(([sql]) => sql.includes('FROM image_generation_jobs'));
  assert.deepEqual(args, [[f.binding.revisionId]]);
  assert.match(sql, /j.status='admitted'/);
  assert.match(sql, /j.input->'framingVersion'='1'::jsonb/);
  assert.doesNotMatch(sql, /SELECT\s+j\.input\s*[, ]|prompt|context_hash|source_hash/i);
});
test('legacy, invalid, stale or ambiguous evidence never opts old mapping into contain', async () => {
  const f = fixture();
  const cases = [
    [],
    [{ ...f.evidence, framing_version: undefined }],
    [{ ...f.evidence, framing_version: '1' }],
    [{ ...f.evidence, kind: 'portrait' }],
    [{ ...f.evidence, image_framing: { ...f.framing, width: 1 } }],
    [{ ...f.evidence, image_framing: { ...f.framing, prompt: 'PRIVATE' } }],
    [
      {
        ...f.evidence,
        image_framing: deriveMapImageFraming('other-map', f.framing.mapWidth, f.framing.mapHeight),
      },
    ],
    [{ ...f.evidence, image_framing: deriveMapImageFraming(f.mapId, 8, 8) }],
    [{ ...f.evidence, width: f.framing.width + 16 }],
    [f.evidence, { ...f.evidence }],
  ];
  for (const rows of cases) {
    const { manifest } = await project(f, { rows });
    assert.equal(manifest.bindings.length, 1);
    assert.equal(Object.hasOwn(manifest.bindings[0], 'imageFraming'), false);
    assert.equal(manifest.bindings[0].width, f.binding.width);
  }
  f.binding.width += 16;
  const { manifest } = await project(f);
  assert.equal(Object.hasOwn(manifest.bindings[0], 'imageFraming'), false);
});
test('unavailable/unpinned/private-other-map art is filtered before evidence lookup; invalid actor gets no geometry', async () => {
  const f = fixture(),
    hidden = { ...f.binding, slot: 'map:hidden-room:background', revisionId: randomUUID() };
  f.state.maps['hidden-room'] = { ...f.state.maps[f.mapId], id: 'hidden-room' };
  f.state.artBindings.push(hidden);
  const { manifest, queries } = await project(f, {
    pins: [f.binding, hidden],
    rows: [
      f.evidence,
      {
        ...f.evidence,
        revision_id: hidden.revisionId,
        image_framing: deriveMapImageFraming(
          'hidden-room',
          f.framing.mapWidth,
          f.framing.mapHeight,
        ),
      },
    ],
  });
  assert.equal(manifest.bindings.length, 1);
  assert.deepEqual(queries.find(([sql]) => sql.includes('FROM image_generation_jobs'))[1], [
    [f.binding.revisionId],
  ]);
  for (const options of [
    { pins: [] },
    { unavailable: [f.binding.revisionId] },
    { actor: 'missing' },
  ]) {
    const result = await project(f, options);
    assert.deepEqual(result.manifest.bindings, []);
    assert.equal(
      result.queries.some(([sql]) => sql.includes('FROM image_generation_jobs')),
      false,
    );
  }
});
