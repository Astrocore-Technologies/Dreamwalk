// Source-backed metadata/privacy tests, no filesystem raster read and no provider.
process.env.DATABASE_URL ??= 'postgres://synthetic:synthetic@127.0.0.1:1/synthetic';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  extendRuntimeMap,
  runtimeMapStillCurrent,
  runtimeMapSourceStillCurrent,
} = require('../../apps/api/src/game/runtime-map-context.ts');
function fixture() {
  const revisionId = randomUUID(),
    sha256 = 'a'.repeat(64),
    campaign = randomUUID();
  const state = {
    entities: {
      player: {
        id: 'player',
        kind: 'player',
        mapId: 'tower',
        spatialMode: 'location_only',
        sceneId: 'welcome',
      },
      hidden: {
        id: 'hidden',
        kind: 'npc',
        mapId: 'tower',
        spatialMode: 'location_only',
        sceneId: 'archive',
      },
    },
    maps: {
      tower: {
        id: 'tower',
        spatialMode: 'location_only',
        locationImage: { revisionId, sha256 },
        scenePresence: {
          version: 1,
          entrySceneId: 'welcome',
          scenes: [
            {
              id: 'welcome',
              participantIds: ['player'],
              evidence: { kind: 'authored_scene', reference: 'welcome' },
            },
            {
              id: 'archive',
              participantIds: ['hidden'],
              evidence: { kind: 'authored_scene', reference: 'archive' },
            },
          ],
        },
      },
    },
    artBindings: [{ slot: 'map:tower:background', revisionId, sha256 }],
  };
  const row = {
    revisionId,
    sha256,
    metadata: { kind: 'background', camera: 'top-down' },
    filename: 'must-not-be-read.png',
  };
  const query = async (sql) =>
    sql.includes('SELECT c.source_version_id') ? [{ source_version_id: randomUUID() }] : [row];
  return { state, row, campaign, query };
}
test('location-only runtime retains pinned source identity but never sends original raster as NPC/shared evidence', async () => {
  const f = fixture();
  const context = await extendRuntimeMap(
    { query: f.query },
    f.campaign,
    f.state,
    'player',
    { actorId: 'player' },
    'narrative',
  );
  assert.equal(context.runtimeMapImage, undefined);
  assert.deepEqual(context.locationMapContext, {
    spatialMode: 'location_only',
    mapId: 'tower',
    sceneId: 'welcome',
    actorId: 'player',
    revisionId: f.row.revisionId,
    sha256: f.row.sha256,
  });
  assert.ok(!JSON.stringify(context).includes('hidden'));
  assert.ok(!JSON.stringify(context).includes('visibleCells'));
  assert.equal(await runtimeMapStillCurrent(f.query, f.campaign, f.state, context), true);
  assert.equal(await runtimeMapSourceStillCurrent(f.query, f.campaign, f.state, context), true);
  f.state.entities.player.sceneId = 'other';
  assert.equal(await runtimeMapStillCurrent(f.query, f.campaign, f.state, context), false);
});
test('location source ACL/pin and metadata tampering are rechecked before dispatch', async () => {
  const f = fixture();
  const context = await extendRuntimeMap(
    { query: f.query },
    f.campaign,
    f.state,
    'player',
    {},
    'intent',
  );
  assert.equal(await runtimeMapStillCurrent(async () => [], f.campaign, f.state, context), false);
  f.row.sha256 = 'b'.repeat(64);
  assert.equal(await runtimeMapSourceStillCurrent(f.query, f.campaign, f.state, context), false);
  await assert.rejects(
    extendRuntimeMap({ query: f.query }, f.campaign, f.state, 'player', {}, 'intent'),
    /MAP_IMAGE_SOURCE_CHANGED/,
  );
});
test('future director history uses canonical scene audience and does not read unscoped legacy history', async () => {
  const { extendContextHistory } = require('../../apps/api/src/game/context-history.ts');
  const f = fixture(),
    calls = [];
  const context = await extendContextHistory(
    {
      query: async (sql, args) => {
        calls.push({ sql, args });
        return [];
      },
    },
    { contextWindow: () => ({ effectiveContextTokens: 1000 }), packContext: (value) => value },
    f.campaign,
    f.state,
    'player',
    { mode: 'director', channel: 'say', director: { sharedAudience: [{ id: 'hidden' }] } },
    'story_turn',
  );
  const query = calls.find((c) => c.sql.includes('game_story_feed'));
  assert.deepEqual(query.args[1], ['player']);
  assert.equal(query.args[3], false);
  assert.equal(
    calls.some((c) => c.sql.includes('game_narrative_turns')),
    false,
  );
  assert.deepEqual(context.history, []);
});
