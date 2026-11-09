// Offline transport and receipt adapter only. No paid count/generation or real campaign.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const {
  BoundedAuthoringTextProvider,
} = require('../../apps/api/dist/live-test/authoring-provider');
const {
  StoryMapCountRequired,
  STORY_MAP_COUNT_VERSION,
} = require('../../apps/api/dist/live-test/story-map-count');
const { resolveStoryMapCount } = require('../../apps/api/dist/live-test/story-map-count-receipt');
const { schematicStorySource } = require('../../apps/api/dist/game/story-map-mode');
const { countRequestBody } = require('../../apps/api/dist/ai/text-preflight');
const { storyPlanDefinition, compileStoryPlan } = require('../../apps/api/dist/game/story-plan');
const { contentSchema } = require('../../packages/contracts/dist');
const hash = (v) => createHash('sha256').update(v).digest('hex');
function fixture() {
  const bytes = Buffer.from('synthetic map image');
  const image = {
    locationId: 'tower',
    revisionId: randomUUID(),
    sha256: hash('source'),
    inputSha256: hash(bytes),
    width: 768,
    height: 768,
    framing: 'contain-24x24',
    dataUrl: 'data:image/jpeg;base64,' + bytes.toString('base64'),
  };
  const source = {
    title: 'Tower',
    npcs: [],
    content: contentSchema.parse({
      locations: [{ id: 'tower', name: 'Tower', description: 'A room above a rocky shore.' }],
    }),
    mapImages: [image],
  };
  const rows = Array.from({ length: 24 }, (_, y) =>
    Array.from({ length: 24 }, (_, x) =>
      x >= 10 && x <= 18 && y >= 3 && y <= 19 ? '.' : '~',
    ).join(''),
  );
  const proposal = {
    version: 1,
    rooms: [
      {
        locationId: 'tower',
        width: 24,
        height: 24,
        spawns: [
          { x: 12, y: 8 },
          { x: 13, y: 8 },
          { x: 12, y: 9 },
          { x: 13, y: 9 },
        ],
        blocked: [],
        surfaces: [],
        spatialGrounding: {
          version: 1,
          imageRevisionId: image.revisionId,
          imageSha256: image.sha256,
          confidence: 0.95,
          rows,
          landmarks: [],
        },
      },
    ],
    connections: [],
    npcs: [],
    items: [],
  };
  const pricing = {
    source: 'https://developers.openai.com/api/docs/pricing',
    reviewedAt: '2026-01-01T00:00:00Z',
    validUntil: '2030-01-01T00:00:00Z',
  };
  const profile = {
    model: 'synthetic-image-model',
    contextTokens: 1050000,
    contextBudgetTokens: 60000,
    maxOutputTokens: 8192,
    maxInputBytes: 4194304,
    inputMicrosPerMillion: 1000000,
    outputMicrosPerMillion: 2000000,
    upperMicros: 200000,
    pricing,
    estimation: {
      kind: 'operator_heuristic',
      textTokensPerKiBUtf8: 1024,
      textProtocolTokens: 4096,
      marginBps: 1000,
      fixedMarginMicros: 100,
    },
    runtimeVision: {
      model: 'synthetic-image-model',
      counting: 'operational_exact',
      maxImages: 1,
      detail: 'high',
      billing: 'text_input_rate',
      maxPricedInputTokens: 272000,
      pricing,
    },
  };
  return { source, proposal, profile };
}
function needCount(provider, source) {
  try {
    provider.prepareTextRequest(source);
    assert.fail('exact count required');
  } catch (error) {
    assert.ok(error instanceof StoryMapCountRequired);
    return error;
  }
}
test('story planning inherits exact runtime image support, explicit opt-out stops before paid image planning', () => {
  const { source, profile } = fixture();
  const provider = new BoundedAuthoringTextProvider(
    storyPlanDefinition,
    'synthetic',
    () => assert.fail('no call'),
    profile,
  );
  assert.equal(provider.profile.storyVision.counting, 'operational_exact');
  assert.equal(provider.profile.storyVision.maxImages, 4);
  assert.equal(provider.profile.storyVision.inputTokensPerImage, undefined);
  assert.equal(profile.storyVision, undefined, 'operator profile is not mutated');
  assert.equal(schematicStorySource(source, provider.profile), source);
  const disabled = new BoundedAuthoringTextProvider(
    storyPlanDefinition,
    'synthetic',
    () => assert.fail('no call'),
    { ...profile, storyVision: false },
  );
  assert.equal(disabled.profile.storyVision, false);
  assert.throws(() => schematicStorySource(source, disabled.profile), /MAP_VISION_POLICY_REQUIRED/);
  const legacy = { ...profile };
  delete legacy.runtimeVision;
  const text = new BoundedAuthoringTextProvider(
    storyPlanDefinition,
    'synthetic',
    () => assert.fail('no call'),
    legacy,
  );
  assert.equal(text.profile.storyVision, undefined);
  assert.throws(() => schematicStorySource(source, text.profile), /MAP_VISION_POLICY_REQUIRED/);
});

test('exact image count, accepted quote and restarted dispatch use one identical body and safe spawns', async () => {
  const { source, proposal, profile } = fixture();
  let counts = 0,
    generations = 0,
    counted,
    generated;
  const transport = async (url, init) => {
    if (url.endsWith('/input_tokens')) {
      counts++;
      counted = init.body;
      return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: 3210 }));
    }
    generations++;
    generated = init.body;
    return new Response(
      JSON.stringify({
        id: 'synthetic-generation',
        status: 'completed',
        service_tier: 'default',
        usage: { input_tokens: 3210, output_tokens: 50 },
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] },
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
  const request = needCount(provider, source);
  assert.equal(counts, 0);
  assert.equal(generations, 0);
  assert.doesNotMatch(JSON.stringify(request), /data:image|synthetic map image/);
  request.accept(await request.count(randomUUID()), Date.now() + 600000);
  const prepared = provider.prepareTextRequest(source);
  assert.equal(prepared.snapshot.contextWindow.counterId, STORY_MAP_COUNT_VERSION);
  assert.equal(prepared.snapshot.contextWindow.precision, 'exact');
  assert.equal(prepared.snapshot.estimatedInputTokens, 3210);
  assert.equal(counted, countRequestBody(prepared.body));
  assert.equal(
    JSON.parse(counted).input[0].content.filter((p) => p.type === 'input_image').length,
    1,
  );
  const restarted = new BoundedAuthoringTextProvider(
    storyPlanDefinition,
    'synthetic',
    transport,
    profile,
  );
  const result = await restarted.generate({
    jobId: randomUUID(),
    context: source,
    signal: new AbortController().signal,
    textReservationSnapshot: prepared.snapshot,
    maxCostMicros: prepared.snapshot.reserveMicros,
  });
  assert.equal(counts, 1);
  assert.equal(generations, 1);
  assert.equal(generated, prepared.body);
  const compiled = compileStoryPlan(source, result.proposal).playable;
  assert.ok(
    compiled.maps.tower.spawns.every(
      (p) => compiled.maps.tower.spatialGrounding.rows[p.y][p.x] === '.',
    ),
  );
  // Model-chosen spawn coordinates are ignored; the server places them on observed open floor.
  const unsafe = structuredClone(proposal);
  unsafe.rooms[0].spawns[0] = { x: 2, y: 8 };
  const placed = compileStoryPlan(source, unsafe).playable.maps.tower;
  assert.equal(placed.spawns.length, 4);
  assert.ok(placed.spawns.every((p) => placed.spatialGrounding.rows[p.y][p.x] === '.'));
  const noFloor = structuredClone(proposal);
  noFloor.rooms[0].spatialGrounding.rows = noFloor.rooms[0].spatialGrounding.rows.map((row) =>
    row.replace(/[.?]/g, '#'),
  );
  assert.throws(() => compileStoryPlan(source, noFloor), /MAP_IMAGE_UNSAFE_SPAWN/);
  source.title = 'Changed source';
  assert.throws(
    () => restarted.prepareTextRequest(source, prepared.snapshot),
    StoryMapCountRequired,
  );
  assert.equal(generations, 1, 'changed body cannot silently regenerate');
});

test('exact count has no image multiplier fallback and respects priced input tier', () => {
  const { source, profile } = fixture();
  const provider = new BoundedAuthoringTextProvider(
    storyPlanDefinition,
    'synthetic',
    () => assert.fail('no call'),
    profile,
  );
  const request = needCount(provider, source);
  request.accept(272001, Date.now() + 600000);
  assert.throws(() => provider.prepareTextRequest(source), /MAP_VISION_POLICY_REQUIRED/);
});

function receiptDb() {
  let row,
    locked = false,
    tail = Promise.resolve();
  const query = async (sql, args) => {
    if (sql.startsWith('SELECT pg_')) return { rows: [] };
    if (sql.startsWith('SELECT * FROM runtime_map')) return { rows: row ? [row] : [] };
    if (sql.startsWith('SELECT count')) return { rows: [{ n: 0 }] };
    if (sql.startsWith('INSERT INTO runtime_map')) {
      row = { id: args[0], status: 'dispatched', created_at: new Date() };
      return { rows: [] };
    }
    if (sql.includes("SET status='succeeded'")) {
      if (row.status !== 'dispatched') return { rows: [] };
      Object.assign(row, { status: 'succeeded', input_tokens: args[1] });
      return { rows: [row] };
    }
    if (sql.includes("SET status='unknown'")) {
      if (row.status === 'dispatched') row.status = 'unknown';
      return { rows: [] };
    }
    assert.fail(sql);
  };
  const db = {
    query: async (sql, args) => (await query(sql, args)).rows,
    tx: (work) => {
      const run = tail.then(async () => {
        locked = true;
        try {
          return await work({ query });
        } finally {
          locked = false;
        }
      });
      tail = run.catch(() => {});
      return run;
    },
  };
  return { db, isLocked: () => locked, row: () => row };
}
test('durable preflight checks access, releases SQL locks before transport and reuses known receipt', async () => {
  const { db, isLocked, row } = receiptDb();
  let calls = 0,
    authorizations = 0,
    accepted = 0;
  const request = new StoryMapCountRequired(
    'synthetic body',
    'synthetic',
    'version',
    async () => {
      assert.equal(isLocked(), false);
      calls++;
      return 123;
    },
    (tokens) => {
      assert.equal(tokens, 123);
      accepted++;
    },
  );
  const authorize = async () => {
    assert.equal(isLocked(), true);
    authorizations++;
  };
  await resolveStoryMapCount(db, 'owner', request, authorize);
  await resolveStoryMapCount(db, 'owner', request, authorize);
  assert.equal(calls, 1);
  assert.equal(accepted, 2);
  assert.equal(authorizations, 2);
  assert.equal(row().status, 'succeeded');
});
test('denied access, unknown count and erasure never produce a hidden retry or generation', async () => {
  const denied = receiptDb();
  let calls = 0;
  const r = new StoryMapCountRequired(
    'synthetic',
    'model',
    'v',
    async () => {
      calls++;
      throw new Error('connection lost');
    },
    () => assert.fail('must not accept'),
  );
  await assert.rejects(
    resolveStoryMapCount(denied.db, 'owner', r, async () => {
      throw new Error('ACCESS_REVOKED');
    }),
    /ACCESS_REVOKED/,
  );
  assert.equal(calls, 0);
  assert.equal(denied.row(), undefined);
  const uncertain = receiptDb();
  await assert.rejects(
    resolveStoryMapCount(uncertain.db, 'owner', r, async () => {}),
    (e) => e.getResponse().code === 'STORY_MAP_COUNT_UNAVAILABLE',
  );
  await assert.rejects(
    resolveStoryMapCount(uncertain.db, 'owner', r, async () => {}),
    (e) => e.getResponse().code === 'STORY_MAP_COUNT_UNRESOLVED',
  );
  assert.equal(calls, 1);
  assert.equal(uncertain.row().status, 'unknown');
  const erased = receiptDb();
  const e = new StoryMapCountRequired(
    'synthetic',
    'model',
    'v',
    async () => {
      erased.row().status = 'erased';
      return 123;
    },
    () => assert.fail('erased result'),
  );
  await assert.rejects(
    resolveStoryMapCount(erased.db, 'owner', e, async () => {}),
    (x) => x.getResponse().code === 'STORY_MAP_COUNT_UNAVAILABLE',
  );
  assert.equal(erased.row().status, 'erased');
});

test('uncertain quote-count UI reports a stopped request rather than inviting a blind retry', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../apps/web/lib/client.tsx'),
    'utf8',
  );
  for (const code of ['STORY_MAP_COUNT_UNAVAILABLE', 'STORY_MAP_COUNT_UNRESOLVED']) {
    const message = source.match(new RegExp(code + ":\\s*'([^']+)'")).at(1);
    assert.match(message, /Генерация не запускалась/);
    assert.doesNotMatch(message, /Попробуй|повтори|бесплатн/);
  }
});
