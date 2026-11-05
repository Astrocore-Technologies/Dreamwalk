process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
// Lightweight isolated source execution while retaining the normal TS check as a separate gate.
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
  LocationTravelGeneration,
} = require('../../apps/api/src/game/location-travel-generation.ts');
const { generationRequestSchema } = require('../../apps/api/src/image-generation/contracts.ts');
const g = require('../../packages/game-core/dist');
const errorCode = (code) => (error) => error.getResponse?.().code === code;
const q = () => ({
  id: randomUUID(),
  expiresAt: new Date(Date.now() + 120000).toISOString(),
  sparks: { reserveSubunits: '41', rateVersion: 'test-rate' },
  reserveMicros: 20,
  estimatedTotalMicros: 19,
  verifiedUpperMicros: null,
});
function subject(db = {}, images = {}, art = {}) {
  return new LocationTravelGeneration(db, { attachTravelValidator() {}, ...images }, art);
}
test('preparation builds exact private future image, no campaign mutation or dispatch, replay reuses quote', async () => {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  const state = g.initializeTurnController(
    g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']),
    ['alice'],
  ).state;
  state.turnController.phase = 'world';
  state.turnController.activeActorId = null;
  const before = structuredClone(state),
    id = randomUUID(),
    version = randomUUID();
  const request = {
    id,
    actor_id: 'alice',
    context: {
      travelRequests: [{ destinationName: 'Blue Bird Cafe', mapId: null, ambiguous: false }],
      worldInput: { text: '*I go to Blue Bird Cafe*' },
    },
  };
  let row,
    calls = 0;
  const client = {
    async query(sql, values) {
      if (sql.startsWith('SELECT * FROM game_location_travel_preparations'))
        return { rows: row ? [row] : [] };
      if (sql.startsWith('INSERT INTO game_location_travel_preparations')) {
        row = {
          id: values[0],
          campaign_id: values[1],
          owner_id: values[2],
          actor_id: values[3],
          source_version_id: values[4],
          source_checksum: values[5],
          origin_map_id: values[6],
          canon_revision: values[7],
          turn_fence: JSON.parse(values[8]),
          scene: JSON.parse(values[9]),
          input_hash: values[10],
          image_input: JSON.parse(values[11]),
          state: 'prepared',
        };
        return { rows: [row] };
      }
      throw Error(sql);
    },
  };
  const db = {
    tx: (work) => work(client),
    async query(sql, values) {
      if (sql.includes('SELECT r.id,r.context,t.actor_id')) return [request];
      if (sql.startsWith('UPDATE game_location_travel_preparations SET image_quote')) {
        row.image_quote = JSON.parse(values[1]);
        return [];
      }
      if (sql.startsWith('UPDATE game_npc_decision_requests')) return [];
      throw Error(sql);
    },
  };
  const images = {
    async quote(user, input) {
      calls++;
      assert.equal(user, 'owner');
      assert.equal(generationRequestSchema.safeParse(input).success, true);
      assert.equal(input.rights.allowAuthorReuse, false);
      assert.equal(input.travelContext.preparationId, id);
      assert.ok(input.prompt.includes('Blue Bird Cafe'));
      return { decision: 'quote', quote: q() };
    },
    enqueueTx() {
      throw Error('must not enqueue before consent');
    },
  };
  const travel = subject(db, images);
  travel.source = async () => ({
    state,
    source_version_id: version,
    source_checksum: 'a'.repeat(64),
    adventure_id: randomUUID(),
  });
  travel.validate = async () => ({});
  await travel.prepare('owner', 'campaign', state, 'mock');
  await travel.prepare('owner', 'campaign', state, 'mock');
  assert.equal(calls, 1);
  assert.deepEqual(state, before);
  assert.equal(row.state, 'prepared');
  const image = { ...row.image_input, generationAuthorizationId: randomUUID() };
  const validateClient = { query: async () => ({ rows: [row] }) };
  await travel.authorizeImage(validateClient, 'owner', image);
  await assert.rejects(
    () => travel.authorizeImage(validateClient, 'owner', { ...image, prompt: 'changed' }),
    errorCode('LOCATION_MEDIA_CHANGED'),
  );
});
test('persisted mixed new-location and item requests fail before image preparation or pricing', async () => {
  const request = {
    id: randomUUID(),
    actor_id: 'alice',
    context: {
      travelRequests: [{ destinationName: 'Museum', mapId: null, ambiguous: false }],
      worldInput: { text: '*pick up notebook* *go to Museum*' },
    },
  };
  const travel = subject(
    { query: async () => [request] },
    {
      quote() {
        throw Error('mixed intent must not reach image pricing');
      },
    },
  );
  let failed;
  travel.failUnspent = async (...args) => {
    failed = args;
    return true;
  };
  await travel.prepare('owner', 'campaign', {});
  assert.deepEqual(failed, ['campaign', request.id, 'LOCATION_TRAVEL_SEPARATE_POST']);
});
test('accept only stores exact image consent and does not bypass native serial admission', async () => {
  const quote = q(),
    row = { id: randomUUID(), state: 'prepared', image_quote: quote };
  let enqueued = 0,
    accepted = 0;
  const travel = subject(
    {},
    {
      enqueueTx: async () => {
        enqueued++;
      },
    },
  );
  travel.validate = async () => ({});
  const client = {
    async query(sql) {
      if (sql.startsWith('SELECT')) return { rows: [row] };
      accepted++;
      return { rows: [] };
    },
  };
  const entries = [{ preparationId: row.id, imageQuoteId: quote.id, quote: {} }];
  await assert.rejects(
    () => travel.accept(client, 'owner', 'batch', entries, false),
    errorCode('IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED'),
  );
  assert.equal(accepted, 0);
  await travel.accept(client, 'owner', 'batch', entries, true);
  assert.equal(accepted, 1);
  assert.equal(enqueued, 0);
});
test('uncertain images block fresh image admission; successful enqueue uses the original operation exactly once', async () => {
  const state = g.initializeTurnController(
    g.createStateFromPlayable(g.compilePlayableDraft(g.createCompleteObservatoryDraft()).playable, [
      'alice',
    ]),
    ['alice'],
  ).state;
  state.turnController.phase = 'world';
  state.turnController.activeActorId = null;
  const row = {
    id: randomUUID(),
    image_quote: q(),
    actor_id: 'alice',
    scene: { name: 'Cafe', template: 'room' },
  };
  const worldInput = {
    operationId: randomUUID(),
    text: '*I go to Cafe*',
    channel: 'say',
    expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
    turnFence: g.turnFence(state),
  };
  row.scene = g.createMockStoryTurnProposal(state, 'alice', worldInput, row.id).narrative.newScene;
  const context = {
    ...g.buildStoryTurnContext(state, 'alice', worldInput, row.id),
    worldInput,
    travelSceneSpec: { scene: row.scene },
  };

  const calls = [];
  const travel = subject(
    {},
    {
      enqueueTx: async (_c, _owner, input) => {
        calls.push(input);
        return { id: 'job' };
      },
    },
  );
  travel.validate = async () => ({ state });
  const client = {
    async query(sql) {
      if (sql === 'SELECT context FROM game_npc_decision_requests WHERE id=$1')
        return { rows: [{ context }] };
      if (sql.includes('SELECT p.*')) return { rows: [row] };
      return { rows: [] };
    },
  };
  travel.progress = async () => ({ rows: [{ status: 'unknown' }] });
  await travel.advance(client, 'owner', 'campaign', 'batch', row.id);
  assert.equal(calls.length, 0);
  travel.progress = async () => ({ rows: [] });
  await travel.advance(client, 'owner', 'campaign', 'batch', row.id);
  assert.deepEqual(calls, [
    { quoteId: row.image_quote.id, operationId: row.id, consent: true, estimateRiskConsent: true },
  ]);
});
test('arrival cannot proceed without admitted exact image, and pins art in the campaign transaction', async () => {
  const id = randomUUID(),
    row = {
      id,
      state: 'accepted',
      image_status: 'admitted',
      admitted_revision_id: randomUUID(),
      scene: { name: 'Cafe', template: 'room' },
      owner_id: 'owner',
    };
  let pinCalls = 0;
  const travel = subject(
    { query: async () => [row] },
    {},
    {
      pinCampaignArtTx: async (_c, _owner, _campaign, state, slot, revisionId) => {
        pinCalls++;
        assert.ok(state.maps[`scene-${id}`]);
        return { slot, revisionId };
      },
    },
  );
  travel.validate = async () => ({});
  const p = { narrative: { newScene: { name: 'Cafe', template: 'room' }, newNpc: null } };
  row.image_status = 'unknown';
  await assert.rejects(
    () => travel.admitted('campaign', id, p),
    errorCode('LOCATION_MEDIA_NOT_READY'),
  );
  assert.equal(pinCalls, 0);
  row.image_status = 'admitted';
  await assert.rejects(
    () =>
      travel.admitted('campaign', id, {
        narrative: { ...p.narrative, newScene: { name: 'Castle', template: 'room' } },
      }),
    errorCode('LOCATION_PLAN_CHANGED'),
  );
  await assert.rejects(
    () =>
      travel.admitted('campaign', id, {
        narrative: { ...p.narrative, newItem: { name: 'coin', description: 'a coin' } },
      }),
    errorCode('LOCATION_PLAN_CHANGED'),
  );
  await assert.rejects(
    () =>
      travel.admitted('campaign', id, {
        ...p,
        steps: [{ narrativeImpact: { targetId: 'keeper', effect: 'harm' } }],
      }),
    /LOCATION_PLAN_CHANGED/,
  );
  const commit = await travel.admitted('campaign', id, p);
  const state = { maps: { [`scene-${id}`]: {} }, artBindings: [] };
  let committed = 0;
  const next = await commit(
    {
      query: async () => {
        committed++;
        return { rows: [] };
      },
    },
    state,
  );
  assert.equal(pinCalls, 1);
  assert.equal(committed, 1);
  assert.equal(next.artBindings[0].revisionId, row.admitted_revision_id);
  assert.deepEqual(state.artBindings, []);
});

test('pending, not yet admitted images do not claim that provider work is active', async () => {
  const travel = subject();
  const result = await travel.progress(
    { query: async () => ({ rows: [{ status: null, hold_status: null }] }) },
    'campaign',
  );
  assert.equal(result.active, false);
  assert.equal(result.unknown, false);
});
test('independent accepted scene cuts rebase only over committed same-batch sibling canon', async () => {
  const initial = g.initializeTurnController(
    g.createStateFromPlayable(g.compilePlayableDraft(g.createCompleteObservatoryDraft()).playable, [
      'alice',
      'bob',
    ]),
    ['alice', 'bob'],
  ).state;
  initial.turnController.phase = 'world';
  initial.turnController.activeActorId = null;
  const turnA = randomUUID(),
    turnB = randomUUID();
  const makeInput = (text) => ({
    operationId: randomUUID(),
    text,
    channel: 'say',
    expectedCanonRevision: initial.narrativeCanon?.revision ?? 0,
    turnFence: g.turnFence(initial),
  });
  const inputA = makeInput('*I go to Cafe*'),
    inputB = makeInput('*I go to Library*');
  const proposalA = g.createMockStoryTurnProposal(initial, 'alice', inputA, turnA);
  const proposalB = g.createMockStoryTurnProposal(initial, 'bob', inputB, turnB);
  const connectionA = proposalA.narrative.newScene.connection;
  const pointB = g
    .buildNarrativeContext(initial, 'bob', inputB.text)
    .availableConnections.find((p) => p.x !== connectionA.x || p.y !== connectionA.y);
  assert.ok(pointB);
  proposalB.narrative.newScene.connection = {
    ...proposalB.narrative.newScene.connection,
    ...pointB,
  };
  const first = g.applyStoryTurnProposal(initial, 'alice', inputA, turnA, proposalA);
  assert.equal(first.error, undefined);
  const sibling = { id: turnA, actor_id: 'alice', scene: proposalA.narrative.newScene };
  const row = {
    id: turnB,
    actor_id: 'bob',
    owner_id: 'owner',
    batch_id: 'batch',
    scene: proposalB.narrative.newScene,
    canon_snapshot: initial.narrativeCanon ?? { revision: 0, turns: [] },
  };
  const travel = subject({ query: async () => [row] });
  const c = { query: async () => ({ rows: [sibling] }) };
  assert.equal(await travel.compatibleCanon(c, row, first.state), true);
  travel.canUseFrozen = async () => travel.compatibleCanon(c, row, first.state);
  const rebased = await travel.rebase('campaign', turnB, first.state, inputB, proposalB);
  assert.ok(rebased);
  assert.equal(
    proposalB.contextHash,
    g.buildStoryTurnContext(initial, 'bob', inputB, turnB).contextHash,
    'original paid provider result stays unchanged',
  );
  const second = g.applyStoryTurnProposal(
    first.state,
    'bob',
    rebased.input,
    turnB,
    rebased.proposal,
  );
  assert.equal(second.error, undefined);
  assert.equal(second.state.entities.alice.mapId, `scene-${turnA}`);
  assert.equal(second.state.entities.bob.mapId, `scene-${turnB}`);
  assert.equal(
    second.state.narrativeCanon.turns.length,
    (initial.narrativeCanon?.turns.length ?? 0) + 2,
  );
  const forged = structuredClone(first.state);
  forged.narrativeCanon.turns.at(-1).introducedScene.description = 'not the accepted scene';
  assert.equal(await travel.compatibleCanon(c, row, forged), false);
  const unrelated = { query: async () => ({ rows: [] }) };
  assert.equal(await travel.compatibleCanon(unrelated, row, first.state), false);
  const injectedImpact = structuredClone(proposalB);
  injectedImpact.steps[0].narrativeImpact = { targetId: 'keeper', effect: 'harm' };
  assert.equal(await travel.rebase('campaign', turnB, first.state, inputB, injectedImpact), null);
  const injectedItem = structuredClone(proposalB);
  injectedItem.narrative.newItem = { name: 'coin', description: 'a coin' };
  assert.equal(await travel.rebase('campaign', turnB, first.state, inputB, injectedItem), null);
  const altered = structuredClone(proposalB);
  altered.narrative.newScene.description = 'different paid plan';
  assert.equal(await travel.rebase('campaign', turnB, first.state, inputB, altered), null);
});
test('structured provider preserves semantic travel intent without requiring parser keywords', async () => {
  const {
    OpenAiNpcProvider,
    openAiOutputSchema,
    buildOpenAiNpcRequestBody,
  } = require('../../apps/api/src/ai/openai-provider.ts');
  const intent = {
    segmentIndex: 0,
    destinationName: 'Coffee and Silence',
    description: 'A quiet cafe in the established district.',
    template: 'room',
  };
  const answer = {
    status: 'ready',
    code: null,
    travelIntent: intent,
    steps: [
      { segmentIndex: 0, action: null, reply: null, replyNpcId: null, replyContextHash: null },
    ],
    narrative: {
      narration: 'He sets off.',
      newScene: null,
      newNpc: null,
      newItem: null,
      evidenceIds: [],
    },
  };
  const config = {
    model: 'synthetic-no-network',
    maxOutputTokens: 1000,
    enabled: true,
    apiKey: 'synthetic-unused',
    version: 'fixture',
    maxInputBytes: 64000,
    maxResponseBytes: 64000,
    inputMicrosPerMillion: 1,
    outputMicrosPerMillion: 1,
  };
  const provider = new OpenAiNpcProvider(
    config,
    async () =>
      new Response(
        JSON.stringify({
          id: 'fixture-response',
          status: 'completed',
          service_tier: 'default',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
          ],
          usage: { input_tokens: 50, output_tokens: 100 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  const result = await provider.generate({
    jobId: randomUUID(),
    purpose: 'story_turn',
    signal: new AbortController().signal,
    maxCostMicros: 100,
    context: {
      turnId: randomUUID(),
      contextHash: 'semantic-test',
      mode: 'director',
      replyLocale: 'en',
    },
  });
  assert.equal(result.failureCode, undefined);
  assert.deepEqual(result.proposal.travelIntent, intent);
  assert.ok(openAiOutputSchema('story_turn').required.includes('travelIntent'));
  assert.match(
    JSON.parse(buildOpenAiNpcRequestBody(config, 'story_turn', { mode: 'director' })).instructions,
    /not a vocabulary whitelist/,
  );
});
test('marked travel admission preserves exact policy entry and rejects a changed child before acceptance', async () => {
  const quote = q();
  quote.automaticKnownCostSettlement = { fingerprint: 'a'.repeat(64) };
  const row = { id: randomUUID(), image_quote: quote, state: 'prepared' };
  const entries = [
    {
      preparationId: row.id,
      imageQuoteId: quote.id,
      automaticKnownCostPolicyHash: 'a'.repeat(64),
      quote: { automaticKnownCostPolicyHash: 'a'.repeat(64) },
    },
  ];
  let accepted = 0;
  const client = {
    query: async (sql) => (sql.startsWith('SELECT') ? { rows: [row] } : (accepted++, { rows: [] })),
  };
  const travel = subject();
  travel.validate = async () => ({});
  await travel.accept(client, 'owner', 'batch', entries, true);
  assert.equal(accepted, 1);
  entries[0].automaticKnownCostPolicyHash = 'b'.repeat(64);
  await assert.rejects(
    () => travel.accept(client, 'owner', 'batch', entries, true),
    errorCode('GENERATION_QUOTE_STALE'),
  );
  assert.equal(accepted, 1);
});
