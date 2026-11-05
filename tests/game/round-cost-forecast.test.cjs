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

test('single-owner mixed post binds its deferred director to the submitted round before world preparation', async () => {
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
  assert.equal(posted.requests.length, 0);
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
  assert.equal(
    contexts.some((request) => request.purpose === 'speech'),
    false,
  );
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
  const roomy = new NpcAiEngine(
    db,
    provider({ contextBudgetTokens: 256000, maxInputBytes: 4194304 }),
  );
  assert.equal(
    roomy.localAutonomousSpeechAllowance(),
    81297,
    'Permission ceiling includes configured percentage and fixed margins',
  );
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
    let consentReads = 0;
    game.db = {
      query(sql, values) {
        if (/^SELECT state,result_code AS code FROM game_ordinary_round_consents\s/.test(sql)) {
          assert.deepEqual(values, ['campaign', 'owner']);
          consentReads++;
          return [];
        }
        if (sql.startsWith('SELECT s.enabled AS sparks_enabled')) {
          assert.deepEqual(values, ['owner']);
          return [
            {
              sparks_enabled: true,
              sparks_balance: '443767',
              sparks_held: '83052',
              dreams_enabled: false,
            },
          ];
        }
        throw new Error('Do not estimate a blocked round');
      },
    };
    const result = await game.worldGenerationStatus({}, 'campaign');
    assert.equal(result.forecast, null);
    assert.equal(result.unknown, status.unknown);
    assert.equal(result.ordinary, null);
    assert.deepEqual(result.availableFunding, {
      sparksSubunits: '360715',
      dreamsSubunits: '0',
      totalSubunits: '360715',
    });
    assert.equal(consentReads, 1, 'Only the authorized read-only admission status is loaded');
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

test('optional forecasts price current audience-safe contexts and keep full-window permission separate', async () => {
  const {
    autonomousSpeechForecastContexts,
  } = require('../../apps/api/dist/game/autonomous-speech-forecast');
  const state = world();
  state.maps[state.entities.keeper.mapId].blocked = [];
  Object.assign(state.entities.alice, { x: 5, y: 5 });
  Object.assign(state.entities.keeper, { x: 6, y: 5 });
  state.npcBrains.keeper.living.observations.push({
    ...structuredClone(state.npcBrains.keeper.living.observations[0]),
    id: 'forecast-secret',
    kind: 'authored_fact',
    text: 'PRIVATE_FORECAST_TOKEN',
    disclosure: 'private',
    revealCondition: 'never',
    audienceIds: ['keeper'],
  });
  const before = JSON.stringify(state);
  const configured = provider({
    contextBudgetTokens: 256000,
    maxInputBytes: 4194304,
    inputMicrosPerMillion: 100000,
    outputMicrosPerMillion: 500000,
    cachePricing: {
      cachedInputMicrosPerMillion: 10000,
      cacheWrite30mMicrosPerMillion: 125000,
      cacheWrite12hMicrosPerMillion: 250000,
    },
    estimation: {
      kind: 'operator_heuristic',
      textTokensPerKiBUtf8: 1024,
      textProtocolTokens: 4096,
      marginBps: 0,
      fixedMarginMicros: 0,
    },
  });
  const ai = new NpcAiEngine(
    {
      query() {
        throw Error('No quote, count or generation');
      },
    },
    configured,
  );
  assert.equal(ai.localAutonomousSpeechAllowance(), 64512);
  const contexts = autonomousSpeechForecastContexts(state, 'keeper', 4194304, 'ru');
  assert.ok(contexts.length > 0);
  for (const context of contexts) {
    assert.equal(context.replyLocale, 'ru');
    assert.doesNotMatch(JSON.stringify(context), /PRIVATE_FORECAST_TOKEN|forecast-secret/);
    assert.ok(context.worldPlanCommunication);
    const actualBody = configured.prepareTextRequest('speech', context).snapshot;
    assert.equal(ai.localAutonomousSpeechForecast(context), actualBody.estimatedTotalMicros);
    assert.ok(actualBody.estimatedTotalMicros < 64512);
  }
  const result = await forecastWorldRound(
    readOnlyDb(),
    ai,
    'campaign',
    state,
    undefined,
    (current, npcId) => autonomousSpeechForecastContexts(current, npcId, 4194304, 'ru'),
  );
  assert.equal(result.optionalAutonomousSpeechUnestimatedRequests, 0);
  assert.ok(
    BigInt(result.optionalAutonomousSpeechSparkSubunits) <
      BigInt(result.optionalAutonomousSpeechAllowanceSubunits),
  );
  assert.equal(JSON.stringify(state), before, 'No speculative move, plan or state mutation');
  assert.doesNotMatch(
    JSON.stringify(result),
    /keeper|alice|claims|contextHash|observationIds|recipientId/,
  );
  const small = ai.localAutonomousSpeechForecast(contexts[0]);
  const long = ai.localAutonomousSpeechForecast({
    ...contexts[0],
    roleplayExample: 'Слова и память. '.repeat(1000),
  });
  assert.ok(long > small, 'Real Unicode content changes the forecast, no constant per-NPC reserve');
});

test('missing optional context keeps known mandatory estimate visible and never substitutes zero', async () => {
  const result = await forecastWorldRound(
    readOnlyDb(),
    {
      localRequestForecast: () => 25,
      localAutonomousSpeechForecast: () => {
        throw Error('No current example');
      },
      localAutonomousSpeechAllowance: () => 64512,
    },
    'campaign',
    world(),
    undefined,
    () => [],
  );
  assert.equal(result.baseEstimatedSparkSubunits, '50');
  assert.equal(result.optionalAutonomousSpeechSparkSubunits, null);
  assert.equal(result.optionalAutonomousSpeechUnestimatedRequests, 1);
  assert.equal(result.estimatedSparkSubunits, null);
});

test('available round funding is owner-bound, excludes held liability and never writes', async () => {
  const {
    readRoundFundingAvailability,
  } = require('../../apps/api/dist/game/round-funding-availability');
  const db = (row) => ({
    query: async (sql, values) => {
      assert.match(sql, /^SELECT /);
      assert.doesNotMatch(sql, /FOR UPDATE|INSERT|DELETE|UPDATE /);
      assert.deepEqual(values, ['owner']);
      return row ? [row] : [];
    },
  });
  assert.deepEqual(
    await readRoundFundingAvailability(
      db({
        sparks_enabled: true,
        sparks_balance: '443767',
        sparks_held: '83052',
        dreams_enabled: true,
        dreams_balance: '2000',
        dreams_held: '1500',
      }),
      'owner',
    ),
    {
      sparksSubunits: '360715',
      dreamsSubunits: '500',
      totalSubunits: '361215',
    },
  );
  assert.equal(await readRoundFundingAvailability(db(null), 'owner'), null);
  assert.equal(
    await readRoundFundingAvailability(
      db({ sparks_enabled: false, dreams_enabled: true, dreams_balance: '9000', dreams_held: '0' }),
      'owner',
    ),
    null,
  );
  assert.equal(
    await readRoundFundingAvailability(
      db({ sparks_enabled: true, sparks_balance: '10', sparks_held: '11' }),
      'owner',
    ),
    null,
  );
});

test('three NPC current-context estimates do not multiply the full configured-window price', async () => {
  const state = world();
  for (const id of ['second', 'third']) {
    state.entities[id] = { ...structuredClone(state.entities.keeper), id };
    state.npcBrains[id] = structuredClone(state.npcBrains.keeper);
  }
  const seen = [];
  const result = await forecastWorldRound(
    readOnlyDb(),
    {
      localRequestForecast: () => 10,
      localAutonomousSpeechAllowance: () => 64512,
      localAutonomousSpeechForecast: (context) => {
        seen.push(context.npcId);
        return context.currentCost;
      },
    },
    'campaign',
    state,
    undefined,
    (_state, npcId) => [
      {
        contextHash: `current-${npcId}`,
        npcId,
        currentCost: { keeper: 1000, second: 1100, third: 1200 }[npcId],
      },
    ],
  );
  assert.deepEqual(seen.sort(), ['keeper', 'second', 'third']);
  assert.equal(result.optionalAutonomousSpeechRequests, 3);
  assert.equal(result.optionalAutonomousSpeechAllowanceSubunits, '387072');
  assert.equal(result.optionalAutonomousSpeechSparkSubunits, '6600');
  assert.equal(result.baseEstimatedSparkSubunits, '60');
  assert.equal(result.estimatedSparkSubunits, '6660');
});
