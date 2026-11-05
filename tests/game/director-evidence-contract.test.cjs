/** Synthetic transports only. No credentials, live app, database or provider calls. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  OpenAiNpcProvider,
  buildOpenAiNpcRequestBody,
  openAiOutputSchema,
} = require('../../apps/api/dist/ai/openai-provider');
const { countRequestBody } = require('../../apps/api/dist/ai/text-preflight');
const g = require('../../packages/game-core/dist');

const config = () => ({
  enabled: true,
  apiKey: 'synthetic-only',
  model: 'synthetic-model',
  version: 'director-evidence-fixture-v1',
  maxInputBytes: 64000,
  maxModelInputTokens: 1050000,
  maxOutputTokens: 2048,
  maxResponseBytes: 128000,
  inputMicrosPerMillion: 1000000,
  outputMicrosPerMillion: 1000000,
  estimation: {
    kind: 'operator_heuristic',
    textTokensPerKiBUtf8: 1024,
    textProtocolTokens: 4096,
    marginBps: 2500,
    fixedMarginMicros: 17,
  },
});
const context = (evidenceIds = []) => ({
  turnId: randomUUID(),
  contextHash: 'synthetic-context',
  mode: 'director',
  replyLocale: 'en',
  director: { evidenceIds },
  history: [{ id: 'feed-attempt', kind: 'attempt', text: 'I wave.' }],
});
const fields = (evidenceIds) => ({
  narration: 'You raise your hand in greeting.',
  newScene: null,
  newNpc: null,
  evidenceIds,
});
const proposal = (evidenceIds) => ({
  status: 'ready',
  code: null,
  travelIntent: null,
  steps: [
    {
      segmentIndex: 0,
      action: null,
      reply: null,
      replyNpcId: null,
      replyContextHash: null,
      narrativeImpact: null,
      sceneEncounter: null,
    },
  ],
  narrative: { ...fields(evidenceIds), newItem: null },
});
const response = (value) =>
  new Response(
    JSON.stringify({
      id: 'synthetic-response',
      status: 'completed',
      service_tier: 'default',
      usage: { input_tokens: 50, output_tokens: 10 },
      output: [
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
      ],
    }),
  );
const evidenceSchema = (schema, purpose = 'story_turn') =>
  purpose === 'story_turn'
    ? schema.properties.narrative.anyOf[0].properties.evidenceIds
    : schema.properties.evidenceIds;
const accepts = (schema, ids) =>
  Array.isArray(ids) &&
  ids.length <= schema.maxItems &&
  ids.every(
    (id) => typeof id === 'string' && (!schema.items.enum || schema.items.enum.includes(id)),
  );

test('empty or missing canon allowlist admits only [], never feed or observation IDs', () => {
  for (const director of [{ evidenceIds: [] }, {}, undefined, { evidenceIds: ['canon', 2] }]) {
    const value = {
      ...context(),
      director,
      evidenceIds: ['wrong-top-level'],
      history: [{ id: 'feed-attempt' }],
      observationIds: ['private-observation'],
      textContextCandidate: { director: { evidenceIds: ['unpublished-candidate'] } },
    };
    const body = JSON.parse(buildOpenAiNpcRequestBody(config(), 'story_turn', value));
    const schema = evidenceSchema(body.text.format.schema);
    assert.deepEqual(schema, { type: 'array', items: { type: 'string' }, maxItems: 0 });
    assert.equal(accepts(schema, []), true);
    for (const id of ['feed-attempt', 'private-observation', 'wrong-top-level', 'invented'])
      assert.equal(accepts(schema, [id]), false);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.schema.additionalProperties, false);
    assert.match(body.instructions, /only IDs explicitly listed in director\.evidenceIds/);
    assert.match(body.instructions, /different namespaces/);
    assert.match(body.instructions, /ordinary current roleplay does not require a canon citation/);
  }
});

test('nonempty allowlist constrains exact canon IDs without changing the supplied context', () => {
  const value = context(['canon-z', 'canon-a', 'canon-a']);
  value.director.confirmedTurns = [{ id: 'not-in-published-allowlist' }];
  const before = structuredClone(value);
  const schema = evidenceSchema(openAiOutputSchema('story_turn', value));
  assert.deepEqual(schema.items, { type: 'string', enum: ['canon-a', 'canon-z'] });
  assert.equal(schema.maxItems, 2);
  for (const ids of [[], ['canon-z'], ['canon-a', 'canon-z']])
    assert.equal(accepts(schema, ids), true);
  for (const ids of [['feed-attempt'], ['not-in-published-allowlist'], ['private-observation']])
    assert.equal(accepts(schema, ids), false);
  assert.deepEqual(value, before);
  const many = evidenceSchema(
    openAiOutputSchema('story_turn', context(Array.from({ length: 16 }, (_, i) => `canon-${i}`))),
  );
  assert.equal(many.maxItems, 8);
});

test('standalone narrative uses its own published allowlist; NPC reply evidence is unchanged', () => {
  const value = { evidenceIds: ['root-canon'], director: { evidenceIds: ['nested-canon'] } };
  const body = JSON.parse(buildOpenAiNpcRequestBody(config(), 'narrative', value));
  assert.deepEqual(evidenceSchema(body.text.format.schema, 'narrative').items.enum, ['root-canon']);
  assert.equal(evidenceSchema(openAiOutputSchema('narrative'), 'narrative').maxItems, 0);
  assert.deepEqual(openAiOutputSchema('speech', value), openAiOutputSchema('speech'));
});

for (const allowed of [[], ['canon-one', 'canon-two']])
  test(`quoted, counted and restarted dispatch bodies agree with ${allowed.length} canon IDs`, async () => {
    const value = context(allowed);
    const quoted = new OpenAiNpcProvider(config(), async () => {
      throw Error('quote must not dispatch');
    });
    const prepared = quoted.prepareTextRequest('story_turn', value);
    assert.equal(prepared.body, quoted.countBody('story_turn', value));
    assert.deepEqual(
      JSON.parse(countRequestBody(prepared.body)).text,
      JSON.parse(prepared.body).text,
    );
    const restored = Object.fromEntries(
      Object.entries(JSON.parse(JSON.stringify(value))).reverse(),
    );
    restored.director = Object.fromEntries(Object.entries(restored.director).reverse());
    let calls = 0;
    let dispatched;
    const restarted = new OpenAiNpcProvider(config(), async (_url, init) => {
      calls++;
      dispatched = init.body;
      return response(proposal(allowed.slice(0, 1)));
    });
    assert.equal(restarted.version, quoted.version);
    assert.deepEqual(
      restarted.prepareTextRequest('story_turn', restored).snapshot,
      prepared.snapshot,
    );
    const request = {
      jobId: randomUUID(),
      purpose: 'story_turn',
      context: restored,
      signal: new AbortController().signal,
      maxCostMicros: prepared.snapshot.reserveMicros,
      textReservationSnapshot: structuredClone(prepared.snapshot),
    };
    const result = await restarted.generate(request);
    assert.equal(result.failureCode, undefined);
    assert.equal(dispatched, prepared.body);
    assert.equal(calls, 1);
    await assert.rejects(
      restarted.generate({
        ...request,
        context: { ...restored, director: { evidenceIds: ['changed-canon'] } },
      }),
      (error) => error.code === 'PROVIDER_REQUEST_SNAPSHOT_CHANGED',
    );
    assert.equal(calls, 1, 'changed schema/allowlist never dispatches under the old quote');
  });

for (const [allowed, invalid] of [
  [[], ['feed-attempt']],
  [['canon-one'], ['feed-attempt']],
  [['canon-one'], ['canon-one', 'canon-one']],
  [['canon-one'], ['private-observation']],
])
  test(`invalid evidence ${invalid.join(',')} preserves known provider usage and never retries`, async () => {
    const value = context(allowed);
    let calls = 0;
    const provider = new OpenAiNpcProvider(config(), async () => {
      calls++;
      return response(proposal(invalid));
    });
    const prepared = provider.prepareTextRequest('story_turn', value);
    const result = await provider.generate({
      jobId: randomUUID(),
      purpose: 'story_turn',
      context: value,
      signal: new AbortController().signal,
      maxCostMicros: prepared.snapshot.reserveMicros,
      textReservationSnapshot: prepared.snapshot,
    });
    assert.equal(result.failureCode, 'PROVIDER_INVALID_EVIDENCE');
    assert.equal(result.failureStage, 'response_schema');
    assert.equal(result.proposal, null);
    assert.equal(result.requestId, 'synthetic-response');
    assert.equal(result.usage.inputTokens, 50);
    assert.equal(result.usage.outputTokens, 10);
    assert.equal(result.usage.costMicros, 60);
    assert.equal(result.usage.costVerifiedForSparks, true);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes('private-observation'), false);
  });

test('ordinary wave commits with no citation while the core still rejects a history ID', () => {
  const state = g.createStateFromPlayable(
    g.compilePlayableDraft(g.createCompleteObservatoryDraft()).playable,
    ['alice'],
  );
  const input = {
    operationId: randomUUID(),
    text: '*I wave.*',
    channel: 'say',
    replyLocale: 'en',
    expectedCanonRevision: 0,
  };
  const turnId = randomUUID();
  const value = g.buildStoryTurnContext(state, 'alice', input, turnId);
  assert.deepEqual(value.director.evidenceIds, []);
  const ready = { ...proposal([]), turnId, contextHash: value.contextHash };
  // Wire-only nullable encounter fields are removed by the provider adapter.
  delete ready.steps[0].sceneEncounter;
  const valid = g.applyStoryTurnProposal(state, 'alice', input, turnId, ready);
  assert.equal(valid.error, undefined);
  assert.ok(valid.state.narrativeCanon.turns.some((turn) => turn.id === turnId));
  const rejected = g.applyStoryTurnProposal(state, 'alice', input, turnId, {
    ...ready,
    narrative: { ...ready.narrative, evidenceIds: ['feed-attempt'] },
  });
  assert.equal(rejected.error, 'FORBIDDEN');
  assert.deepEqual(rejected.events, []);
  assert.equal(rejected.state, state);
});
