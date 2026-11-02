/** No provider calls: contracts, actual compiler/source preparation and exact transport body. */
const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  mapIntentSchema,
  mapMatchesIntent,
  locationSchema,
  contentSchema,
} = require('../../packages/contracts/dist');
const { compileStoryPlan, storyPlanDefinition } = require('../../apps/api/dist/game/story-plan');
const {
  buildAuthoringTextRequestBody,
} = require('../../apps/api/dist/live-test/authoring-provider');
function source(intent) {
  return {
    title: 'Geometry fixture',
    content: contentSchema.parse({
      locations: [
        {
          id: 'room',
          name: 'Room',
          description: 'A long room running east to west.',
          ...(intent ? { mapIntent: intent } : {}),
        },
      ],
    }),
    npcs: [],
  };
}
function plan(width, height) {
  return {
    version: 1,
    rooms: [
      {
        locationId: 'room',
        width,
        height,
        spawns: [
          { x: 2, y: 2 },
          { x: 3, y: 2 },
          { x: 2, y: 3 },
          { x: 3, y: 3 },
        ],
        blocked: [],
        surfaces: [],
      },
    ],
    connections: [],
    npcs: [],
    items: [],
  };
}
test('optional dimension/aspect intent survives normal content validation; legacy omission stays absent', () => {
  const intent = { kind: 'aspect', width: 2, height: 1 };
  assert.deepEqual(contentSchema.parse(source(intent).content).locations[0].mapIntent, intent);
  assert.equal(Object.hasOwn(locationSchema.parse({ id: 'old', name: 'Old' }), 'mapIntent'), false);
  for (const invalid of [
    { kind: 'dimensions', width: 7, height: 8 },
    { kind: 'dimensions', width: 25, height: 8 },
    { kind: 'aspect', width: 4, height: 1 },
    { kind: 'aspect', width: 24, height: 7 },
    { kind: 'aspect', width: 2.5, height: 1 },
    { kind: 'aspect', width: 0, height: 1 },
    { kind: 'aspect', width: 2, height: 1, grid: true },
  ])
    assert.equal(mapIntentSchema.safeParse(invalid).success, false);
  assert.equal(mapIntentSchema.safeParse({ kind: 'aspect', width: 16, height: 9 }).success, true);
});
test('new maps have fixed extent regardless of legacy focal-area intent', () => {
  for (const intent of [
    undefined,
    { kind: 'aspect', width: 2, height: 1 },
    { kind: 'dimensions', width: 21, height: 9 },
  ]) {
    const compiled = compileStoryPlan(source(intent), plan(24, 24));
    assert.equal(compiled.draft.maps[0].width, 24);
    assert.equal(compiled.draft.maps[0].height, 24);
    assert.throws(() => compileStoryPlan(source(intent), plan(8, 8)));
  }
  assert.equal(mapMatchesIntent(undefined, 8, 8), true);
  assert.match(storyPlanDefinition.instructions, /24x24/);
  assert.match(storyPlanDefinition.instructions, /surroundings/);
});
test('real source preparation forwards synopsis and map intent into exact provider body, and invalidates changed source', async () => {
  const configModule = require.resolve('../../apps/api/dist/config');
  require.cache[configModule] = {
    id: configModule,
    filename: configModule,
    loaded: true,
    exports: {
      config: {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://synthetic@127.0.0.1:1/never_connect',
      },
    },
  };
  const { StoryBuildService } = require('../../apps/api/dist/game/story-build.service');
  let data = {
    ...source({ kind: 'aspect', width: 2, height: 1 }),
    synopsis: 'Author explicitly requests elongated rooms.',
  };
  delete data.npcs;
  const c = {
    query: async (sql) => ({
      rows: sql.includes('SELECT * FROM adventures')
        ? [{ data, title: data.title, edit_revision: 1 }]
        : [],
    }),
  };
  const service = new StoryBuildService({}, {});
  const prepared = await service.source(c, 'owner', 'story');
  assert.equal(prepared.source.synopsis, data.synopsis);
  assert.deepEqual(
    prepared.source.content.locations[0].mapIntent,
    data.content.locations[0].mapIntent,
  );
  const profile = { model: 'synthetic', maxOutputTokens: 1000 };
  const body = JSON.parse(
    buildAuthoringTextRequestBody(storyPlanDefinition, profile, prepared.source),
  );
  const sent = JSON.parse(body.input);
  assert.equal(sent.synopsis, data.synopsis);
  assert.deepEqual(sent.content.locations[0].mapIntent, { kind: 'aspect', width: 2, height: 1 });
  assert.equal(sent.content.locations[0].description, data.content.locations[0].description);
  data = { ...data, synopsis: 'Now a north-south hall.' };
  const changed = await service.source(c, 'owner', 'story');
  assert.notEqual(changed.hash, prepared.hash);
  assert.equal(service.sameAuthorSource(prepared.source, changed.source), false);
  const old = source();
  assert.equal(service.sameAuthorSource(old, { ...old, synopsis: '' }), true);
  assert.equal(compileStoryPlan(old, plan(24, 24)).draft.maps[0].height, 24);
  data = structuredClone(data);
  data.content.locations[0].mapIntent = { kind: 'aspect', width: 1, height: 2 };
  const reshaped = await service.source(c, 'owner', 'story');
  assert.notEqual(reshaped.hash, changed.hash);
  assert.equal(service.sameAuthorSource(changed.source, reshaped.source), false);
});
test('ordinary location UI explains mandatory fixed map and fences image preparation', () => {
  const { readFileSync } = require('node:fs');
  const studio = readFileSync('apps/web/components/studio.tsx', 'utf8'),
    control = readFileSync('apps/web/components/studio/location-map-intent.tsx', 'utf8');
  assert.match(studio, /<LocationMapIntent/);
  assert.match(
    studio,
    /JSON.stringify\(\[\s*location.name,\s*location.description,\s*location.mapIntent,?\s*\]\)/,
  );
  assert.match(control, /24 × 24/);
  assert.doesNotMatch(control, /<Select|<Input|onBlur/);
  assert.doesNotMatch(control, /api\(|fetch\(|gameAction|showGrid/);
});
test('old prepared snapshot missing nonempty synopsis must reprepare before a new quote; empty legacy source remains compatible', async () => {
  const { StoryBuildService } = require('../../apps/api/dist/game/story-build.service');
  const { visualDigest } = require('../../apps/api/dist/visual-authoring/fingerprint');
  const service = new StoryBuildService({}, {}),
    old = source(),
    hash = 'a'.repeat(64);
  service.lock = async () => {};
  service.own = async () => ({
    status: 'prepared',
    project_status: 'concept',
    source_hash: hash,
    source_snapshot: { source: old },
    adventure_id: 'fixture',
  });
  let current = { ...old, synopsis: 'Elongated rooms requested only here.' };
  service.source = async () => ({ hash, source: current });
  const input = {
    projectId: 'fixture',
    projectRevision: 1,
    sourceHash: hash,
    readsetHash: visualDigest(old),
  };
  await assert.rejects(() => service.guard('owner')({}, input), /STORY_CONTEXT_STALE/);
  assert.equal(Object.hasOwn(old, 'synopsis'), false, 'Old immutable source was not rewritten');
  service.db = { tx: (work) => work({ query: async () => ({ rows: [] }) }) };
  assert.equal(
    (await service.state('owner', 'fixture')).sourceCurrent,
    false,
    'UI offers reprepare rather than a quote missing synopsis',
  );
  current = { ...old, synopsis: '' };
  await service.guard('owner')({}, input);
  assert.equal((await service.state('owner', 'fixture')).sourceCurrent, true);
});
test('authoring recovery exposes only exact stable shape error; keeps stale/pending and provider actual untouched', async () => {
  const { AuthoringTextEngine } = require('../../apps/api/dist/live-test/authoring-text');
  for (const [message, expected] of [
    ['STORY_MAP_INTENT_MISMATCH', 'STORY_MAP_INTENT_MISMATCH'],
    ['STORY_MAP_INTENT_MISMATCH:private-location', 'AUTHORING_STALE'],
    ['arbitrary private provider text', 'AUTHORING_STALE'],
  ]) {
    const engine = Object.create(AuthoringTextEngine.prototype),
      statements = [];
    const row = {
      id: 'fixture',
      actor_id: 'owner',
      status: 'generated',
      session_id: 'session',
      reservation_id: 'reservation',
      actual_micros: 13,
    };
    const c = {
      query: async (sql, args = []) => {
        statements.push([sql, args]);
        return { rows: [], rowCount: 0 };
      },
    };
    engine.db = { query: async () => [row], tx: (work) => work(c) };
    engine.live = { lockAuthorization: async () => {} };
    engine.lockSource = async () => {
      throw Error(message);
    };
    await engine.resumeGenerated(
      'owner',
      'fixture',
      async () => {},
      async () => {},
    );
    const update = statements.find(([sql]) => sql.startsWith('UPDATE live_authoring_text_jobs'));
    assert.ok(update);
    assert.deepEqual(update[1], ['fixture', expected]);
    assert.match(update[0], /status='stale',proposal=NULL,result=NULL/);
    assert.doesNotMatch(update[0], /actual_micros\s*=/);
    assert.equal(row.actual_micros, 13);
    assert.ok(
      statements.some(([sql]) =>
        sql.includes('SELECT actor_id,spark_quote_id,scope_id FROM generation_budget_reservations'),
      ),
    );
  }
});
