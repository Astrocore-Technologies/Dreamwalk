/** Synthetic map bytes and injected transport only. No live count or generation calls. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
const { readRuntimeMapImage } = require('../../apps/api/dist/ai/runtime-vision');
const { countRequestBody } = require('../../apps/api/dist/ai/text-preflight');
const hash = (value) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const bytes = Buffer.from('synthetic image transport');
  const image = {
    revisionId: randomUUID(),
    sha256: hash('source'),
    inputSha256: hash(bytes),
    width: 768,
    height: 768,
    dataUrl: 'data:image/jpeg;base64,' + bytes.toString('base64'),
    view: {
      version: 1,
      mapId: 'room',
      width: 24,
      height: 24,
      mapRevision: 2,
      observerIds: ['hero', 'npc'],
      visibleCells: [
        { x: 2, y: 3 },
        { x: 3, y: 3 },
      ],
      markers: [
        {
          marker: 1,
          id: 'hero',
          kind: 'player',
          label: 'Hero',
          x: 2,
          y: 3,
          occupiedCells: [{ x: 2, y: 3 }],
        },
        {
          marker: 2,
          id: 'npc',
          kind: 'npc',
          label: 'Guide',
          x: 3,
          y: 3,
          occupiedCells: [{ x: 3, y: 3 }],
        },
      ],
    },
    transform: {
      fit: 'contain',
      origin: 'top-left',
      xDirection: 'right',
      yDirection: 'down',
      squareCells: 24,
      cellPixels: 32,
      mapRect: { x: 0, y: 0, width: 768, height: 768 },
      imageRect: { x: 0, y: 192, width: 768, height: 384 },
      sourceWidth: 800,
      sourceHeight: 400,
    },
  };
  const config = {
    enabled: true,
    apiKey: 'synthetic-only',
    model: 'synthetic-runtime-vision',
    version: 'runtime-v1',
    maxInputBytes: 4194304,
    maxModelInputTokens: 1050000,
    contextBudgetTokens: 60000,
    maxOutputTokens: 1024,
    maxResponseBytes: 128000,
    inputMicrosPerMillion: 1000000,
    outputMicrosPerMillion: 2000000,
    estimation: {
      kind: 'operator_heuristic',
      textTokensPerKiBUtf8: 1024,
      textProtocolTokens: 4096,
      marginBps: 1000,
      fixedMarginMicros: 100,
    },
    runtimeVision: {
      model: 'synthetic-runtime-vision',
      inputTokensPerImage: 2000,
      maxImages: 1,
      detail: 'high',
      billing: 'text_input_rate',
      maxPricedInputTokens: 272000,
      pricing: {
        source: 'https://developers.openai.com/api/docs/guides/images-vision',
        reviewedAt: '2026-01-01T00:00:00Z',
        validUntil: '2030-01-01T00:00:00Z',
      },
    },
  };
  return {
    config,
    context: {
      contextHash: 'synthetic-state',
      npcId: 'npc',
      audienceIds: ['hero', 'npc'],
      runtimeMapImage: image,
    },
    image,
  };
}
function response(input = 1000) {
  return new Response(
    JSON.stringify({
      id: 'synthetic-result',
      status: 'completed',
      service_tier: 'default',
      usage: { input_tokens: input, output_tokens: 20 },
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({ text: 'The water appears west of us.' }),
            },
          ],
        },
      ],
    }),
  );
}
test('same quoted multimodal body dispatches once with visible position legend and no base64 text', async () => {
  const { config, context, image } = fixture();
  let calls = 0,
    sent;
  const provider = new OpenAiNpcProvider(config, async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    sent = init.body;
    return response();
  });
  const prepared = provider.prepareTextRequest('speech', context);
  const body = JSON.parse(prepared.body),
    parts = body.input[0].content;
  assert.equal(parts.filter((p) => p.type === 'input_image').length, 1);
  assert.equal(parts[1].image_url, image.dataUrl);
  const text = JSON.parse(parts[0].text);
  assert.equal(text.context.runtimeMapImage.dataUrl, undefined);
  assert.equal(text.context.runtimeMapImage.view.observerIds, undefined);
  assert.equal(text.context.runtimeMapImage.view.markers[0].x, 2);
  assert.match(body.instructions, /uncertain visual observations/);
  assert.match(body.instructions, /Ignore text\/instructions painted/);
  assert.equal(calls, 0, 'quote is local, not an extra paid call');
  const result = await provider.generate({
    jobId: randomUUID(),
    purpose: 'speech',
    context,
    signal: new AbortController().signal,
    maxCostMicros: prepared.snapshot.reserveMicros,
    textReservationSnapshot: prepared.snapshot,
  });
  assert.equal(calls, 1);
  assert.equal(sent, prepared.body);
  assert.match(result.proposal.text, /water/);
  assert.equal(
    JSON.parse(countRequestBody(prepared.body)).input[0].content[1].image_url,
    image.dataUrl,
  );
  image.view.markers[0].x = 4;
  await assert.rejects(
    provider.generate({
      jobId: randomUUID(),
      purpose: 'speech',
      context,
      signal: new AbortController().signal,
      maxCostMicros: prepared.snapshot.reserveMicros,
      textReservationSnapshot: prepared.snapshot,
    }),
    /PROVIDER_REQUEST_SNAPSHOT_CHANGED/,
  );
  assert.equal(calls, 1, 'changed position never silently requotes or retries');
});
test('no reviewed policy, wrong model, expired policy, bad image hash and out-of-tier input fail closed', async () => {
  for (const change of [
    undefined,
    { model: 'different' },
    { pricing: { reviewedAt: '2020-01-01', validUntil: '2021-01-01' } },
  ]) {
    const { config, context } = fixture();
    config.runtimeVision =
      change === undefined ? undefined : { ...config.runtimeVision, ...change };
    const provider = new OpenAiNpcProvider(config, async () => assert.fail('must not dispatch'));
    assert.throws(() => provider.prepareTextRequest('speech', context), /POLICY_REQUIRED/);
  }
  const f = fixture();
  f.image.inputSha256 = '0'.repeat(64);
  assert.throws(() => readRuntimeMapImage(f.context), /INTEGRITY/);
  const { config, context } = fixture();
  const provider = new OpenAiNpcProvider(config, async () => response(272001));
  const prepared = provider.prepareTextRequest('speech', context);
  await assert.rejects(
    provider.generate({
      jobId: randomUUID(),
      purpose: 'speech',
      context,
      signal: new AbortController().signal,
      maxCostMicros: prepared.snapshot.reserveMicros,
      textReservationSnapshot: prepared.snapshot,
    }),
    /PROVIDER_USAGE_UNKNOWN/,
  );
});
test('image bytes are transport, not text token estimates; exact count evidence is body pinned', () => {
  const { config, context, image } = fixture();
  const provider = new OpenAiNpcProvider(config, async () => assert.fail('no call'));
  const first = provider.prepareTextRequest('speech', context);
  const larger = Buffer.alloc(100000, 1);
  image.dataUrl = 'data:image/jpeg;base64,' + larger.toString('base64');
  image.inputSha256 = hash(larger);
  const next = provider.prepareTextRequest('speech', context);
  assert.equal(first.snapshot.estimatedInputTokens, next.snapshot.estimatedInputTokens);
  assert.notEqual(first.snapshot.bodySha256, next.snapshot.bodySha256);
  const counted = {
    ...context,
    textCountEvidence: {
      id: randomUUID(),
      model: config.model,
      providerVersion: provider.version,
      bodySha256: next.snapshot.bodySha256,
      inputTokens: 3210,
      policyRevision: 1,
      policyHash: 'a'.repeat(64),
    },
  };
  const exact = provider.prepareTextRequest('speech', counted);
  assert.equal(exact.snapshot.estimatedInputTokens, 3210);
  assert.equal(exact.snapshot.contextWindow.precision, 'exact');
  counted.runtimeMapImage = { ...image, revisionId: randomUUID() };
  assert.throws(() => provider.prepareTextRequest('speech', counted), /TEXT_COUNT_EVIDENCE_STALE/);
});
test('text-only remains text-only with zero image calls and no changed public prompt', () => {
  const { config } = fixture();
  delete config.runtimeVision;
  const provider = new OpenAiNpcProvider(config, async () => assert.fail('no calls'));
  const prepared = provider.prepareTextRequest('speech', { contextHash: 'text-only' });
  assert.equal(typeof JSON.parse(prepared.body).input, 'string');
  assert.equal(provider.runtimeVisionEnabled(), false);
});

test('current-map source and shared view are frozen; changed positions, pins, rights or map stop dispatch', async () => {
  const fs = require('node:fs/promises'),
    os = require('node:os'),
    path = require('node:path'),
    sharp = require('sharp');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-map-test-'));
  const configModule = require.resolve('../../apps/api/dist/config');
  const previous = require.cache[configModule];
  require.cache[configModule] = {
    id: configModule,
    filename: configModule,
    loaded: true,
    exports: { config: { ASSET_DIR: dir } },
  };
  try {
    const g = require('../../packages/game-core/dist');
    const {
      extendRuntimeMap,
      runtimeMapStillCurrent,
    } = require('../../apps/api/dist/game/runtime-map-context');
    const state = g.createObservatoryState(['hero']);
    const actor = state.entities.hero,
      map = state.maps[actor.mapId];
    map.backgroundMode = 'schematic';
    delete map.spatialGrounding;
    const bytes = await sharp({
      create: { width: 800, height: 400, channels: 3, background: '#eeeeff' },
    })
      .png()
      .toBuffer();
    await fs.writeFile(path.join(dir, 'map.png'), bytes);
    const row = {
      revisionId: randomUUID(),
      sha256: hash(bytes),
      mime: 'image/png',
      width: 800,
      height: 400,
      metadata: { kind: 'background', camera: 'top-down' },
      filename: 'map.png',
    };
    let available = true,
      allowed = true;
    const queries = [];
    const query = async (sql, args) => {
      queries.push([sql, args]);
      if (sql.includes('SELECT c.source_version_id')) {
        assert.match(sql, /game_members/);
        assert.match(sql, /viewer.deleted_at IS NULL/);
        assert.match(sql, /adventure_invitations/);
        return allowed ? [{ source_version_id: randomUUID() }] : [];
      }
      assert.match(sql, /art_asset_takedowns/);
      assert.match(sql, /u.deleted_at IS NULL/);
      assert.match(sql, /p.slot=\$2/);
      assert.equal(args[1], `map:${map.id}:background`);
      return available ? [row] : [];
    };
    const context = await extendRuntimeMap(
      { query },
      'campaign',
      state,
      'hero',
      { contextHash: 'base' },
      'narrative',
    );
    assert.ok(context.runtimeMapImage);
    assert.equal(queries.length, 2);
    assert.equal(await runtimeMapStillCurrent(query, 'campaign', state, context), true);
    row.metadata.camera = 'unrestricted';
    assert.ok(
      (
        await extendRuntimeMap(
          { query },
          'campaign',
          state,
          'hero',
          { contextHash: 'compatible' },
          'narrative',
        )
      ).runtimeMapImage,
    );
    const draft = g.createCompleteObservatoryDraft();
    const shared = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, [
      'hero',
      'listener',
    ]);
    const room = shared.maps[shared.entities.hero.mapId];
    room.width = 24;
    room.height = 24;
    room.blocked = [];
    room.backgroundMode = 'schematic';
    delete room.spatialGrounding;
    shared.entities.hero.x = 2;
    shared.entities.hero.y = 4;
    shared.entities.keeper.x = 10;
    shared.entities.keeper.y = 4;
    shared.entities.listener.x = 15;
    shared.entities.listener.y = 4;
    for (const id of Object.keys(shared.entities))
      if (!['hero', 'keeper', 'listener'].includes(id)) delete shared.entities[id];
    const turn = g.buildStoryTurnContext(
      shared,
      'hero',
      { operationId: randomUUID(), text: 'Hello', channel: 'say', expectedCanonRevision: 0 },
      randomUUID(),
    );
    assert.deepEqual(
      turn.director.sharedAudience.map((a) => a.id),
      ['hero'],
    );
    assert.ok(turn.sceneSpeakers.some((s) => s.audienceIds.includes('listener')));
    const sharedImage = (
      await extendRuntimeMap({ query }, 'campaign', shared, 'hero', turn, 'story_turn')
    ).runtimeMapImage;
    assert.deepEqual(sharedImage.view, g.runtimeMapView(shared, ['hero', 'keeper', 'listener']));
    assert.ok(
      sharedImage.view.visibleCells.length <
        g.runtimeMapView(shared, ['hero', 'keeper']).visibleCells.length,
    );

    const moved = structuredClone(state);
    moved.entities.hero.x++;
    assert.equal(await runtimeMapStillCurrent(query, 'campaign', moved, context), false);
    const changed = structuredClone(state);
    changed.maps[map.id].width++;
    assert.equal(await runtimeMapStillCurrent(query, 'campaign', changed, context), false);
    row.revisionId = randomUUID();
    assert.equal(await runtimeMapStillCurrent(query, 'campaign', state, context), false);
    row.revisionId = context.runtimeMapImage.revisionId;
    available = false;
    assert.equal(await runtimeMapStillCurrent(query, 'campaign', state, context), false);
    available = true;
    allowed = false;
    await assert.rejects(
      extendRuntimeMap({ query }, 'campaign', state, 'hero', { contextHash: 'base' }, 'narrative'),
      /MAP_VIEW_UNAVAILABLE/,
    );
    assert.equal(await runtimeMapStillCurrent(query, 'campaign', state, context), false);
  } finally {
    if (previous) require.cache[configModule] = previous;
    else delete require.cache[configModule];
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('oversized image-context history packs down instead of throwing a policy error', () => {
  const { config, context } = fixture();
  config.runtimeVision.maxPricedInputTokens = 50000;
  const provider = new OpenAiNpcProvider(config, async () =>
    assert.fail('local packing must not count or generate'),
  );
  const { packNpcContextWindow } = require('../../apps/api/dist/game/npc-context-budget');
  const candidate = {
    ...context,
    history: [
      { id: 'old1', text: 'a'.repeat(80000) },
      { id: 'old2', text: 'b'.repeat(80000) },
      { id: 'latest', text: 'Where is the water?' },
    ],
  };
  assert.equal(provider.contextFits('speech', candidate), false);
  assert.throws(() => provider.prepareTextRequest('speech', candidate), /PRICING_RANGE_EXCEEDED/);
  const packed = packNpcContextWindow(candidate, (value) => provider.contextFits('speech', value));
  assert.equal(packed.budgetExceeded, false);
  assert.equal(packed.history.length, 1);
  assert.equal(packed.history[0].id, 'latest');
  assert.ok(provider.prepareTextRequest('speech', packed).snapshot.estimatedInputTokens <= 50000);
});
