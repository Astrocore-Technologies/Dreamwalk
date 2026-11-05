process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs'),
  ts = require('typescript');
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
      fileName: filename,
    }).outputText,
    filename,
  );
const {
  validateTravelMapPlan,
  travelMapPlanDefinition,
  travelArrivalRoster,
} = require('../../apps/api/src/game/travel-map-plan.ts');
const {
  travelGroundingEnvelope,
  assertTravelGroundingSnapshot,
  travelGroundingConsentHash,
} = require('../../apps/api/src/generation/travel-grounding-envelope.ts');
const {
  verifyAcceptedTravelGrounding,
} = require('../../apps/api/src/generation/travel-grounding-consent.ts');
const { estimateTextRequest } = require('../../apps/api/src/generation/estimates.ts');
const { digest } = require('../../apps/api/src/ai/context.ts');
const gcore = require('../../packages/game-core/dist');
const hash = (v) => createHash('sha256').update(v).digest('hex');
function profile() {
  return {
    model: 'synthetic-vision',
    contextTokens: 128000,
    contextBudgetTokens: 32000,
    maxOutputTokens: 4096,
    maxInputBytes: 4194304,
    inputMicrosPerMillion: 1000000,
    outputMicrosPerMillion: 2000000,
    upperMicros: 100000,
    estimation: {
      kind: 'operator_heuristic',
      textTokensPerKiBUtf8: 300,
      textProtocolTokens: 4096,
      marginBps: 1000,
      fixedMarginMicros: 100,
    },
    storyVision: {
      model: 'synthetic-vision',
      counting: 'operational_exact',
      maxImages: 1,
      detail: 'high',
      billing: 'text_input_rate',
      maxPricedInputTokens: 32000,
      pricing: {
        source: 'https://example.invalid/fixture',
        reviewedAt: '2020-01-01',
        validUntil: '2030-01-01',
      },
    },
  };
}
function spatial() {
  const bytes = Buffer.from('synthetic raster');
  const image = {
    locationId: 'scene-fixture',
    revisionId: randomUUID(),
    sha256: hash('original'),
    inputSha256: hash(bytes),
    width: 768,
    height: 768,
    framing: 'contain-24x24',
    dataUrl: 'data:image/jpeg;base64,' + bytes.toString('base64'),
  };
  const context = {
    mapId: image.locationId,
    name: 'Cafe',
    description: 'An indoor cafe.',
    sourceChecksum: hash('source'),
    arrivals: [
      { id: 'player', kind: 'player', tokenSize: 'medium' },
      { id: 'companion', kind: 'npc', tokenSize: 'large' },
    ],
    mapImages: [image],
  };
  const plan = {
    version: 1,
    spatialGrounding: {
      version: 1,
      imageRevisionId: image.revisionId,
      imageSha256: image.sha256,
      confidence: 0.9,
      rows: Array.from({ length: 24 }, (_, y) =>
        Array.from({ length: 24 }, (_, x) =>
          x >= 4 && x <= 12 && y >= 4 && y <= 12 ? '.' : '?',
        ).join(''),
      ),
      landmarks: [],
    },
    spawns: [
      { x: 5, y: 5 },
      { x: 6, y: 5 },
      { x: 5, y: 6 },
      { x: 6, y: 6 },
    ],
    returnPoint: { x: 4, y: 4 },
    arrivals: [
      { id: 'player', x: 5, y: 5 },
      { id: 'companion', x: 8, y: 8 },
    ],
  };
  return { context, plan };
}
test('actual raster evidence admits all and only named travellers, leaving uncertainty unchanged', () => {
  const f = spatial(),
    before = structuredClone(f);
  assert.deepEqual(validateTravelMapPlan(f.context, f.plan), f.plan);
  assert.deepEqual(f, before);
  assert.equal(travelMapPlanDefinition.purpose, 'story_plan');
});
for (const [name, mutate] of [
  ['stale image', (f) => (f.plan.spatialGrounding.imageRevisionId = randomUUID())],
  ['wrong hash', (f) => (f.plan.spatialGrounding.imageSha256 = hash('wrong'))],
  ['low confidence', (f) => (f.plan.spatialGrounding.confidence = 0.849)],
  ['unknown player cell', (f) => (f.plan.spawns[0] = { x: 2, y: 2 })],
  ['unknown return point', (f) => (f.plan.returnPoint = { x: 2, y: 2 })],
  ['duplicate spawn', (f) => (f.plan.spawns[1] = f.plan.spawns[0])],
  ['missing companion', (f) => f.plan.arrivals.pop()],
  ['foreign arrival', (f) => (f.plan.arrivals[1].id = 'offstage')],
  ['overlapping footprints', (f) => (f.plan.arrivals[1] = { id: 'companion', x: 5, y: 5 })],
  ['unsafe large footprint', (f) => (f.plan.arrivals[1] = { id: 'companion', x: 12, y: 12 })],
  ['return point under companion', (f) => (f.plan.returnPoint = { x: 9, y: 9 })],
  [
    'fabricated door',
    (f) => (f.plan.spatialGrounding.doors = [{ x: 4, y: 4, label: 'Door', open: true }]),
  ],
])
  test(`geometry fails closed: ${name}`, () => {
    const f = spatial();
    mutate(f);
    assert.throws(() => validateTravelMapPlan(f.context, f.plan));
  });
function financial() {
  const ownerId = randomUUID(),
    preparationId = randomUUID(),
    batchId = randomUUID(),
    nativeQuoteId = randomUUID(),
    p = profile();
  const envelope = travelGroundingEnvelope(p, 'synthetic-v1', {
    preparationId,
    sourceChecksum: hash('source'),
    imageRequestHash: hash('request'),
    authorizationId: randomUUID(),
    policyRevision: 1,
    policyHash: hash('policy'),
  });
  const quote = {
    id: randomUUID(),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    sparkReservedSubunits: String(envelope.reserveMicros * 100),
  };
  const request = {
    id: preparationId,
    requester_user_id: ownerId,
    campaign_id: randomUUID(),
    context: { frozen: 'unchanged' },
    status: 'queued',
    job_id: null,
  };
  const state = gcore.initializeTurnController(gcore.createObservatoryState(['player']), [
    'player',
  ]).state;
  const prep = {
    id: preparationId,
    state: 'accepted',
    owner_id: ownerId,
    batch_id: batchId,
    campaign_id: request.campaign_id,
    source_checksum: envelope.sourceChecksum,
    input_hash: envelope.imageRequestHash,
    image_job_id: randomUUID(),
  };
  const { context } = spatial();
  const g = {
    project_id: preparationId,
    status: 'bound',
    envelope,
    quote,
    context,
    context_hash: digest(context),
    image_revision_id: context.mapImages[0].revisionId,
    image_sha256: context.mapImages[0].sha256,
    native_quote_id: nativeQuoteId,
  };
  const batch = {
    id: batchId,
    state: 'accepted',
    owner_id: ownerId,
    campaign_id: prep.campaign_id,
    accepted_at: new Date(Date.now() - 2000),
    expires_at: new Date(Date.now() - 1000),
    turn_fence: gcore.turnFence(state),
    entries: [{ requestId: preparationId, contextDigest: digest(request.context) }],
    media_entries: [{ preparationId, grounding: { envelope, quote } }],
  };
  batch.quote = {
    travelGroundingPolicyHash: travelGroundingConsentHash(batch.entries, batch.media_entries),
  };
  const snapshot = estimateTextRequest('{}', p, 'synthetic-v1', {
    id: 'synthetic-exact',
    precision: 'exact',
    supports: () => true,
    countInput: () => 1000,
  });
  const native = {
    id: nativeQuoteId,
    actor_id: ownerId,
    project_id: preparationId,
    session_id: envelope.authorizationId,
    generation_policy_revision: 1,
    generation_policy_hash: envelope.policyHash,
    source_hash: prep.source_checksum,
    readset_hash: g.context_hash,
    context_hash: g.context_hash,
    context: structuredClone(context),
    provider_version: 'synthetic-v1',
    request_snapshot: snapshot,
    upper_micros: snapshot.reserveMicros,
    spark_quote_id: randomUUID(),
  };
  const campaign = { state, status: 'active', owner_id: ownerId };
  const image = { status: 'admitted', admitted_revision_id: g.image_revision_id };
  const spark = { reserve_subunits: String(snapshot.reserveMicros * 100) };
  const f = {
    p,
    prep,
    g,
    batch,
    native,
    campaign,
    image,
    spark,
    request,
    proof: { preparationId, batchId, nativeQuoteId },
    ownerId,
  };
  f.client = {
    query: async (sql) => ({
      rows: [
        sql.includes('game_location_travel_preparations')
          ? prep
          : sql.includes('game_travel_map_groundings')
            ? g
            : sql.includes('game_world_generation_batches')
              ? batch
              : sql.includes('live_authoring_text_quotes')
                ? native
                : sql.includes('game_campaigns')
                  ? campaign
                  : sql.includes('image_generation_jobs')
                    ? image
                    : sql.includes('spark_quotes')
                      ? spark
                      : sql.includes('game_npc_decision_requests')
                        ? request
                        : assert.fail(sql),
      ],
    }),
  };
  return f;
}
test('exact child inside original accepted envelope needs no second consent, even after quote expires', async () => {
  const f = financial();
  await verifyAcceptedTravelGrounding(f.client, f.ownerId, f.proof, f.p, 'synthetic-v1');
});
for (const [name, mutate] of [
  ['unaccepted batch', (f) => (f.batch.accepted_at = null)],
  ['changed aggregate', (f) => f.batch.entries.push({ requestId: randomUUID() })],
  ['different payer', (f) => (f.batch.owner_id = randomUUID())],
  ['changed source', (f) => (f.prep.source_checksum = hash('other'))],
  ['changed image request', (f) => (f.prep.input_hash = hash('other'))],
  ['changed context', (f) => (f.native.context.name = 'other')],
  ['different image revision', (f) => (f.image.admitted_revision_id = randomUUID())],
  ['unadmitted image', (f) => (f.image.status = 'generated')],
  ['different authorization', (f) => (f.native.session_id = randomUUID())],
  ['different policy', (f) => (f.native.generation_policy_hash = hash('other'))],
  ['changed input ceiling', (f) => f.g.envelope.maxInputTokens++],
  ['changed tariff', (f) => f.p.inputMicrosPerMillion++],
  [
    'uncounted exact body',
    (f) => (f.native.request_snapshot.contextWindow.precision = 'conservative_estimate'),
  ],
  [
    'too many input tokens',
    (f) => (f.native.request_snapshot.estimatedInputTokens = f.g.envelope.maxInputTokens + 1),
  ],
  [
    'excess monetary reserve',
    (f) => (f.native.request_snapshot.reserveMicros = f.g.envelope.reserveMicros + 1),
  ],
  ['excess output ceiling', (f) => f.native.request_snapshot.maxOutputTokens++],
  ['bigger wallet reserve', (f) => (f.spark.reserve_subunits = '999999999999999')],
  ['changed round fence', (f) => f.campaign.state.turnController.phaseEpoch++],
  ['cancelled text sibling', (f) => (f.request.status = 'failed')],
  ['already dispatched text', (f) => (f.request.job_id = randomUUID())],
  ['changed original text', (f) => (f.request.context.frozen = 'changed')],
])
  test(`compound proof rejects ${name}`, async () => {
    const f = financial();
    mutate(f);
    await assert.rejects(() =>
      verifyAcceptedTravelGrounding(f.client, f.ownerId, f.proof, f.p, 'synthetic-v1'),
    );
  });
test('future allowance is explicitly not an exact request snapshot', () => {
  const f = financial();
  assert.equal(f.g.envelope.kind, 'one_future_travel_raster');
  assert.equal(f.g.envelope.maxRequests, 1);
  assert.equal(f.g.envelope.maxImages, 1);
  assert.equal(f.g.envelope.bodySha256, undefined);
  assertTravelGroundingSnapshot(f.g.envelope, f.native.request_snapshot, f.p, 'synthetic-v1');
});
test('guess-based vision cannot be budgeted as exact future-raster work', () => {
  const p = profile();
  delete p.storyVision.counting;
  p.storyVision.inputTokensPerImage = 2000;
  assert.throws(() => travelGroundingEnvelope(p, 'v', {}), /MAP_VISION_POLICY_REQUIRED/);
});
const { resolveStoryMapCount } = require('../../apps/api/src/live-test/story-map-count-receipt.ts');
test('future-raster count replay uses its exact immutable receipt after cache expiry', async () => {
  let calls = 0,
    accepted;
  const request = {
    bodySha256: hash('body'),
    providerVersion: 'v',
    model: 'm',
    count: async () => {
      calls++;
      return 999;
    },
    accept: (tokens) => {
      accepted = tokens;
    },
  };
  const receipt = {
    status: 'succeeded',
    body_sha256: request.bodySha256,
    provider_version: 'v',
    model: 'm',
    input_tokens: 123,
    created_at: new Date(0),
  };
  const db = {
    tx: async (work) =>
      work({
        query: async (sql) => ({
          rows: sql.includes('SELECT g.count_id')
            ? [{ count_id: 'count' }]
            : sql.includes('SELECT * FROM runtime_map_token_counts')
              ? [receipt]
              : [],
        }),
      }),
    query: () => assert.fail('no network receipt write on replay'),
  };
  await resolveStoryMapCount(db, 'owner', request, async () => {}, {
    preparationId: 'prep',
    batchId: 'batch',
    contextHash: 'hash',
  });
  assert.equal(calls, 0);
  assert.equal(accepted, 123);
  receipt.status = 'unknown';
  await assert.rejects(
    () =>
      resolveStoryMapCount(db, 'owner', request, async () => {}, {
        preparationId: 'prep',
        batchId: 'batch',
        contextHash: 'hash',
      }),
    /STORY_MAP_COUNT_UNRESOLVED/,
  );
  assert.equal(calls, 0);
  receipt.status = 'succeeded';
  receipt.body_sha256 = hash('different');
  await assert.rejects(
    () =>
      resolveStoryMapCount(db, 'owner', request, async () => {}, {
        preparationId: 'prep',
        batchId: 'batch',
        contextHash: 'hash',
      }),
    /STORY_MAP_QUOTE_CHANGED/,
  );
});
test('count authorization and durable binding failure both stop before remote count', async () => {
  let calls = 0;
  const request = {
    bodySha256: hash('body'),
    providerVersion: 'v',
    model: 'm',
    count: async () => {
      calls++;
      return 1;
    },
    accept: () => {},
  };
  const client = {
      query: async (sql) => ({
        rows: sql.includes('SELECT g.count_id') ? [{}] : sql.includes('count(*)') ? [{ n: 0 }] : [],
        rowCount: 0,
      }),
    },
    db = {
      tx: async (work) => work(client),
      query: () => assert.fail('must not update receipt outside rejected admission'),
    };
  await assert.rejects(
    () =>
      resolveStoryMapCount(
        db,
        'owner',
        request,
        async () => {
          throw Error('DENIED');
        },
        { preparationId: 'prep', batchId: 'batch', contextHash: 'hash' },
      ),
    /DENIED/,
  );
  await assert.rejects(
    () =>
      resolveStoryMapCount(db, 'owner', request, async () => {}, {
        preparationId: 'prep',
        batchId: 'batch',
        contextHash: 'hash',
      }),
    /STORY_MAP_QUOTE_CHANGED/,
  );
  assert.equal(calls, 0);
});

test('committed count receipt survives lost SQL response without another external count', async () => {
  let calls = 0,
    accepted,
    receipt;
  const request = {
    bodySha256: hash('body'),
    providerVersion: 'v',
    model: 'm',
    count: async () => {
      calls++;
      return 123;
    },
    accept: (tokens) => {
      accepted = tokens;
    },
  };
  const db = {
    tx: async (work) =>
      work({
        query: async (sql) => ({
          rows: sql.includes('SELECT g.count_id')
            ? [{}]
            : sql.includes('count(*)')
              ? [{ n: 0 }]
              : [],
          rowCount: 1,
        }),
      }),
    query: async (sql, values) => {
      if (sql.includes("SET status='succeeded'")) {
        receipt = {
          status: 'succeeded',
          actor_id: 'owner',
          body_sha256: request.bodySha256,
          provider_version: 'v',
          model: 'm',
          input_tokens: values[1],
        };
        throw Error('SQL_RESPONSE_LOST');
      }
      if (sql.includes('SELECT c.*')) return [receipt];
      assert.fail('must not downgrade succeeded receipt');
    },
  };
  await resolveStoryMapCount(db, 'owner', request, async () => {}, {
    preparationId: 'prep',
    batchId: 'batch',
    contextHash: 'hash',
  });
  assert.equal(calls, 1);
  assert.equal(accepted, 123);
});

test('arrival roster includes consenting visible companions but never offstage or unrelated NPCs', () => {
  const state = gcore.createObservatoryState(['player']);
  state.entities.keeper.x = 3;
  state.entities.keeper.y = 6;
  state.entities.keeper.tokenSize = 'large';
  state.npcBrains = { keeper: { living: { companionship: { actorId: 'player' } } } };
  assert.deepEqual(
    travelArrivalRoster(state, 'player').map((a) => a.id),
    ['player', 'keeper'],
  );
  assert.equal(travelArrivalRoster(state, 'player')[1].tokenSize, 'large');
  state.entities.keeper.mapId = 'offstage';
  assert.deepEqual(
    travelArrivalRoster(state, 'player').map((a) => a.id),
    ['player'],
  );
  state.entities.keeper.mapId = state.entities.player.mapId;
  state.npcBrains.keeper.living.companionship.actorId = 'someone-else';
  assert.deepEqual(
    travelArrivalRoster(state, 'player').map((a) => a.id),
    ['player'],
  );
});

const { travelToLocation } = require('../../packages/game-core/src/location-travel.ts');
function revisitFixture() {
  const state = gcore.createObservatoryState(['player']);
  state.rulesetVersion = 'hybrid-v3';
  state.entities.keeper.x = 3;
  state.entities.keeper.y = 6;
  state.entities.keeper.tokenSize = 'large';
  state.npcBrains = { keeper: { living: { companionship: { actorId: 'player' } } } };
  const { plan } = spatial();
  state.maps.revisit = {
    ...structuredClone(state.maps.observatory),
    id: 'revisit',
    width: 24,
    height: 24,
    blocked: [],
    exits: [],
    spawns: plan.spawns,
    spatialGrounding: plan.spatialGrounding,
  };
  state.artBindings = [
    {
      slot: 'map:revisit:background',
      revisionId: plan.spatialGrounding.imageRevisionId,
      sha256: plan.spatialGrounding.imageSha256,
      mime: 'image/png',
      width: 768,
      height: 768,
    },
  ];
  for (const [i, spawn] of plan.spawns.entries())
    state.entities[`resident-${i}`] = {
      ...structuredClone(state.entities.player),
      id: `resident-${i}`,
      mapId: 'revisit',
      ...spawn,
    };
  return state;
}
test('revisit with occupied saved spawns places player and large companion only on connected observed floor', () => {
  const state = revisitFixture(),
    result = travelToLocation(state, 'player', 'revisit');
  assert.equal(result.error, undefined);
  for (const id of ['player', 'keeper']) {
    const e = result.state.entities[id];
    assert.equal(e.mapId, 'revisit');
    const size = id === 'keeper' ? 2 : 1;
    for (let y = e.y; y < e.y + size; y++)
      for (let x = e.x; x < e.x + size; x++)
        assert.equal(result.state.maps.revisit.spatialGrounding.rows[y][x], '.');
  }
  for (let i = 0; i < 4; i++)
    assert.deepEqual(result.state.entities[`resident-${i}`], state.entities[`resident-${i}`]);
});
test('revisit never invents space on unknown raster or accepts a stale background binding', () => {
  const state = revisitFixture();
  state.artBindings[0].sha256 = hash('changed');
  const stale = travelToLocation(state, 'player', 'revisit');
  assert.equal(stale.error, 'TARGET_UNAVAILABLE');
  assert.equal(stale.state, state);
  state.artBindings[0].sha256 = state.maps.revisit.spatialGrounding.imageSha256;
  state.maps.revisit.spatialGrounding.rows = Array.from({ length: 24 }, (_, y) =>
    Array.from({ length: 24 }, (_, x) =>
      state.maps.revisit.spawns.some((p) => p.x === x && p.y === y) ||
      (x >= 16 && x <= 20 && y >= 16 && y <= 20)
        ? '.'
        : '?',
    ).join(''),
  );
  const full = travelToLocation(state, 'player', 'revisit');
  assert.equal(full.error, 'PATH_BLOCKED');
  assert.equal(full.state, state);
});

test('a large companion stays behind when observed arrival floor has room only for the player', () => {
  const state = revisitFixture();
  const map = state.maps.revisit;
  map.spatialGrounding.rows = Array.from({ length: 24 }, (_, y) =>
    Array.from({ length: 24 }, (_, x) =>
      map.spawns.some((p) => p.x === x && p.y === y) || (x === 7 && y === 5) ? '.' : '?',
    ).join(''),
  );
  const result = travelToLocation(state, 'player', 'revisit');
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.player.mapId, 'revisit');
  assert.deepEqual(result.state.entities.keeper, state.entities.keeper);
});

test('fixed-exit transition rejects a large footprint crossing unknown pixels without changing movement collision', () => {
  const state = revisitFixture();
  state.entities.player.tokenSize = 'large';
  state.maps.observatory.exits = [
    {
      id: 'verified-return',
      x: 2,
      y: 6,
      destinationMapId: 'revisit',
      destination: { x: 12, y: 12 },
    },
  ];
  const result = gcore.applyAction(state, 'player', {
    kind: 'transition',
    targetId: 'verified-return',
  });
  assert.equal(result.error, 'PATH_BLOCKED');
  assert.equal(result.state, state);
});

test('arrival observations are recorded from grounded positions, never provisional template coordinates', () => {
  const draft = gcore.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  const state = gcore.createStateFromPlayable(gcore.compilePlayableDraft(draft).playable, [
    'player',
  ]);
  state.entities.friend = { ...structuredClone(state.entities.keeper), id: 'friend', x: 12, y: 6 };
  state.npcBrains.friend = structuredClone(state.npcBrains.keeper);
  for (const id of Object.keys(state.entities))
    if (!['player', 'keeper', 'friend'].includes(id)) delete state.entities[id];
  Object.assign(state.entities.player, { x: 7, y: 6 });
  Object.assign(state.entities.keeper, { x: 2, y: 6 });
  state.maps[state.entities.player.mapId].blocked = [];
  for (const id of ['keeper', 'friend']) {
    state.npcBrains[id].living.companionship = { actorId: 'player', crossings: [] };
    state.npcBrains[id].living.observations = [];
  }
  assert.equal(gcore.visible(state, state.entities.keeper, state.entities.friend), false);
  const input = {
      operationId: randomUUID(),
      text: '*I go to New Cafe*',
      channel: 'say',
      expectedCanonRevision: 0,
      replyLocale: 'en',
    },
    turnId = randomUUID();
  const proposal = gcore.createMockStoryTurnProposal(state, 'player', input, turnId);
  const { plan } = spatial();
  plan.arrivals = [
    { id: 'player', x: 6, y: 8 },
    { id: 'keeper', x: 8, y: 8 },
    { id: 'friend', x: 10, y: 8 },
  ];
  const { applyTravelMapPlacement } = require('../../apps/api/src/game/travel-map-plan.ts');
  const result = gcore.applyStoryTurnProposal(state, 'player', input, turnId, proposal, {
    prepareTravelPlacement: (provisional) => {
      const next = applyTravelMapPlacement(provisional, `scene-${turnId}`, plan);
      next.artBindings = [
        {
          slot: `map:scene-${turnId}:background`,
          revisionId: plan.spatialGrounding.imageRevisionId,
          sha256: plan.spatialGrounding.imageSha256,
          mime: 'image/png',
          width: 768,
          height: 768,
        },
      ];
      return next;
    },
  });
  assert.equal(result.error, undefined);
  const sightings = result.state.npcBrains.keeper.living.observations.filter(
    (o) => o.kind === 'actor_seen' && o.actorId === 'friend',
  );
  assert.ok(sightings.length > 0);
  assert.ok(
    sightings.every((o) => o.mapId === `scene-${turnId}` && o.point.x === 10 && o.point.y === 8),
  );
});
