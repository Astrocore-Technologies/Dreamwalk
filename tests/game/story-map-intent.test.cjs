/** No provider calls: contracts, actual compiler/source preparation and exact transport body. */
const test = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
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
      id: randomUUID(),
      actor_id: randomUUID(),
      status: 'generated',
      session_id: randomUUID(),
      reservation_id: randomUUID(),
      actual_micros: 13,
    };
    const c = {
      query: async (sql, args = []) => {
        statements.push([sql, args]);
        if (sql.startsWith('SELECT session_id FROM live_authoring_text_jobs'))
          return { rows: [{ session_id: row.session_id }], rowCount: 1 };
        if (sql.startsWith('SELECT * FROM live_authoring_text_jobs'))
          return { rows: [row], rowCount: 1 };
        if (sql.startsWith('UPDATE live_authoring_text_jobs')) row.status = 'stale';
        if (sql.startsWith('SELECT status FROM live_authoring_text_jobs'))
          return { rows: [{ status: row.status }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
    engine.db = { query: async () => [row], tx: (work) => work(c) };
    engine.live = { lockAuthorization: async () => {} };
    engine.lockSource = async () => {
      throw Error(message);
    };
    await engine.resumeGenerated(
      row.actor_id,
      row.id,
      async () => {},
      async () => {},
    );
    const update = statements.find(([sql]) => sql.startsWith('UPDATE live_authoring_text_jobs'));
    assert.ok(update);
    assert.deepEqual(update[1], [row.id, expected]);
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

test('authoring recovery does not overwrite a result completed by a concurrent worker', async () => {
  const { AuthoringTextEngine } = require('../../apps/api/dist/live-test/authoring-text');
  const engine = Object.create(AuthoringTextEngine.prototype);
  const statements = [];
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
      if (sql.startsWith('SELECT status FROM live_authoring_text_jobs'))
        return { rows: [{ status: 'committed' }], rowCount: 1 };
      throw new Error('No mutation is allowed after the concurrent commit');
    },
  };
  engine.db = { query: async () => [row], tx: (work) => work(c) };
  engine.live = { lockAuthorization: async () => {} };
  engine.lockSource = async () => {
    throw Error('STORY_MAP_INTENT_MISMATCH');
  };
  await engine.resumeGenerated(
    'owner',
    'fixture',
    async () => {},
    async () => {},
  );
  assert.equal(statements.length, 1);
  assert.match(statements[0][0], /^SELECT status FROM live_authoring_text_jobs.*FOR UPDATE/);
  assert.equal(row.actual_micros, 13);
});

function textPositionFixture() {
  const npcId = randomUUID();
  const src = {
    title: 'Two-room text-only opening',
    content: contentSchema.parse({
      locations: [
        { id: 'hall', name: 'Hall', description: 'A clear entrance with a keeper.' },
        { id: 'yard', name: 'Yard', description: 'A clear courtyard linked to the hall.' },
      ],
      npcIds: [npcId],
      scenes: [{ id: 'opening', name: 'Arrival', locationId: 'hall', participantNpcIds: [npcId] }],
      startSceneId: 'opening',
    }),
    npcs: [
      {
        id: npcId,
        name: 'Keeper',
        role: 'Host',
        description: 'Greets visitors.',
        appearance: 'An adult.',
      },
    ],
  };
  const result = {
    version: 1,
    rooms: ['hall', 'yard'].map((locationId) => ({
      locationId,
      width: 24,
      height: 24,
      spawns: [
        { x: 3, y: 3 },
        { x: 4, y: 3 },
        { x: 3, y: 4 },
        { x: 4, y: 4 },
      ],
      blocked: [],
      surfaces: [],
    })),
    connections: [{ a: 'hall', b: 'yard', atA: { x: 8, y: 5 }, atB: { x: 5, y: 5 } }],
    npcs: [{ sourceNpcId: npcId, locationId: 'hall', x: 6, y: 3, stock: [] }],
    items: [],
  };
  return { src, result, npcId };
}
test('asset-free response schema requires positions the compiler needs, without inventing coordinates', () => {
  const { src, result } = textPositionFixture();
  const immutable = JSON.stringify(storyPlanDefinition.schema);
  const strict = storyPlanDefinition.schemaForContext(src);
  const room = strict.properties.rooms.items;
  assert.equal(room.properties.spawns.minItems, 4);
  assert.equal(room.properties.spawns.maxItems, 4);
  const npc = strict.properties.npcs.items;
  for (const key of ['x', 'y']) {
    assert.equal(npc.properties[key].type, 'integer');
    assert.equal(npc.properties[key].anyOf, undefined);
    assert.ok(npc.required.includes(key));
  }
  for (const key of ['atA', 'atB']) {
    const connection = strict.properties.connections.items;
    assert.equal(connection.properties[key].type, 'object');
    assert.equal(connection.properties[key].anyOf, undefined);
  }
  const valid = storyPlanDefinition.validateProposal(result, src);
  assert.deepEqual(valid, result);
  for (const mutate of [
    (p) => {
      p.rooms[0].spawns = [];
    },
    (p) => {
      p.rooms[0].spawns.pop();
    },
    (p) => {
      delete p.connections[0].atA;
    },
    (p) => {
      p.connections[0].atB = null;
    },
    (p) => {
      delete p.npcs[0].x;
    },
    (p) => {
      p.npcs[0].y = null;
    },
  ]) {
    const malformed = structuredClone(result);
    mutate(malformed);
    const before = structuredClone(malformed);
    assert.throws(() => storyPlanDefinition.validateProposal(malformed, src));
    assert.deepEqual(malformed, before, 'no fabricated/default placement repairs');
  }
  assert.equal(
    JSON.stringify(storyPlanDefinition.schema),
    immutable,
    'shared image schema unchanged',
  );
  for (const key of ['mapImages', 'omittedMapImages']) {
    const imageSource = {
      ...src,
      [key]: [{ locationId: 'hall', revisionId: randomUUID(), sha256: 'a'.repeat(64) }],
    };
    assert.equal(storyPlanDefinition.schemaForContext(imageSource), storyPlanDefinition.schema);
    assert.equal(
      storyPlanDefinition.schemaForContext(imageSource).properties.rooms.items.properties.spawns
        .minItems,
      undefined,
    );
  }
});

test('one quoted text-only body survives restart and builds positioned playable state with no additional provider work', async () => {
  const {
    BoundedAuthoringTextProvider,
  } = require('../../apps/api/dist/live-test/authoring-provider');
  const {
    createStateFromPlayable,
    projectState,
    findPath,
  } = require('../../packages/game-core/dist');
  const { requiresMapRecovery } = require('../../apps/api/dist/game/map-readiness');
  const { src, result, npcId } = textPositionFixture();
  const profile = {
    model: 'synthetic-text-plan',
    contextTokens: 128000,
    contextBudgetTokens: 60000,
    maxOutputTokens: 4096,
    maxInputBytes: 4194304,
    inputMicrosPerMillion: 1000000,
    outputMicrosPerMillion: 2000000,
    upperMicros: 100000,
    estimation: {
      kind: 'operator_heuristic',
      textTokensPerKiBUtf8: 1024,
      textProtocolTokens: 4096,
      marginBps: 1000,
      fixedMarginMicros: 100,
    },
    pricing: { reviewedAt: '2026-01-01T00:00:00Z', validUntil: '2030-01-01T00:00:00Z' },
  };
  const calls = [];
  const transport = async (url, init) => {
    assert.ok(url.endsWith('/responses'), 'no image/count or second generation');
    calls.push(init.body);
    return new Response(
      JSON.stringify({
        id: 'synthetic-plan',
        status: 'completed',
        service_tier: 'default',
        usage: { input_tokens: 100, output_tokens: 100 },
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] },
        ],
      }),
    );
  };
  const provider = new BoundedAuthoringTextProvider(
    storyPlanDefinition,
    'synthetic',
    transport,
    profile,
  );
  const quoted = provider.prepareTextRequest(src);
  assert.equal(calls.length, 0);
  assert.equal(
    JSON.parse(quoted.body).text.format.schema.properties.rooms.items.properties.spawns.minItems,
    4,
  );
  const restarted = new BoundedAuthoringTextProvider(
    storyPlanDefinition,
    'synthetic',
    transport,
    profile,
  );
  const output = await restarted.generate({
    jobId: randomUUID(),
    context: src,
    signal: new AbortController().signal,
    textReservationSnapshot: quoted.snapshot,
    maxCostMicros: quoted.snapshot.reserveMicros,
  });
  assert.deepEqual(calls, [quoted.body]);
  const parsed = storyPlanDefinition.validateProposal(output.proposal, src);
  const compiled = compileStoryPlan(src, parsed);
  const state = createStateFromPlayable(compiled.playable, ['player']);
  assert.equal(requiresMapRecovery(state), false);
  assert.equal(state.maps.hall.spawns.length, 4);
  assert.equal(state.maps.yard.spawns.length, 4);
  const view = projectState(state, 'player');
  assert.ok(
    view.entities.some((e) => e.id === npcId && Number.isInteger(e.x) && Number.isInteger(e.y)),
  );
  assert.ok(
    view.entities.some((e) => e.id === 'player' && Number.isInteger(e.x) && Number.isInteger(e.y)),
  );
  assert.ok(findPath(state, 'hall', state.entities.player, { x: 5, y: 3 }, 'player'));
  assert.equal(state.maps.hall.exits[0].destinationMapId, 'yard');
  assert.equal(calls.length, 1);
});
