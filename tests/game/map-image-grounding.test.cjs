/** Synthetic image inputs only. No provider requests and no user raster is committed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { contentSchema } = require('../../packages/contracts/dist');
const { compileStoryPlan, storyPlanDefinition } = require('../../apps/api/dist/game/story-plan');
const {
  buildAuthoringTextRequestBody,
  BoundedAuthoringTextProvider,
} = require('../../apps/api/dist/live-test/authoring-provider');
const { readStoryImages } = require('../../apps/api/dist/ai/story-vision');
const { spatialContext } = require('../../packages/game-core/dist/spatial-context');
const g = require('../../packages/game-core/dist');
const hash = (v) => createHash('sha256').update(v).digest('hex');
function fixture() {
  const bytes = Buffer.from('synthetic raster transport bytes');
  const image = {
    locationId: 'room',
    revisionId: randomUUID(),
    sha256: hash('source'),
    inputSha256: hash(bytes),
    width: 768,
    height: 768,
    framing: 'contain-24x24',
    dataUrl: 'data:image/jpeg;base64,' + bytes.toString('base64'),
  };
  const source = {
    title: 'Coastal tower',
    content: contentSchema.parse({
      locations: [
        { id: 'room', name: 'Tower', description: 'A lit corridor inside a tower above the sea.' },
      ],
    }),
    npcs: [],
    mapImages: [image],
  };
  const rows = Array.from({ length: 24 }, (_, y) =>
    Array.from({ length: 24 }, (_, x) =>
      x >= 12 && x <= 17 && y >= 2 && y <= 21 ? '.' : x < 12 ? '~' : '#',
    ).join(''),
  );
  const grounding = {
    version: 1,
    imageRevisionId: image.revisionId,
    imageSha256: image.sha256,
    confidence: 0.95,
    rows,
    landmarks: [
      { label: 'Lit corridor', kind: 'room', x: 12, y: 6, width: 6, height: 6 },
      { label: 'Distant rock', kind: 'rock', x: 23, y: 23, width: 1, height: 1 },
    ],
  };
  const proposal = {
    version: 1,
    rooms: [
      {
        locationId: 'room',
        width: 24,
        height: 24,
        spawns: [
          { x: 14, y: 8 },
          { x: 15, y: 8 },
          { x: 14, y: 9 },
          { x: 15, y: 9 },
        ],
        blocked: [],
        surfaces: [],
        spatialGrounding: grounding,
      },
    ],
    connections: [],
    npcs: [],
    items: [],
  };
  const profile = {
    model: 'synthetic-vision',
    contextTokens: 1050000,
    contextBudgetTokens: 60000,
    maxOutputTokens: 8192,
    maxInputBytes: 4194304,
    inputMicrosPerMillion: 100000,
    outputMicrosPerMillion: 500000,
    upperMicros: 10000,
    estimation: {
      kind: 'operator_heuristic',
      textTokensPerKiBUtf8: 300,
      textProtocolTokens: 4096,
      marginBps: 1000,
      fixedMarginMicros: 100,
    },
    storyVision: {
      model: 'synthetic-vision',
      inputTokensPerImage: 2000,
      maxImages: 4,
      detail: 'high',
      billing: 'text_input_rate',
      maxPricedInputTokens: 272000,
      pricing: {
        source: 'https://developers.openai.com/api/docs/guides/images-vision',
        reviewedAt: '2026-01-01T00:00:00Z',
        validUntil: '2029-01-01T00:00:00Z',
      },
    },
  };
  return { source, proposal, profile };
}
test('actual image content, identity and contain framing reach provider; bytes are not JSON prompt text', () => {
  const { source, profile } = fixture();
  const body = JSON.parse(buildAuthoringTextRequestBody(storyPlanDefinition, profile, source));
  assert.equal(body.input[0].content.filter((v) => v.type === 'input_image').length, 1);
  assert.equal(body.input[0].content[2].image_url, source.mapImages[0].dataUrl);
  const text = JSON.parse(body.input[0].content[0].text);
  assert.equal(text.mapImages[0].dataUrl, undefined);
  assert.equal(text.mapImages[0].framing, 'contain-24x24');
});
test('quote counts images separately from base64 transport; one request snapshot pins exact bytes', () => {
  const { source, profile } = fixture();
  const provider = new BoundedAuthoringTextProvider(
    storyPlanDefinition,
    undefined,
    () => assert.fail('network'),
    profile,
  );
  const a = provider.prepareTextRequest(source);
  source.mapImages[0].dataUrl =
    'data:image/jpeg;base64,' + Buffer.alloc(200000, 65).toString('base64');
  source.mapImages[0].inputSha256 = hash(Buffer.alloc(200000, 65));
  const b = provider.prepareTextRequest(source);
  assert.equal(a.snapshot.estimatedInputTokens, b.snapshot.estimatedInputTokens);
  assert.notEqual(a.snapshot.bodySha256, b.snapshot.bodySha256);
  assert.equal(b.snapshot.contextWindow.counterId, 'reviewed-image-allowance-v1');
});
test('missing, expired, wrong model or uncovered pricing stops before dispatch, legacy text still works', () => {
  const { source, profile } = fixture();
  for (const storyVision of [
    undefined,
    { ...profile.storyVision, model: 'other' },
    { ...profile.storyVision, maxPricedInputTokens: 1 },
    {
      ...profile.storyVision,
      pricing: { ...profile.storyVision.pricing, validUntil: '2020-01-01T00:00:00Z' },
    },
  ]) {
    const provider = new BoundedAuthoringTextProvider(
      storyPlanDefinition,
      undefined,
      () => assert.fail('network'),
      { ...profile, storyVision },
    );
    assert.throws(() => provider.prepareTextRequest(source), /MAP_VISION_POLICY_REQUIRED/);
  }
  delete source.mapImages;
  assert.equal(
    typeof JSON.parse(
      buildAuthoringTextRequestBody(
        storyPlanDefinition,
        { ...profile, storyVision: undefined },
        source,
      ),
    ).input,
    'string',
  );
});
test('image hash mismatch and duplicate image associations fail closed', () => {
  const { source } = fixture();
  source.mapImages[0].inputSha256 = 'f'.repeat(64);
  assert.throws(() => readStoryImages(source), /INTEGRITY/);
  const fresh = fixture().source;
  fresh.mapImages.push(fresh.mapImages[0]);
  assert.throws(() => readStoryImages(fresh), /DUPLICATE/);
});
test('grounded safe floor spawns compile with advisory terrain and no invented hard walls', () => {
  const { source, proposal } = fixture();
  const { draft, playable } = compileStoryPlan(source, proposal);
  assert.deepEqual(draft.maps[0].blocked, []);
  const state = g.createStateFromPlayable(playable, ['hero']);
  assert.deepEqual({ x: state.entities.hero.x, y: state.entities.hero.y }, { x: 14, y: 8 });
  const context = spatialContext(state, 'hero');
  assert.equal(context.rows[8][14], '.');
  assert.equal(
    context.landmarks.some((l) => l.label === 'Distant rock'),
    false,
  );
  assert.equal(
    g.buildNarrativeContext(state, 'hero', 'Where is the corridor?').spatialContext.landmarks[0]
      .label,
    'Lit corridor',
  );
});
test('rocks, water, unknown, disconnected floor and low confidence never become random starts', () => {
  for (const cell of ['~', '#', '?', 'X', 'D']) {
    const { source, proposal } = fixture();
    const r = proposal.rooms[0];
    // No original safe anchor remains: the bounded repair must not choose
    // an unrelated opening merely because some other floor exists.
    for (const point of r.spawns)
      r.spatialGrounding.rows[point.y] =
        r.spatialGrounding.rows[point.y].slice(0, point.x) +
        cell +
        r.spatialGrounding.rows[point.y].slice(point.x + 1);
    assert.throws(() => compileStoryPlan(source, proposal), /UNSAFE_SPAWN/);
  }
  const { source, proposal } = fixture();
  proposal.rooms[0].spatialGrounding.confidence = 0.2;
  assert.throws(() => compileStoryPlan(source, proposal), /UNCERTAIN/);
  const f = fixture();
  const r = f.proposal.rooms[0];
  r.spawns[3] = { x: 2, y: 2 };
  r.spatialGrounding.rows[2] = '~~.' + r.spatialGrounding.rows[2].slice(3);
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /DISCONNECTED_SPAWN/);
});
test('stale source image, duplicate geometry and anonymous grounding cannot silently apply', () => {
  const { source, proposal } = fixture();
  proposal.rooms[0].spatialGrounding.imageRevisionId = randomUUID();
  assert.throws(() => compileStoryPlan(source, proposal), /SOURCE_MISMATCH/);
  const f = fixture();
  f.proposal.rooms[0].blocked = [{ x: 3, y: 3 }];
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /DUPLICATE_GEOMETRY/);
  const v = fixture();
  delete v.source.mapImages;
  assert.throws(() => compileStoryPlan(v.source, v.proposal), /SOURCE_MISMATCH/);
});
test('changed displayed image stops stale landmark context', () => {
  const { source, proposal } = fixture();
  const state = g.createStateFromPlayable(compileStoryPlan(source, proposal).playable, ['hero']);
  state.artBindings = [{ slot: 'map:room:background', revisionId: randomUUID() }];
  assert.equal(spatialContext(state, 'hero'), undefined);
});

test('owned raster loader checks rights and hash, then matches contain framing without network', async () => {
  const fs = require('node:fs/promises'),
    os = require('node:os'),
    path = require('node:path');
  const sharp = require('sharp');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'map-image-test-'));
  const configModule = require.resolve('../../apps/api/dist/config');
  const previous = require.cache[configModule];
  require.cache[configModule] = {
    id: configModule,
    filename: configModule,
    loaded: true,
    exports: { config: { ASSET_DIR: dir } },
  };
  try {
    const { prepareStoryMapImages } = require('../../apps/api/dist/game/story-map-images');
    const bytes = await sharp({
      create: { width: 800, height: 400, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    await fs.writeFile(path.join(dir, 'map.png'), bytes);
    const id = randomUUID();
    let calls = 0;
    const row = {
      filename: 'map.png',
      sha256: hash(bytes),
      metadata: { kind: 'background', camera: 'top-down' },
    };
    const assets = {
      reusableRevisionTx: async (c, owner, revision) => {
        calls++;
        assert.equal(owner, 'owner');
        assert.equal(revision, id);
        return { row };
      },
    };
    const [image] = await prepareStoryMapImages({}, assets, 'owner', [
      { location_id: 'room', revision_id: id },
    ]);
    assert.equal(calls, 1);
    assert.equal(image.sha256, hash(bytes));
    assert.equal(image.revisionId, id);
    const decoded = await sharp(Buffer.from(image.dataUrl.split(',')[1], 'base64'))
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, 768);
    assert.equal(decoded.info.height, 768);
    assert.equal(decoded.data[(100 * 768 + 300) * 3], 0);
    assert.ok(decoded.data[(384 * 768 + 384) * 3] > 245);
    row.sha256 = 'f'.repeat(64);
    await assert.rejects(
      prepareStoryMapImages({}, assets, 'owner', [{ location_id: 'room', revision_id: id }]),
      /ASSET_INTEGRITY_FAILED/,
    );
    row.filename = '../secret';
    await assert.rejects(
      prepareStoryMapImages({}, assets, 'owner', [{ location_id: 'room', revision_id: id }]),
      /MAP_IMAGE_UNAVAILABLE/,
    );
    await assert.rejects(
      prepareStoryMapImages(
        {},
        {
          reusableRevisionTx: async () => {
            throw Error('FORBIDDEN');
          },
        },
        'other',
        [{ location_id: 'room', revision_id: id }],
      ),
      /FORBIDDEN/,
    );
  } finally {
    if (previous) require.cache[configModule] = previous;
    else delete require.cache[configModule];
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('depicted doors remain RP observations, never automatic locks or movement barriers', () => {
  const { source, proposal } = fixture();
  const r = proposal.rooms[0];
  r.spatialGrounding.rows[12] =
    r.spatialGrounding.rows[12].slice(0, 14) + 'D' + r.spatialGrounding.rows[12].slice(15);
  r.spatialGrounding.doors = [{ x: 14, y: 12, label: 'Corridor door', open: false }];
  const { draft } = compileStoryPlan(source, proposal);
  assert.equal(draft.objects.length, 0);
  assert.equal(draft.maps[0].spatialGrounding.doors[0].open, false);
  assert.deepEqual(draft.maps[0].blocked, []);
  r.spatialGrounding.doors[0].x = 2;
  assert.throws(() => compileStoryPlan(source, proposal), /UNSAFE_PASSAGE/);
});

test('mock dispatch sends exactly the consented image body once, stale bytes never dispatch', async () => {
  const { source, profile, proposal } = fixture();
  let calls = 0,
    sent;
  const provider = new BoundedAuthoringTextProvider(
    storyPlanDefinition,
    'synthetic-test-key',
    async (url, init) => {
      calls++;
      sent = init.body;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      return new Response(
        JSON.stringify({
          id: 'synthetic-response',
          status: 'completed',
          service_tier: 'default',
          usage: { input_tokens: 4000, output_tokens: 1000 },
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] },
          ],
        }),
        { status: 200 },
      );
    },
    profile,
  );
  const prepared = provider.prepareTextRequest(source);
  const result = await provider.generate({
    jobId: randomUUID(),
    context: source,
    signal: new AbortController().signal,
    textReservationSnapshot: prepared.snapshot,
    maxCostMicros: prepared.snapshot.reserveMicros,
  });
  assert.equal(calls, 1);
  assert.equal(sent, prepared.body);
  assert.equal(
    result.proposal.rooms[0].spatialGrounding.imageRevisionId,
    source.mapImages[0].revisionId,
  );
  source.mapImages[0].revisionId = randomUUID();
  await assert.rejects(
    provider.generate({
      jobId: randomUUID(),
      context: source,
      signal: new AbortController().signal,
      textReservationSnapshot: prepared.snapshot,
      maxCostMicros: prepared.snapshot.reserveMicros,
    }),
    /PROVIDER_REQUEST_SNAPSHOT_CHANGED/,
  );
  assert.equal(calls, 1);
});

test('NPC placement checks the entire creature footprint, not just its anchor', () => {
  const { source, proposal } = fixture(),
    id = randomUUID();
  source.content.npcIds = [id];
  source.npcs = [
    { id, name: 'Guardian', role: 'guard', description: 'A large guardian.', appearance: 'Large' },
  ];
  proposal.npcs = [
    { sourceNpcId: id, tokenSize: 'large', locationId: 'room', x: 12, y: 12, stock: [] },
  ];
  assert.ok(compileStoryPlan(source, proposal).playable);
  proposal.npcs[0].x = 17;
  assert.throws(() => compileStoryPlan(source, proposal), /UNSAFE_NPC/);
});

test('raster walls and closed observed doors occlude knowledge without movement collision', () => {
  const { source, proposal } = fixture();
  const state = g.createStateFromPlayable(compileStoryPlan(source, proposal).playable, ['hero']);
  const grounding = state.maps.room.spatialGrounding;
  grounding.landmarks = [
    { label: 'Unseen room name', kind: 'room', x: 13, y: 10, width: 4, height: 4 },
  ];
  const put = (x, y, cell) =>
    (grounding.rows[y] = grounding.rows[y].slice(0, x) + cell + grounding.rows[y].slice(x + 1));
  for (let x = 0; x < 24; x++) put(x, 11, '#');
  let context = spatialContext(state, 'hero');
  assert.equal(context.rows[11][14], '#');
  assert.equal(context.rows[12][14], '?');
  assert.equal(JSON.stringify(context).includes('Unseen room name'), false);
  assert.ok(context.landmarks[0].visibleCells.every((p) => p.y <= 11));
  assert.equal('height' in context.landmarks[0], false);
  assert.deepEqual(state.maps.room.blocked, []);
  assert.equal(g.walkable(state, 'room', { x: 14, y: 12 }), true);
  const hidden = { id: 'hidden', kind: 'item', mapId: 'room', x: 14, y: 12, revision: 0 };
  state.entities.hidden = hidden;
  assert.equal(
    g.visible(state, state.entities.hero, hidden),
    true,
    'action visibility stays unchanged',
  );
  assert.equal(
    g
      .buildNarrativeContext(state, 'hero', 'Look around')
      .visibleEntities.some((e) => e.id === 'hidden'),
    false,
  );
  state.entities.watcher = { id: 'watcher', kind: 'npc', mapId: 'room', x: 14, y: 10, revision: 0 };
  assert.equal(
    g.buildNpcContext(state, 'watcher').visible.some((e) => e.id === 'hidden'),
    false,
  );
  state.npcBrains ??= {};
  state.npcBrains.watcher = { living: g.createLivingMemory() };
  assert.equal(
    g.buildNpcDecisionContext(state, 'watcher').visibleEntities.some((e) => e.id === 'hidden'),
    false,
  );
  assert.equal(
    g.refreshLivingPerception(state).state.npcBrains.watcher.living.rememberedItems?.hidden,
    undefined,
  );
  state.entities.hiddenPlayer = { ...hidden, id: 'hiddenPlayer', kind: 'player' };
  assert.equal(
    g
      .buildNarrativeContext(state, 'hero', 'Look around')
      .sharedAudience.some((e) => e.id === 'hiddenPlayer'),
    false,
  );
  assert.deepEqual(
    g.projectGameEvents(state, 'hero', [
      { kind: 'actor.moved', actorId: 'hiddenPlayer', mapId: 'room' },
    ]),
    [],
  );
  put(14, 11, 'D');
  grounding.doors = [{ x: 14, y: 11, label: 'Door', open: false }];
  assert.equal(spatialContext(state, 'hero').rows[12][14], '?');
  grounding.doors[0].open = true;
  assert.equal(
    g.refreshLivingPerception(state).state.npcBrains.watcher.living.rememberedItems.hidden.present,
    true,
  );
  assert.equal(spatialContext(state, 'hero').rows[12][14], '.');
  assert.equal(
    g
      .buildNarrativeContext(state, 'hero', 'Look around')
      .visibleEntities.some((e) => e.id === 'hidden'),
    true,
  );
});

test('old builder snapshots with missing or changed image identity are stale before quote/dispatch', async () => {
  const { source } = fixture();
  const configModule = require.resolve('../../apps/api/dist/config');
  require.cache[configModule] = {
    id: configModule,
    filename: configModule,
    loaded: true,
    exports: {
      config: { NODE_ENV: 'test', DATABASE_URL: 'postgresql://synthetic@127.0.0.1:1/unused' },
    },
  };
  const { StoryBuildService } = require('../../apps/api/dist/game/story-build.service');
  const { visualDigest } = require('../../apps/api/dist/visual-authoring/fingerprint');
  const service = new StoryBuildService({}, {});
  service.lock = async () => {};
  const prior = structuredClone(source);
  delete prior.mapImages;
  service.own = async () => ({
    status: 'prepared',
    project_status: 'concept',
    adventure_id: 'story',
    source_hash: 'same',
    source_snapshot: { source: prior },
  });
  service.source = async () => ({ hash: 'same', source });
  await assert.rejects(
    service.guard('owner')(
      {},
      { sourceHash: 'same', readsetHash: visualDigest(prior), projectRevision: 1 },
    ),
    /STORY_CONTEXT_STALE/,
  );
  assert.equal(service.sameAuthorSource(prior, source), false);
  prior.mapImages = structuredClone(source.mapImages);
  await service.guard('owner')(
    {},
    { sourceHash: 'same', readsetHash: visualDigest(prior), projectRevision: 1 },
  );
  prior.mapImages[0].inputSha256 = 'f'.repeat(64);
  await assert.rejects(
    service.guard('owner')(
      {},
      { sourceHash: 'same', readsetHash: visualDigest(prior), projectRevision: 1 },
    ),
    /STORY_CONTEXT_STALE/,
  );
});

test('builder analyzes effective manual art bindings, aliases old map IDs and honors studio override', async () => {
  const f = fixture(),
    textSource = structuredClone(f.source),
    plan = structuredClone(f.proposal);
  delete textSource.mapImages;
  delete plan.rooms[0].spatialGrounding;
  const draft = compileStoryPlan(textSource, plan).draft;
  draft.maps[0].id = 'legacy-room';
  draft.startMapId = 'legacy-room';
  const imagesModule = require('../../apps/api/dist/game/story-map-images');
  const original = imagesModule.prepareStoryMapImages;
  let requested;
  imagesModule.prepareStoryMapImages = async (_c, _assets, _owner, images) => {
    requested = images;
    return images.map((i) => ({
      ...f.source.mapImages[0],
      locationId: i.location_id,
      revisionId: i.revision_id,
    }));
  };
  try {
    const { StoryBuildService } = require('../../apps/api/dist/game/story-build.service');
    const manual = randomUUID(),
      studio = randomUUID();
    let overrides = [];
    const c = {
      query: async (sql) => ({
        rows: sql.includes('SELECT * FROM adventures')
          ? [{ data: { title: textSource.title, content: textSource.content }, edit_revision: 1 }]
          : sql.includes('SELECT draft,revision')
            ? [{ draft, revision: 1 }]
            : sql.includes('SELECT bindings,revision')
              ? [
                  {
                    bindings: [{ slot: 'map:legacy-room:background', revisionId: manual }],
                    revision: 1,
                  },
                ]
              : sql.includes('SELECT location_id,revision_id,source_hash')
                ? overrides
                : [],
      }),
    };
    const service = new StoryBuildService({}, {});
    const prepared = await service.source(c, 'owner', 'story');
    assert.deepEqual(requested, [{ location_id: 'room', revision_id: manual }]);
    assert.equal(prepared.bindings[0].slot, 'map:room:background');
    assert.equal(prepared.source.mapImages[0].revisionId, manual);
    overrides = [
      { location_id: 'room', revision_id: studio, source_hash: 'synthetic', map_id: null },
    ];
    const changed = await service.source(c, 'owner', 'story');
    assert.deepEqual(requested, [{ location_id: 'room', revision_id: studio }]);
    assert.notEqual(prepared.hash, changed.hash);
    assert.equal(service.sameAuthorSource(prepared.source, changed.source), false);
    assert.equal(changed.source.mapImages[0].locationId, 'room');
    assert.equal(changed.source.mapImages[0].framing, 'contain-24x24');
    assert.equal(changed.source.omittedMapImages, undefined);
    const exactPlan = structuredClone(f.proposal);
    exactPlan.rooms[0].spatialGrounding.imageRevisionId = studio;
    assert.equal(
      compileStoryPlan(changed.source, exactPlan).playable.maps.room.spatialGrounding
        .imageRevisionId,
      studio,
    );
    exactPlan.rooms[0].spatialGrounding.confidence = 0.2;
    assert.throws(() => compileStoryPlan(changed.source, exactPlan), /MAP_IMAGE_UNCERTAIN/);
  } finally {
    imagesModule.prepareStoryMapImages = original;
  }
});

function locationOnlyPlan(proposal) {
  const room = proposal.rooms[0];
  delete room.spatialGrounding;
  room.spawns = [];
  room.blocked = [];
  room.surfaces = [];
  room.scenePresence = {
    version: 1,
    entrySceneId: 'arrival',
    scenes: [
      {
        id: 'arrival',
        participantIds: [],
        evidence: { kind: 'accepted_story_plan', reference: room.locationId },
      },
    ],
  };
  return proposal;
}

test('missing vision policy offers location-only RP without pretending to analyze images', () => {
  const { schematicStorySource } = require('../../apps/api/dist/game/story-map-mode');
  const { source, proposal } = fixture();
  const fallback = schematicStorySource(source, {});
  assert.equal(fallback.mapImages, undefined);
  assert.deepEqual(
    fallback.omittedMapImages,
    source.mapImages.map(({ locationId, revisionId, sha256 }) => ({
      locationId,
      revisionId,
      sha256,
    })),
  );
  assert.ok(source.mapImages, 'the original source and assets are not mutated');
  assert.equal(
    schematicStorySource(source, undefined),
    source,
    'an unknown provider is not treated as supported fallback',
  );
  assert.equal(
    schematicStorySource(source, { storyVision: { invalid: true } }),
    source,
    'configured invalid policy does not silently downgrade',
  );
  const planned = locationOnlyPlan(structuredClone(proposal));
  assert.ok(compileStoryPlan(fallback, planned).playable);
  const body = JSON.parse(
    buildAuthoringTextRequestBody(
      storyPlanDefinition,
      { model: 'synthetic', maxOutputTokens: 8192 },
      fallback,
    ),
  );
  assert.equal(typeof body.input, 'string');
  assert.equal(body.input.includes('data:image/'), false);
  assert.equal(body.input.includes('omittedMapImages'), true);
});

test('location-only launch keeps unanalysed original artwork with no invented coordinates', () => {
  const { schematicStorySource } = require('../../apps/api/dist/game/story-map-mode');
  const { PlayableService } = require('../../apps/api/dist/game/playable.service');
  const { source, proposal } = fixture();
  const planned = locationOnlyPlan(structuredClone(proposal));
  const portrait = { slot: 'npc:portrait:portrait', revisionId: randomUUID() };
  const original = {
    plannerSource: source,
    sourceArtBindings: [
      { slot: 'map:room:background', revisionId: source.mapImages[0].revisionId },
      portrait,
    ],
  };
  const schematic = { ...original, plannerSource: schematicStorySource(source, {}) };
  const service = new PlayableService({}, {}, {});
  const playable = service.compileLaunchPlan(schematic, planned);
  assert.deepEqual(playable.artBindings, original.sourceArtBindings);
  assert.equal(playable.maps.room.spatialMode, 'location_only');
  assert.equal(playable.maps.room.spatialGrounding, undefined);
  assert.equal(original.sourceArtBindings.length, 2);
  assert.equal(
    service.compileLaunchPlan(original, proposal).artBindings.length,
    2,
    'vision-enabled binding remains intact',
  );
});

test('launch fallback is source-hash fenced, repeatable, private, and leaves compiled campaigns alone', async () => {
  const { PlayableService } = require('../../apps/api/dist/game/playable.service');
  const { visualDigest } = require('../../apps/api/dist/visual-authoring/fingerprint');
  const { source } = fixture();
  const rawPackage = {
    kind: 'launch-source',
    plannerSource: source,
    sourceArtBindings: [
      { slot: 'map:room:background', revisionId: source.mapImages[0].revisionId },
    ],
  };
  const row = {
    package: rawPackage,
    checksum: visualDigest(rawPackage),
    audience: 'private',
    owner_id: 'owner',
    status: 'draft',
  };
  let pins = 0;
  const client = { query: async () => ({ rows: [structuredClone(row)] }) };
  const service = new PlayableService(
    {},
    {},
    { assertPinsAvailable: async () => pins++ },
    { provider: { profile: {} } },
  );
  const first = await service.sourceForStart(client, 'owner', randomUUID());
  const again = await service.sourceForStart(client, 'owner', randomUUID());
  assert.equal(first.package.plannerSource.mapImages, undefined);
  assert.equal(first.package.plannerSource.omittedMapImages.length, 1);
  assert.notEqual(
    first.checksum,
    row.checksum,
    'old estimates/preparations cannot be silently reused',
  );
  assert.equal(first.checksum, again.checksum);
  assert.equal(pins, 2);
  assert.ok(row.package.plannerSource.mapImages);
  row.package.compiled = { existing: true };
  row.checksum = visualDigest(row.package);
  const compiled = await service.sourceForStart(client, 'owner', randomUUID());
  assert.equal(compiled.checksum, row.checksum);
  assert.ok(compiled.package.plannerSource.mapImages);
});

test('location-only author drafts and publication preserve the exact original map association', () => {
  const {
    schematicStorySource,
    playableMapBindings,
  } = require('../../apps/api/dist/game/story-map-mode');
  const { source, proposal } = fixture();
  const planned = locationOnlyPlan(structuredClone(proposal));
  const checked = compileStoryPlan(schematicStorySource(source, {}), planned);
  assert.equal(checked.draft.maps[0].spatialMode, 'location_only');
  assert.equal(checked.draft.maps[0].backgroundMode, undefined);
  const binding = { slot: 'map:room:background', revisionId: source.mapImages[0].revisionId };
  const authoredBindings = [binding];
  assert.deepEqual(playableMapBindings(authoredBindings, checked.playable.maps), [binding]);
  assert.deepEqual(authoredBindings, [binding]);
  assert.deepEqual(
    playableMapBindings(authoredBindings, compileStoryPlan(source, proposal).playable.maps),
    [binding],
  );
});

test('stale preparation recovery is explicitly safe only when the server confirms no jobs', async () => {
  const { PaidStartService } = require('../../apps/api/dist/game/paid-start.service');
  const { visualDigest } = require('../../apps/api/dist/visual-authoring/fingerprint');
  const input = { operationId: randomUUID(), playableVersionId: randomUUID() };
  let jobs = [];
  const prior = {
    id: randomUUID(),
    status: 'prepared',
    request_hash: visualDigest(input),
    source_checksum: 'old',
    source_version_id: input.playableVersionId,
  };
  const client = {
    query: async (sql) => ({
      rows: sql.includes('SELECT * FROM game_start_preparations')
        ? [prior]
        : sql.includes('SELECT id FROM live_authoring_text_jobs')
          ? jobs
          : [],
    }),
  };
  const service = new PaidStartService(
    { tx: (fn) => fn(client) },
    { sourceForStart: async () => ({ checksum: 'new' }) },
  );
  await assert.rejects(
    service.prepare('actor', input),
    (e) => e.getResponse().code === 'START_PREPARATION_STALE',
  );
  jobs = [{ id: 'running-or-unknown-job' }];
  await assert.rejects(
    service.prepare('actor', input),
    (e) => e.getResponse().code === 'START_SOURCE_CHANGED',
  );
});

test('story planner schema rejects off-canvas spawn, obstacle and passage coordinates', () => {
  for (const coordinate of [24, 30]) {
    for (const kind of ['spawn', 'blocked', 'passage']) {
      const { proposal } = fixture();
      if (kind === 'spawn') proposal.rooms[0].spawns[0].x = coordinate;
      if (kind === 'blocked') proposal.rooms[0].blocked = [{ x: 1, y: coordinate }];
      if (kind === 'passage')
        proposal.connections = [
          { a: 'room', b: 'other', atA: { x: coordinate, y: 1 }, atB: { x: 1, y: 1 } },
        ];
      assert.throws(() => storyPlanDefinition.validateProposal(proposal));
    }
  }
  const { proposal } = fixture();
  proposal.rooms[0].blocked = [{ x: 23, y: 23 }];
  assert.doesNotThrow(() => storyPlanDefinition.validateProposal(proposal));
  assert.equal(
    storyPlanDefinition.schema.properties.rooms.items.properties.spawns.items.properties.x.maximum,
    23,
  );
});
test('result diagnostics preserve bounded categories without leaking source or database details', () => {
  const {
    authoringResultFailureCode: classify,
  } = require('../../apps/api/dist/live-test/authoring-result-failure');
  for (const code of [
    'STORY_SOURCE_MISMATCH',
    'STORY_CONNECTION_INVALID',
    'STORY_DISCONNECTED',
    'MAP_IMAGE_UNSAFE_SPAWN',
  ])
    assert.equal(classify(new Error(code), 'apply'), code);
  assert.equal(
    classify(new Error('INVALID_MAP:private character and location details'), 'apply'),
    'STORY_MAP_INVALID',
  );
  assert.equal(
    classify(new Error('SQL private binding details'), 'apply'),
    'AUTHORING_APPLY_FAILED',
  );
  assert.equal(classify(new Error('private source mismatch')), 'AUTHORING_STALE');
  assert.equal(
    classify(new Error('private schema detail'), 'validate'),
    'AUTHORING_PROPOSAL_INVALID',
  );
  assert.equal(classify('STORY_SOURCE_MISMATCH', 'apply'), 'AUTHORING_APPLY_FAILED');
});

test('schematic illustration recovery uses only unique immutable current-map pins, without mutating state', async () => {
  const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service');
  const binding = {
    slot: 'map:room:background',
    revisionId: randomUUID(),
    sha256: hash('art'),
    mime: 'image/png',
    width: 1024,
    height: 1024,
    rights_snapshot: { attribution: 'Artist', licenseLabel: 'Owned', private: 'never exposed' },
  };
  const state = {
    maps: { room: { id: 'room', backgroundMode: 'schematic' }, other: { id: 'other' } },
    entities: { hero: { id: 'hero', kind: 'player', mapId: 'room' } },
    artBindings: [],
  };
  const before = structuredClone(state),
    calls = [];
  const service = new AssetReuseService({
    query: async (sql, values) => {
      calls.push({ sql, values });
      return [binding];
    },
  });
  const recovered = await service.sceneIllustrationBinding(state, 'hero', 'version');
  assert.equal(recovered.mapId, 'room');
  assert.equal(recovered.revisionId, binding.revisionId);
  assert.equal(recovered.rights_snapshot, undefined);
  assert.equal(recovered.private, undefined);
  assert.deepEqual(calls[0].values, ['version', 'map:room:background']);
  assert.match(calls[0].sql, /art_playable_pins/);
  assert.match(calls[0].sql, /art_asset_takedowns/);
  assert.match(calls[0].sql, /u.deleted_at IS NULL/);
  assert.doesNotMatch(calls[0].sql, /art_story_asset_drafts|UPDATE|INSERT/);
  assert.deepEqual(state, before);
  for (const rows of [
    [],
    [binding, binding],
    [{ ...binding, slot: 'map:other:background' }],
    [{ ...binding, sha256: 'bad' }],
  ]) {
    assert.equal(
      await service.sceneIllustrationBinding(state, 'hero', 'version', async () => rows),
      null,
    );
  }
  for (const changed of [
    { ...state, entities: {} },
    { ...state, entities: { hero: { kind: 'npc', mapId: 'room' } } },
    { ...state, entities: { hero: { kind: 'player', mapId: 'other' } } },
    { ...state, maps: { room: { ...state.maps.room, spatialGrounding: {} } } },
  ])
    assert.equal(await service.sceneIllustrationBinding(changed, 'hero', 'version'), null);
  assert.equal(await service.sceneIllustrationBinding(state, 'hero', null), null);
  assert.equal(calls.length, 1);
});

test('illustration file access recomputes the current map and still requires membership and exact pinned revision', async () => {
  const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service');
  const revisionId = randomUUID(),
    campaignId = randomUUID();
  const binding = {
    slot: 'map:room:background',
    revisionId,
    sha256: hash('art'),
    mime: 'image/png',
    width: 1024,
    height: 1024,
  };
  const state = {
    maps: { room: { id: 'room', backgroundMode: 'schematic' }, other: { id: 'other' } },
    entities: { hero: { id: 'hero', kind: 'player', mapId: 'room' } },
    artBindings: [],
  };
  let member = true,
    pinned = true,
    takenDown = false;
  const query = async (sql) => {
    let rows = [];
    if (sql.includes('FROM art_asset_revisions r') && sql.includes('WHERE r.id=$1'))
      rows = [
        {
          id: revisionId,
          upload_id: 'upload',
          filename: 'image.png',
          mime: 'image/png',
          sha256: binding.sha256,
          owner_id: 'owner',
        },
      ];
    else if (sql.startsWith('SELECT 1 FROM art_asset_takedowns')) rows = takenDown ? [{}] : [];
    else if (sql.includes('SELECT c.source_version_id,c.state'))
      rows = member ? [{ source_version_id: 'version', state, actor_id: 'hero' }] : [];
    else if (sql.includes('SELECT p.slot')) rows = pinned ? [binding] : [];
    else if (sql.startsWith('SELECT 1 FROM art_playable_pins')) rows = pinned ? [{}] : [];
    return { rows, rowCount: rows.length };
  };
  const service = new AssetReuseService({ tx: (fn) => fn({ query }) });
  const read = () => service.fileDescriptor('viewer', revisionId, { campaignId });
  assert.equal((await read()).filename, 'image.png');
  state.entities.hero.mapId = 'other';
  await assert.rejects(read);
  state.entities.hero.mapId = 'room';
  pinned = false;
  await assert.rejects(read);
  pinned = true;
  member = false;
  await assert.rejects(read);
  member = true;
  takenDown = true;
  await assert.rejects(read);
});

function syntheticMapServiceConfig() {
  const id = require.resolve('../../apps/api/dist/config');
  require.cache[id] = {
    id,
    filename: id,
    loaded: true,
    exports: {
      config: {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://synthetic@127.0.0.1:1/never_connect',
      },
    },
  };
}

test('location map without existing geometry freezes the exact map revision and apply assigns its map link', async () => {
  syntheticMapServiceConfig();
  const { PlayableService } = require('../../apps/api/dist/game/playable.service');
  const { StoryBuildService } = require('../../apps/api/dist/game/story-build.service');
  const imagesModule = require('../../apps/api/dist/game/story-map-images');
  const original = imagesModule.prepareStoryMapImages;
  const { source, proposal } = fixture();
  const image = source.mapImages[0];
  let payload, pinned, requested;
  const statements = [];
  imagesModule.prepareStoryMapImages = async (_c, _art, _owner, images) => {
    requested = images;
    return images.map((entry) => ({
      ...image,
      locationId: entry.location_id,
      revisionId: entry.revision_id,
    }));
  };
  const c = {
    query: async (sql, args) => {
      statements.push([sql, args]);
      if (sql.includes('FROM studio_location_images'))
        return { rows: [{ location_id: 'room', revision_id: image.revisionId, map_id: null }] };
      if (sql.startsWith('SELECT count')) return { rows: [{ n: 0 }] };
      if (sql.startsWith('INSERT INTO game_playable_versions')) payload = JSON.parse(args[4]);
      return { rows: [] };
    },
  };
  const art = {
    prepareLaunchManifestTx: async (_c, _id, _owner, _locations, _npcs, bindings) => ({
      draftRevision: 1,
      bindings,
    }),
    pinPrepared: async (_c, _id, prepared) => {
      pinned = prepared;
    },
    reusableRevisionTx: async (_c, _owner, id) => {
      assert.equal(id, image.revisionId);
      return { row: { metadata: { kind: 'background', camera: 'top-down', style: 'drawn2D' } } };
    },
  };
  try {
    const service = new PlayableService({}, {}, art);
    await service.freezeLaunchSource(
      c,
      {
        id: randomUUID(),
        owner_id: 'owner',
        title: source.title,
        edit_revision: 1,
        data: { content: source.content },
      },
      'private',
    );
    assert.deepEqual(requested, [{ location_id: 'room', revision_id: image.revisionId }]);
    assert.equal(payload.plannerSource.mapImages[0].locationId, 'room');
    assert.equal(payload.plannerSource.mapImages[0].revisionId, image.revisionId);
    assert.deepEqual(pinned.bindings, [
      { slot: 'map:room:background', revisionId: image.revisionId },
    ]);
    assert.equal(
      service.compileLaunchPlan(payload, proposal).maps.room.spatialGrounding.imageRevisionId,
      image.revisionId,
    );
    const checked = compileStoryPlan(source, proposal);
    const builder = new StoryBuildService({ tx: (work) => work(c) }, art);
    builder.lock = async () => {};
    builder.own = async () => ({
      status: 'proposed',
      project_status: 'concept',
      source_hash: 'a'.repeat(64),
      adventure_id: 'story',
      proposal,
      draft: checked.draft,
    });
    builder.source = async () => ({
      hash: 'a'.repeat(64),
      source,
      images: [{ location_id: 'room', revision_id: image.revisionId, map_id: null }],
      bindings: [],
      gameRevision: 1,
      artRevision: 1,
    });
    await builder.apply('owner', randomUUID(), {
      operationId: randomUUID(),
      sourceHash: 'a'.repeat(64),
      reviewed: true,
      imageReuseConsent: true,
    });
    const linked = statements.find(([sql]) => sql.startsWith('UPDATE studio_location_images'));
    assert.deepEqual(linked[1], ['story', 'room', 'room']);
    const saved = statements.find(([sql]) => sql.startsWith('INSERT INTO art_story_asset_drafts'));
    assert.deepEqual(JSON.parse(saved[1][1]), [
      { slot: 'map:room:background', revisionId: image.revisionId },
    ]);
  } finally {
    imagesModule.prepareStoryMapImages = original;
  }
});

test('source manifest pins survive a filtered playable view and exact revision access remains required', async () => {
  syntheticMapServiceConfig();
  const { AssetReuseService } = require('../../apps/api/dist/assets/reuse.service');
  const { visualDigest } = require('../../apps/api/dist/visual-authoring/fingerprint');
  const binding = {
    slot: 'map:room:background',
    revisionId: randomUUID(),
    sha256: 'a'.repeat(64),
    mime: 'image/png',
    width: 768,
    height: 768,
  };
  const prepared = {
    adventureId: 'story',
    draftRevision: 1,
    bindings: [binding],
    checksum: visualDigest([binding]),
    pins: [{ ...binding, grantId: null, rights: { licenseLabel: 'Owned' } }],
  };
  let sourceBindings = [binding],
    available = true,
    takenDown = false;
  const statements = [];
  const c = {
    query: async (sql, args) => {
      statements.push([sql, args]);
      if (sql.startsWith('SELECT adventure_id,package'))
        return {
          rows: [
            {
              adventure_id: 'story',
              package: { compiled: { artBindings: [] }, sourceArtBindings: sourceBindings },
            },
          ],
        };
      if (sql.startsWith('SELECT package'))
        return {
          rows: [{ package: { compiled: { artBindings: [] }, sourceArtBindings: sourceBindings } }],
        };
      if (sql.startsWith('SELECT f.owner_id')) return { rows: [{ owner_id: 'owner' }] };
      if (sql.startsWith('SELECT id FROM users') || sql.startsWith('SELECT id FROM assets'))
        return { rows: [{}], rowCount: 1 };
      if (sql.startsWith('SELECT r.upload_id')) {
        assert.deepEqual(args, [binding.revisionId, 'version', binding.slot]);
        return { rows: available ? [{ upload_id: 'upload' }] : [] };
      }
      if (sql.startsWith('SELECT 1 FROM art_asset_takedowns'))
        return { rows: [], rowCount: takenDown ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  const assets = new AssetReuseService({});
  await assets.pinPrepared(c, 'version', prepared);
  const pin = statements.find(([sql]) => sql.startsWith('INSERT INTO art_playable_pins'));
  assert.deepEqual(pin[1], [
    'version',
    binding.slot,
    binding.revisionId,
    null,
    { licenseLabel: 'Owned' },
  ]);
  await assets.assertPinsAvailable(c, 'version');
  available = false;
  await assert.rejects(() => assets.assertPinsAvailable(c, 'version'), /ART_UNAVAILABLE/);
  available = true;
  takenDown = true;
  await assert.rejects(() => assets.assertPinsAvailable(c, 'version'), /ART_UNAVAILABLE/);
  sourceBindings = [{ ...binding, revisionId: randomUUID() }];
  await assert.rejects(() => assets.pinPrepared(c, 'version', prepared), /MANIFEST_CONFLICT/);
});

test('compiled location-only freeze keeps full source and playable map manifests', async () => {
  syntheticMapServiceConfig();
  const { PlayableService } = require('../../apps/api/dist/game/playable.service');
  const { schematicStorySource } = require('../../apps/api/dist/game/story-map-mode');
  const { source, proposal } = fixture();
  locationOnlyPlan(proposal);
  const draft = compileStoryPlan(schematicStorySource(source, {}), proposal).draft;
  const binding = { slot: 'map:room:background', revisionId: source.mapImages[0].revisionId };
  let payload;
  const c = {
    query: async (sql, args) => {
      if (sql.startsWith('SELECT draft,revision')) return { rows: [{ draft, revision: 1 }] };
      if (sql.startsWith('SELECT count')) return { rows: [{ n: 0 }] };
      if (sql.startsWith('INSERT INTO game_playable_versions')) payload = JSON.parse(args[4]);
      return { rows: [] };
    },
  };
  const service = new PlayableService(
    {},
    {},
    {
      prepareManifestTx: async () => ({ draftRevision: 1, bindings: [binding] }),
      pinPrepared: async (_c, _version, prepared) => assert.deepEqual(prepared.bindings, [binding]),
    },
  );
  service.validateNpcReferences = async () => {};
  service.validateLocations = () => {};
  await service.freeze(
    c,
    { id: randomUUID(), owner_id: 'owner', title: source.title, data: { content: source.content } },
    'private',
    1,
  );
  assert.deepEqual(payload.sourceArtBindings, [binding]);
  assert.deepEqual(payload.compiled.artBindings, [binding]);
});
