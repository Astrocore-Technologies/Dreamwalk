const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  OpenAiNpcProvider,
  openAiOutputSchema,
  buildOpenAiNpcRequestBody,
} = require('../../apps/api/src/ai/openai-provider.ts');
const config = {
  enabled: true,
  apiKey: 'synthetic-no-network',
  model: 'synthetic',
  version: 'location-only-test',
  maxInputBytes: 64000,
  maxOutputTokens: 1000,
  maxResponseBytes: 64000,
  inputMicrosPerMillion: 1,
  outputMicrosPerMillion: 1,
};
async function generate(purpose, answer, extra = {}) {
  let calls = 0;
  const provider = new OpenAiNpcProvider(config, async () => {
    calls++;
    return new Response(
      JSON.stringify({
        id: 'synthetic-response',
        status: 'completed',
        service_tier: 'default',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  const result = await provider.generate({
    jobId: 'fixture-job',
    purpose,
    signal: new AbortController().signal,
    maxCostMicros: 100,
    context: { turnId: randomUUID(), contextHash: 'fixture-context', evidenceIds: [], ...extra },
  });
  assert.equal(calls, 1);
  return result;
}
test('provider schema supports coordinate-free scene/NPC and opaque typed encounter', () => {
  const schema = openAiOutputSchema('story_turn');
  assert.ok(schema.properties.steps.items.properties.sceneEncounter.anyOf[0].properties.npcId);
  const narrative = openAiOutputSchema('narrative');
  assert.ok(narrative.properties.newScene.anyOf[0].properties.connection.properties.spatialMode);
  assert.ok(narrative.properties.newNpc.anyOf[0].properties.spatialMode);
  const body = JSON.parse(buildOpenAiNpcRequestBody(config, 'story_turn', { mode: 'director' }));
  assert.match(body.instructions, /opaque candidate npcId exactly/);
  assert.match(body.instructions, /next ordinary user turn/);
});
test('null spatial provider fields become absent, not invented coordinates', async () => {
  const result = await generate('narrative', {
    narration: 'A new place opens.',
    newScene: {
      name: 'Annex',
      description: 'An adjoining room.',
      template: 'room',
      connection: { fromMapId: 'tower', spatialMode: 'location_only', x: null, y: null },
    },
    newNpc: null,
    actions: [],
    evidenceIds: [],
  });
  assert.equal(result.proposal.newScene.connection.spatialMode, 'location_only');
  assert.equal(result.proposal.newScene.connection.x, undefined);
  assert.equal(result.proposal.newScene.connection.y, undefined);
});
test('injected typed encounter survives strict provider normalization with no extra dispatch', async () => {
  const result = await generate(
    'story_turn',
    {
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
          sceneEncounter: { npcId: 'encounter-fixture' },
        },
      ],
      narrative: {
        narration: 'Someone joins the encounter.',
        newScene: null,
        newNpc: null,
        newItem: null,
        evidenceIds: [],
      },
    },
    { mode: 'director' },
  );
  assert.deepEqual(result.proposal.steps[0].sceneEncounter, { npcId: 'encounter-fixture' });
});
