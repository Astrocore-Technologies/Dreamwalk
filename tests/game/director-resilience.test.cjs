const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  OpenAiNpcProvider,
  buildOpenAiNpcRequestBody,
} = require('../../apps/api/dist/ai/openai-provider');
const { salvageStoryTurn } = require('../../apps/api/dist/ai/openai-provider');

const config = { model: 'gpt-6-luna', maxOutputTokens: 2048, maxInputBytes: 64000 };
const beyondContext = {
  contextHash: 'x',
  mode: 'director',
  establishedRoleplay: {
    beyond: [{ id: 'hitogami', label: 'Хитогами', role: 'Божество', style: 'cryptic and rare' }],
  },
};

test('a god addressed aloud is voiced by the narrator, not handed to a present character', () => {
  const text = JSON.parse(
    buildOpenAiNpcRequestBody(config, 'story_turn', beyondContext),
  ).instructions;
  assert.match(text, /answer inside the narration as that being/);
  assert.match(text, /keep it out of replyNpcId/);
  const plain = JSON.parse(
    buildOpenAiNpcRequestBody(config, 'story_turn', { contextHash: 'x', mode: 'director' }),
  ).instructions;
  assert.doesNotMatch(plain, /answer inside the narration as that being/);
});

test('salvage drops only a malformed new character or reply and refuses anything else', () => {
  const raw = {
    narrative: { narration: 'Тишина.', newNpc: { bogus: true }, newItem: null },
    steps: [
      { segmentIndex: 0, reply: { bogus: 1 } },
      { segmentIndex: 1, reply: { text: 'ok' } },
    ],
  };
  const salvaged = salvageStoryTurn(raw, [
    { path: ['narrative', 'newNpc', 'name'] },
    { path: ['steps', 0, 'reply', 'text'] },
  ]);
  assert.equal(salvaged.narrative.newNpc, null);
  assert.equal(salvaged.narrative.narration, 'Тишина.');
  assert.equal(salvaged.steps[0].reply, null);
  assert.deepEqual(salvaged.steps[1].reply, { text: 'ok' });
  // Items, placement, effects and evidence are never repaired.
  assert.equal(salvageStoryTurn(raw, [{ path: ['narrative', 'newItem', 'point'] }]), null);
  assert.equal(
    salvageStoryTurn(raw, [
      { path: ['narrative', 'newNpc', 'x'] },
      { path: ['steps', 0, 'establishedEvents'] },
    ]),
    null,
  );
  assert.equal(salvageStoryTurn(raw, []), null);
});

async function run(answer, context) {
  const provider = new OpenAiNpcProvider(
    {
      model: 'synthetic',
      maxOutputTokens: 2000,
      enabled: true,
      apiKey: 'synthetic-no-network-key',
      version: 'resilience-fixture',
      maxInputBytes: 64000,
      maxResponseBytes: 64000,
      inputMicrosPerMillion: 100000,
      outputMicrosPerMillion: 500000,
    },
    async () =>
      new Response(
        JSON.stringify({
          id: 'synthetic',
          status: 'completed',
          service_tier: 'default',
          usage: { input_tokens: 50, output_tokens: 100 },
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
          ],
        }),
      ),
  );
  return provider.generate({
    jobId: 'synthetic-job',
    purpose: 'story_turn',
    context,
    signal: new AbortController().signal,
    maxCostMicros: 100000,
  });
}

test('a turn whose new character is malformed still delivers its narration once, with no extra call', async () => {
  const g = require('../../packages/game-core/dist');
  const { randomUUID } = require('node:crypto');
  let state = g.createStateFromPlayable(
    g.compilePlayableDraft(g.createCompleteObservatoryDraft()).playable,
    ['alice'],
  );
  state = g.endPlayerTurn(g.initializeTurnController(state, ['alice']).state, 'alice', 0).state;
  const input = {
    operationId: randomUUID(),
    text: '*осматриваюсь*',
    channel: 'say',
    replyLocale: 'ru',
    expectedCanonRevision: 0,
    turnFence: g.turnFence(state),
  };
  const context = {
    ...g.buildStoryTurnContext(state, 'alice', input, randomUUID()),
    turnBasedDeferredDirector: true,
    turnBased: true,
  };
  const answer = (newNpc) => ({
    status: 'ready',
    code: null,
    steps: [{ segmentIndex: 0, action: null, reply: null, establishedEvents: [] }],
    narrative: { narration: 'Тишина.', newScene: null, newNpc, newItem: null, evidenceIds: [] },
  });
  const ok = await run(answer(null), context);
  assert.equal(ok.failureCode, undefined);
  const broken = await run(answer({ name: 42 }), context);
  assert.equal(broken.failureCode, undefined);
  assert.equal(broken.proposal.narrative.narration, 'Тишина.');
  assert.equal(broken.proposal.narrative.newNpc, null);
});
