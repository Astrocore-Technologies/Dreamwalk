/** Injected transport only. These tests do not measure live language interpretation. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  OpenAiNpcProvider,
  openAiOutputSchema,
  buildOpenAiNpcRequestBody,
} = require('../../apps/api/dist/ai/openai-provider');
const { countRequestBody } = require('../../apps/api/dist/ai/text-preflight');
const contracts = require('../../packages/contracts/dist');
const config = {
  enabled: true,
  apiKey: 'synthetic-only',
  model: 'synthetic-model',
  version: 'item-placement-fixture-v1',
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
};
function context() {
  return {
    turnId: randomUUID(),
    contextHash: 'synthetic-placement-context',
    mode: 'director',
    replyLocale: 'en',
    director: { evidenceIds: [] },
    segments: [
      {
        index: 0,
        kind: 'attempt',
        text: 'I lower the brass key from my pocket onto the ground beside me',
      },
    ],
    itemPlacementPolicy: {
      segmentCandidates: [
        {
          segmentIndex: 0,
          items: [
            {
              id: 'key',
              label: 'brass key',
              labels: ['brass key', 'key'],
              revision: 2,
              points: [{ x: 5, y: 3 }],
            },
          ],
          readset: {
            actorRevision: 2,
            mapId: 'room',
            mapRevision: 4,
            image: null,
            imageBinding: [],
            groundingImage: null,
            geometryHash: 'synthetic-geometry',
          },
        },
      ],
    },
  };
}
function answer(target = { x: 5, y: 3 }) {
  return {
    status: 'ready',
    code: null,
    travelIntent: null,
    steps: [
      {
        segmentIndex: 0,
        action: { kind: 'drop', targetId: 'key', itemId: null, target },
        reply: null,
        replyNpcId: null,
        replyContextHash: null,
        narrativeImpact: null,
        sceneEncounter: null,
      },
    ],
    narrative: {
      narration: 'The brass key rests on the ground beside you.',
      newScene: null,
      newNpc: null,
      newItem: null,
      evidenceIds: [],
    },
  };
}
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

test('provider exposes a director-only required-point drop branch, never legacy narrative or NPC actions', () => {
  const schema = openAiOutputSchema('story_turn', context());
  const branch = schema.properties.steps.items.properties.action.anyOf.find((candidate) =>
    candidate.properties?.kind.enum.includes('drop'),
  );
  assert.ok(branch);
  assert.equal(branch.properties.target.type, 'object');
  assert.equal(branch.properties.targetId.type, 'string');
  assert.deepEqual(branch.properties.itemId, { type: 'null' });
  assert.deepEqual(branch.properties.target.required, ['x', 'y']);
  assert.equal(branch.additionalProperties, false);
  for (const mode of ['npc']) {
    const other = openAiOutputSchema('story_turn', { ...context(), mode });
    assert.ok(
      other.properties.steps.items.properties.action.anyOf.every(
        (candidate) => !candidate.properties?.kind.enum.includes('drop'),
      ),
    );
  }
  assert.equal(JSON.stringify(openAiOutputSchema('narrative')).includes('"drop"'), false);
  for (const action of [
    { kind: 'drop', targetId: 'key' },
    { kind: 'drop', target: { x: 5, y: 3 } },
    { kind: 'drop', targetId: 'key', itemId: 'key', target: { x: 5, y: 3 } },
  ])
    assert.equal(contracts.storyActionSchema.safeParse(action).success, false);
  const body = JSON.parse(buildOpenAiNpcRequestBody(config, 'story_turn', context()));
  assert.match(body.instructions, /itemPlacementPolicy\.segmentCandidates/);
  assert.match(body.instructions, /no command grammar/);
  assert.match(body.instructions, /without an intermediate action confirmation/);
  assert.match(body.instructions, /Private placement references are not NPC knowledge/);
});

test('quote/count/restarted dispatch use exactly the same placement context, schema and instructions', async () => {
  const supplied = context(),
    original = structuredClone(supplied);
  const quote = new OpenAiNpcProvider(config, async () => {
    throw Error('quote must not dispatch');
  });
  const prepared = quote.prepareTextRequest('story_turn', supplied);
  assert.equal(prepared.body, quote.countBody('story_turn', supplied));
  assert.deepEqual(
    JSON.parse(countRequestBody(prepared.body)).text,
    JSON.parse(prepared.body).text,
  );
  const restored = Object.fromEntries(
    Object.entries(JSON.parse(JSON.stringify(supplied))).reverse(),
  );
  let calls = 0,
    dispatched;
  const provider = new OpenAiNpcProvider(config, async (_url, init) => {
    calls++;
    dispatched = init.body;
    return response(answer());
  });
  const request = {
    jobId: randomUUID(),
    purpose: 'story_turn',
    context: restored,
    signal: new AbortController().signal,
    maxCostMicros: prepared.snapshot.reserveMicros,
    textReservationSnapshot: structuredClone(prepared.snapshot),
  };
  const result = await provider.generate(request);
  assert.equal(result.failureCode, undefined);
  assert.deepEqual(result.proposal.steps[0].action, {
    kind: 'drop',
    targetId: 'key',
    target: { x: 5, y: 3 },
  });
  assert.equal(dispatched, prepared.body);
  assert.equal(calls, 1);
  assert.deepEqual(supplied, original);
  const changed = structuredClone(restored);
  changed.itemPlacementPolicy.segmentCandidates[0].items[0].points[0].x++;
  await assert.rejects(
    provider.generate({ ...request, context: changed }),
    (error) => error.code === 'PROVIDER_REQUEST_SNAPSHOT_CHANGED',
  );
  assert.equal(calls, 1, 'stale geometry never dispatches under an earlier quote');
});

test('missing required placement point fails closed at provider response boundary with no retry', async () => {
  let calls = 0;
  const supplied = context();
  const provider = new OpenAiNpcProvider(config, async () => {
    calls++;
    return response(answer(null));
  });
  const prepared = provider.prepareTextRequest('story_turn', supplied);
  const result = await provider.generate({
    jobId: randomUUID(),
    purpose: 'story_turn',
    context: supplied,
    signal: new AbortController().signal,
    maxCostMicros: prepared.snapshot.reserveMicros,
    textReservationSnapshot: prepared.snapshot,
  });
  assert.equal(result.proposal, null);
  assert.equal(calls, 1);
  assert.ok(result.failureCode);
});
