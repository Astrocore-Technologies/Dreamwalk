process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service');
const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
const { forecastWorldRound } = require('../../apps/api/dist/game/round-cost-forecast');
const { GameService } = require('../../apps/api/dist/game/game.service');

function world() {
  const draft = g.createCompleteObservatoryDraft();
  draft.turnRules = g.turnRulesSchema.parse({});
  return g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
}
function readOnlyDb(rows = []) {
  return {
    async query(sql, values) {
      assert.match(sql, /^SELECT r\.npc_id,r\.purpose,r\.status,r\.context/);
      assert.equal(values[0], 'campaign');
      return rows;
    },
  };
}
const costing = { localRequestForecast: () => 25 };

test('player-round forecast prices every current-map living NPC without mutating state or scheduling', async () => {
  const state = world();
  state.entities.second = { ...structuredClone(state.entities.keeper), id: 'second' };
  state.npcBrains.second = structuredClone(state.npcBrains.keeper);
  // A previous valid intention no longer suppresses the next round consideration.
  state.npcBrains.keeper.plan = [{ kind: 'wait' }];
  const before = structuredClone(state);
  const result = await forecastWorldRound(readOnlyDb(), costing, 'campaign', state);
  assert.equal(result.requestCount, 2);
  assert.equal(result.estimatedTotalMicros, 50);
  assert.equal(result.estimatedSparkSubunits, '100');
  assert.equal(result.basis, 'local_round_forecast');
  assert.equal(result.includesMapAnalysis, false);
  assert.equal(result.finalQuoteRequired, true);
  assert.deepEqual(state, before);
  assert.doesNotMatch(
    JSON.stringify(result),
    /keeper|second|cognition|contextHash|quoteId|consent|reserve/i,
  );
});

test('already-submitted speech contributes once and an existing plan is not forecast again', async () => {
  const state = world();
  const rows = [
    { npc_id: 'keeper', purpose: 'plan', status: 'queued', context: { contextHash: 'plan' } },
    {
      npc_id: 'keeper',
      purpose: 'speech',
      status: 'queued',
      context: {
        contextHash: 'speech',
        storyTurnId: 'submitted',
        deferredSpeechId: 'speech-1',
        claims: [],
      },
    },
    { npc_id: 'keeper', purpose: 'summary', status: 'failed', context: { contextHash: 'old' } },
  ];
  const result = await forecastWorldRound(readOnlyDb(rows), costing, 'campaign', state);
  assert.equal(result.requestCount, 2);
  assert.equal(result.estimatedTotalMicros, 50);
});

test('actual unprepared player speech and deferred director bind to the submitted round before world preparation', async () => {
  const { randomUUID } = require('node:crypto');
  const { StoryTurnRuntime } = require('../../apps/api/dist/game/story-turn-runtime');
  const draft = g.createAuthoredDraft('courtyard');
  draft.npcBehavior = 'reactive-v1';
  draft.turnRules = g.turnRulesSchema.parse({});
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
  state.maps.courtyard.blocked = [];
  Object.assign(state.entities.alice, { x: 5, y: 5 });
  Object.assign(state.entities.keeper, { x: 6, y: 5 });
  const game = Object.create(GameService.prototype);
  const runtime = Object.create(StoryTurnRuntime.prototype);
  runtime.port = { prepareAreaTurnSpeech: game.prepareAreaTurnSpeech.bind(game) };
  const turnId = randomUUID();
  const input = {
    operationId: turnId,
    text: 'Hello! *I smile warmly*',
    channel: 'say',
    expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
    turnFence: g.turnFence(state),
  };
  const posted = runtime.simulateTurnPost(state, 'alice', input, turnId, 'owner');
  assert.ok(posted.requests.length > 0);
  assert.ok(posted.directorText);
  assert.ok(posted.requests.every((request) => !request.context.turnFence));
  // submitTurnBased stores this minimal director request under the turn ID.
  // It has neither a request turnFence nor storyTurnId until world preparation.
  const director = {
    turn_id: turnId,
    turn_actor_id: 'alice',
    turn_input: input,
    turn_context: { turnBased: true, directorText: posted.directorText },
    id: turnId,
    npc_id: 'alice',
    purpose: 'story_turn',
    status: 'queued',
    context: {
      contextHash: 'deferred',
      turnBasedDeferredDirector: true,
      generationPolicy: 'world-batch-v1',
    },
  };
  const rows = [
    ...posted.requests.map((request) => ({
      id: request.id,
      npc_id: request.npcId,
      purpose: request.purpose,
      status: 'queued',
      context: request.context,
    })),
    director,
  ];
  posted.state.turnController.deferredSpeech.push({
    ...posted.state.turnController.deferredSpeech[0],
    id: 'old-round-reference',
    roundId: 'old-round',
  });
  const db = {
    async query(sql, values) {
      assert.match(sql, /LEFT JOIN game_story_turns t ON t.campaign_id=r.campaign_id/);
      assert.match(sql, /t.id::text=COALESCE\(r.context->>'storyTurnId',r.id::text\)/);
      assert.match(sql, /t.id IS NULL OR t.erased_at IS NULL/);
      assert.match(sql, /t.context->>'turnBased'='true' AND t.input->'turnFence'->>'roundId'=\$2/);
      assert.match(sql, /r.id::text=ANY\(\$3::text\[\]\)/);
      assert.equal(values[1], state.turnController.roundId);
      assert.deepEqual(
        values[2],
        posted.requests.map((request) => request.id),
      );
      return rows;
    },
  };
  game.ai = { contextBudgetBytes: () => 64000 };
  const contexts = [];
  const before = structuredClone(posted.state);
  const result = await forecastWorldRound(
    db,
    {
      localRequestForecast(purpose, context) {
        contexts.push({ purpose, context });
        return 25;
      },
    },
    'campaign',
    posted.state,
    game.deferredSpeechContext.bind(game),
  );
  assert.deepEqual(posted.state, before);
  assert.ok(contexts.find((request) => request.purpose === 'speech').context.currentUtterance);
  assert.ok(
    contexts
      .find((request) => request.purpose === 'story_turn')
      .context.worldInput.text.includes('smile'),
  );
  assert.equal(result.unavailableReason, undefined);
  assert.equal(result.requestCount, posted.requests.length + 2); // replies + director + NPC plan
  assert.equal(result.estimatedTotalMicros, (posted.requests.length + 2) * 25);
});

test('dead, encounter and off-map NPCs add no speculative request', async () => {
  for (const mutation of [
    (state) => {
      state.entities.keeper.vitality = 0;
    },
    (state) => {
      state.entities.keeper.encounterId = 'active';
    },
    (state) => {
      state.entities.keeper.mapId = 'elsewhere';
    },
  ]) {
    const state = world();
    mutation(state);
    const result = await forecastWorldRound(readOnlyDb(), costing, 'campaign', state);
    assert.equal(result.requestCount, 0);
    assert.equal(result.estimatedSparkSubunits, '0');
  }
});

test('frozen world roster, terminal decisions and free off-map crossings are not re-priced', async () => {
  const initial = world();
  const state = g.endPlayerTurn(initial, 'alice', g.turnFence(initial)).state;
  state.turnController.worldActorIds = [];
  let result = await forecastWorldRound(readOnlyDb(), costing, 'campaign', state);
  assert.equal(result.requestCount, 0);
  state.turnController.worldActorIds = ['keeper'];
  for (const row of [
    { npc_id: 'keeper', purpose: 'plan', status: 'committed', context: {} },
    {
      npc_id: 'keeper',
      purpose: 'plan',
      status: 'queued',
      context: { offmapCompanionContinuation: true },
    },
  ]) {
    result = await forecastWorldRound(readOnlyDb([row]), costing, 'campaign', state);
    assert.equal(result.requestCount, 0);
  }
});

test('one unavailable or invalid request makes the entire forecast unavailable, never a partial cheap total', async () => {
  const rows = [{ npc_id: 'keeper', purpose: 'speech', status: 'queued', context: {} }];
  for (const unavailable of [null, -1, NaN, Number.MAX_SAFE_INTEGER]) {
    let count = 0;
    const ai = { localRequestForecast: () => (++count === 1 ? 25 : unavailable) };
    const result = await forecastWorldRound(readOnlyDb(rows), ai, 'campaign', world());
    assert.equal(result.estimatedTotalMicros, null);
    assert.equal(result.estimatedSparkSubunits, null);
    assert.equal(result.unavailableReason, 'pricing_unavailable');
  }
});

function provider(extra = {}) {
  return new OpenAiNpcProvider(
    {
      enabled: true,
      apiKey: 'synthetic-only',
      model: 'synthetic-model',
      version: 'synthetic-v1',
      maxInputBytes: 64000,
      maxModelInputTokens: 1050000,
      contextBudgetTokens: 20000,
      maxOutputTokens: 2048,
      maxResponseBytes: 128000,
      inputMicrosPerMillion: 250000,
      outputMicrosPerMillion: 750000,
      estimation: {
        kind: 'operator_heuristic',
        textTokensPerKiBUtf8: 1024,
        textProtocolTokens: 4096,
        marginBps: 2500,
        fixedMarginMicros: 17,
      },
      pricing: {
        source: 'https://developers.openai.com/api/docs/pricing',
        reviewedAt: '2000-01-01T00:00:00.000Z',
        validUntil: '2099-01-01T00:00:00.000Z',
      },
      ...extra,
    },
    async () => {
      throw new Error('Forecast must never contact the provider');
    },
  );
}

test('local provider forecast uses configured request pricing, never cap, reserve margin, or network', () => {
  const configured = provider();
  const db = {
    query() {
      throw new Error('No database writes or reads from local estimator');
    },
  };
  const ai = new NpcAiEngine(db, configured, { providerUpperMicros: 9999999 });
  const context = { contextHash: 'context', npcId: 'keeper' };
  const prepared = configured.prepareTextRequest('plan', context);
  const amount = ai.localRequestForecast('plan', {
    ...context,
    runtimeMapImage: { deliberatelyInvalid: true },
    textCountEvidence: { deliberatelyStale: true },
    textContextCandidate: { private: true },
  });
  assert.equal(amount, prepared.snapshot.estimatedTotalMicros);
  assert.ok(amount > 0);
  assert.notEqual(amount, prepared.snapshot.reserveMicros);
  assert.notEqual(amount, 9999999);
  assert.equal(ai.localRequestForecast('plan', { ...context, text: 'x'.repeat(100000) }), null);
});

test('expired pricing and unsupported adapters show unavailable; only free built-in simulator shows zero', () => {
  const db = {
    query() {
      throw new Error('Must remain read-only and local');
    },
  };
  const expired = provider({
    pricing: {
      source: 'fixture',
      reviewedAt: '2000-01-01T00:00:00.000Z',
      validUntil: '2001-01-01T00:00:00.000Z',
    },
  });
  assert.equal(
    new NpcAiEngine(db, expired).localRequestForecast('plan', { contextHash: 'c' }),
    null,
  );
  assert.equal(new NpcAiEngine(db).localRequestForecast('plan', { contextHash: 'c' }), 0);
  assert.equal(
    new NpcAiEngine(db, undefined, { creditPrice: 1 }).localRequestForecast('plan', {
      contextHash: 'c',
    }),
    null,
  );
});

test('status authorizes before forecasting and pending or unknown outcomes suppress the numeric forecast', async () => {
  for (const status of [
    { pending: true, unknown: false },
    { pending: false, unknown: true },
  ]) {
    const game = Object.create(GameService.prototype);
    game.serial = (_id, work) => work();
    game.access = async () => ({ user: { id: 'owner' } });
    game.load = async () => ({ state: world() });
    game.worldGeneration = { status: async () => status };
    game.db = {
      query() {
        throw new Error('Do not estimate a blocked round');
      },
    };
    const result = await game.worldGenerationStatus({}, 'campaign');
    assert.equal(result.forecast, null);
    assert.equal(result.unknown, status.unknown);
  }
  const game = Object.create(GameService.prototype);
  game.serial = (_id, work) => work();
  game.access = async () => ({ user: { id: 'member' } });
  game.load = async () => ({ state: world() });
  game.worldGeneration = {
    status: async () => {
      throw new Error('FORBIDDEN');
    },
  };
  game.db = {
    query() {
      throw new Error('Private forecast ran before owner authorization');
    },
  };
  await assert.rejects(game.worldGenerationStatus({}, 'campaign'), /FORBIDDEN/);
});
