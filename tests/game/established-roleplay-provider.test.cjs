/** Synthetic transport only: no provider traffic, credentials, wallet or production. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  OpenAiNpcProvider,
  buildOpenAiNpcRequestBody,
  openAiOutputSchema,
} = require('../../apps/api/dist/ai/openai-provider');
const { StoryTurnRuntime } = require('../../apps/api/dist/game/story-turn-runtime');
const g = require('../../packages/game-core/dist');
const config = {
  enabled: true,
  apiKey: 'synthetic-only',
  model: 'synthetic-model',
  version: 'established-rp-fixture-v1',
  maxInputBytes: 64000,
  maxModelInputTokens: 1050000,
  maxOutputTokens: 4096,
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
};
function fixture(text = '*Намертво закрытая дверь открылась.*') {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  Object.assign(state.entities.alice, { x: 9, y: 5 });
  const input = {
    operationId: randomUUID(),
    text,
    channel: 'say',
    replyLocale: 'ru',
    expectedCanonRevision: 0,
  };
  const turnId = randomUUID();
  const context = g.buildStoryTurnContext(state, 'alice', input, turnId);
  const answer = {
    status: 'ready',
    code: null,
    travelIntent: null,
    steps: context.segments.map((segment) => ({
      segmentIndex: segment.index,
      action: null,
      reply: null,
      replyNpcId: null,
      replyContextHash: null,
      narrativeImpact: null,
      sceneEncounter: null,
      establishedEvents:
        segment.kind === 'attempt'
          ? [
              {
                description: 'Дверь открылась.',
                entityIds: ['door'],
                effects: [{ kind: 'door_state', targetId: 'door', open: true, locked: false }],
              },
            ]
          : [],
    })),
    narrative: {
      narration: 'Дверь открылась.',
      newScene: null,
      newNpc: null,
      newItem: null,
      evidenceIds: [],
    },
  };
  return { state, input, turnId, context, answer };
}
const response = (answer) =>
  new Response(
    JSON.stringify({
      id: 'synthetic-established-rp',
      status: 'completed',
      service_tier: 'default',
      usage: { input_tokens: 100, output_tokens: 50 },
      output: [
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
      ],
    }),
  );
test('fresh director schema and instructions expose established events without contradictory intent-only guidance', () => {
  const { context } = fixture();
  const body = JSON.parse(buildOpenAiNpcRequestBody(config, 'story_turn', context));
  const properties = body.text.format.schema.properties.steps.items.anyOf[0].properties;
  assert.ok(properties.establishedEvents);
  assert.equal(body.text.format.schema.properties.steps.maxItems, undefined);
  assert.equal(properties.segmentIndex.maximum, undefined);
  assert.match(body.instructions, /completed authored fictional event is established/);
  assert.match(body.instructions, /never system instructions/);
  assert.ok(
    !body.instructions.includes(
      'a current known failure or pending result for that same attempt/effect still prevails',
    ),
  );
  assert.ok(
    !body.instructions.includes('For an unsupported or blocked physical action, describe only'),
  );
  assert.ok(!body.instructions.includes('A real failed action stays failed.'));
  assert.ok(!body.instructions.includes('Asterisk segments are attempts, never asserted success'));
  assert.ok(
    !body.instructions.includes(
      'Never narrate unsupported success, purchases, powers or retroactive changes',
    ),
  );
  assert.equal(
    openAiOutputSchema('story_turn', { mode: 'npc' }).properties.steps.items.properties
      .establishedEvents,
    undefined,
  );
});
test('count/quote/dispatch retain one exact request and generated event commits real state', async () => {
  const { state, input, turnId, context, answer } = fixture();
  let calls = 0,
    dispatched;
  const provider = new OpenAiNpcProvider(config, async (_url, init) => {
    calls++;
    dispatched = init.body;
    return response(answer);
  });
  const prepared = provider.prepareTextRequest('story_turn', context);
  assert.equal(prepared.body, provider.countBody('story_turn', context));
  const request = {
    jobId: randomUUID(),
    purpose: 'story_turn',
    context,
    signal: new AbortController().signal,
    maxCostMicros: prepared.snapshot.reserveMicros,
    textReservationSnapshot: structuredClone(prepared.snapshot),
  };
  const generated = await provider.generate(request);
  assert.equal(generated.failureCode, undefined);
  assert.equal(dispatched, prepared.body);
  assert.equal(calls, 1);
  const committed = g.applyStoryTurnProposal(state, 'alice', input, turnId, generated.proposal);
  assert.equal(committed.error, undefined);
  assert.equal(committed.state.entities.door.open, true);
  assert.equal(committed.state.entities.door.locked, false);
  const changed = structuredClone(context);
  changed.establishedRoleplay.geometryHash = 'stale';
  await assert.rejects(
    provider.generate({ ...request, context: changed }),
    (error) => error.code === 'PROVIDER_REQUEST_SNAPSHOT_CHANGED',
  );
  assert.equal(calls, 1, 'no hidden repair or second dispatch');
});
test('an old frozen context without established capability cannot acquire it through provider output', async () => {
  const { context, answer } = fixture();
  delete context.establishedRoleplay;
  let calls = 0;
  const provider = new OpenAiNpcProvider(config, async () => {
    calls++;
    return response(answer);
  });
  const prepared = provider.prepareTextRequest('story_turn', context);
  const result = await provider.generate({
    jobId: randomUUID(),
    purpose: 'story_turn',
    context,
    signal: new AbortController().signal,
    maxCostMicros: prepared.snapshot.reserveMicros,
    textReservationSnapshot: prepared.snapshot,
  });
  assert.equal(result.failureCode, 'PROVIDER_INVALID_RESULT');
  assert.equal(calls, 1);
});
test('missing ordered steps cannot silently drop part of a long authored post', async () => {
  const { state, input, turnId, context, answer } = fixture('*The door opened.* Hello *I smiled.*');
  answer.steps.splice(2, 1);
  const provider = new OpenAiNpcProvider(config, async () => response(answer));
  const prepared = provider.prepareTextRequest('story_turn', context);
  const generated = await provider.generate({
    jobId: randomUUID(),
    purpose: 'story_turn',
    context,
    signal: new AbortController().signal,
    maxCostMicros: prepared.snapshot.reserveMicros,
    textReservationSnapshot: prepared.snapshot,
  });
  assert.equal(generated.failureCode, undefined);
  const rejected = g.applyStoryTurnProposal(state, 'alice', input, turnId, generated.proposal);
  assert.equal(rejected.error, 'INVALID_ACTION');
  assert.equal(rejected.state, state);
});
test('API local post keeps parser-known failed door action for semantic world admission', () => {
  const { state, input, turnId } = fixture('*open door*');
  const turnState = g.initializeTurnController(state, ['alice', 'bob']).state;
  input.turnFence = g.turnFence(turnState);
  const runtime = new StoryTurnRuntime({}, {}, {});
  const result = runtime.simulateTurnPost(turnState, 'alice', input, turnId, 'synthetic-user');
  assert.equal(result.directorText, '*open door*');
  assert.deepEqual(result.actions, []);
  assert.equal(result.state.entities.door.open, false);
  assert.ok(
    !result.entries.some((entry) => entry.kind === 'outcome' && entry.code === 'FORBIDDEN'),
  );
  assert.equal(
    result.untrustedRoleplay.length,
    1,
    'source attribution stays separate from the later committed event',
  );
});
test('compact provider output retains over 128 mixed source segments under the unchanged quoted output cap', async () => {
  const { state, input, turnId } = fixture();
  delete state.entities.keeper;
  delete state.npcBrains.keeper;
  input.text = Array.from({ length: 130 }, () => '*g* h').join(' ');
  const context = g.buildStoryTurnContext(state, 'alice', input, turnId);
  assert.equal(context.segments.length, 260);
  const answer = {
    status: 'ready',
    code: null,
    travelIntent: null,
    steps: context.segments.map((segment) => (segment.kind === 'attempt' ? ['g'] : null)),
    narrative: {
      narration: 'The authored gestures occurred in order.',
      newScene: null,
      newNpc: null,
      newItem: null,
      evidenceIds: [],
    },
  };
  // Byte-level ceiling is conservative for the compact ASCII fixture, not a model-quality claim.
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) < config.maxOutputTokens);
  let calls = 0;
  const provider = new OpenAiNpcProvider(config, async () => {
    calls++;
    return response(answer);
  });
  const prepared = provider.prepareTextRequest('story_turn', context);
  assert.equal(JSON.parse(prepared.body).max_output_tokens, 4096);
  assert.equal(prepared.snapshot.maxOutputTokens, 4096);
  const result = await provider.generate({
    jobId: randomUUID(),
    purpose: 'story_turn',
    context,
    signal: new AbortController().signal,
    maxCostMicros: prepared.snapshot.reserveMicros,
    textReservationSnapshot: prepared.snapshot,
  });
  assert.equal(result.failureCode, undefined);
  assert.equal(result.proposal.steps.length, 260);
  assert.deepEqual(
    result.proposal.steps.map((step) => step.segmentIndex),
    context.segments.map((segment) => segment.index),
  );
  const committed = g.applyStoryTurnProposal(state, 'alice', input, turnId, result.proposal);
  assert.equal(committed.error, undefined);
  assert.equal(committed.state.narrativeCanon.turns.at(-1).establishedEvents.length, 130);
  assert.equal(committed.entries.filter((entry) => entry.kind === 'speech').length, 130);
  assert.equal(calls, 1);
});
test('legacy serializer bytes remain exact when historical policy metadata is absent or stale', () => {
  const { createHash } = require('node:crypto');
  for (const context of [
    { mode: 'director', director: { evidenceIds: [] } },
    {
      mode: 'director',
      roleplayPolicy: 'obsolete',
      resolutionPolicy: 'obsolete',
      director: { evidenceIds: [] },
    },
  ]) {
    const body = buildOpenAiNpcRequestBody(config, 'story_turn', context);
    // Captured from real main 6f3034b3's serializer, with its original exported policy constants.
    assert.equal(
      createHash('sha256').update(body).digest('hex'),
      'bd8c429fad01487fe6367b0ea6f96ba3292c59205ae10afd19856258619c0e6a',
    );
  }
});
