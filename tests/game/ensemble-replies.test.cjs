const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  OpenAiNpcProvider,
  buildOpenAiNpcRequestBody,
  openAiOutputSchema,
} = require('../../apps/api/dist/ai/openai-provider');
const {
  planEnsembleGroups,
  ensembleReplyFor,
} = require('../../apps/api/dist/game/ensemble-replies');

const row = (id, npc, extra = {}) => ({
  id,
  npc_id: npc,
  purpose: 'speech',
  context: { storyTurnId: 't1', segmentIndex: 0, channel: 'say', ...extra },
});

test('public replies to one message form one group led by a character who owes a reply', () => {
  const groups = planEnsembleGroups([
    row('a', 'roxy', { responseOptional: true }),
    row('b', 'paul'),
    row('c', 'hitogami', { responseOptional: true }),
  ]);
  assert.deepEqual(groups, [{ leadId: 'b', memberIds: ['a', 'c'] }]);
});

test('whispers, single replies, all-optional groups and big groups never merge', () => {
  assert.deepEqual(
    planEnsembleGroups([row('a', 'roxy', { channel: 'whisper' }), row('b', 'paul')]),
    [],
  );
  assert.deepEqual(planEnsembleGroups([row('a', 'roxy')]), []);
  assert.deepEqual(
    planEnsembleGroups([
      row('a', 'roxy', { responseOptional: true }),
      row('b', 'paul', { responseOptional: true }),
    ]),
    [],
  );
  assert.deepEqual(
    planEnsembleGroups(['a', 'b', 'c', 'd', 'e'].map((id) => row(id, 'npc-' + id))),
    [],
  );
  // Replies to different messages stay separate.
  assert.deepEqual(
    planEnsembleGroups([row('a', 'roxy'), row('b', 'paul', { segmentIndex: 1 })]),
    [],
  );
});

test('a follower reads only its own line from the lead result', () => {
  const proposal = { text: 'lead', ensembleLines: [{ speakerId: 'paul', text: 'Paul line' }] };
  assert.deepEqual(ensembleReplyFor(proposal, 'paul'), { text: 'Paul line' });
  assert.equal(ensembleReplyFor(proposal, 'roxy'), undefined);
  assert.equal(ensembleReplyFor({ text: 'no lines' }, 'paul'), undefined);
  assert.equal(ensembleReplyFor(null, 'paul'), undefined);
});

const ensemble = { members: [{ npcId: 'paul', label: 'Paul', context: {} }] };
test('the lead request asks for the others lines and names the allowed speakers', () => {
  const context = { contextHash: 'x', ensemble };
  const schema = openAiOutputSchema('speech', context);
  assert.deepEqual(schema.properties.ensembleLines.items.properties.speakerId.enum, ['paul']);
  assert.match(
    JSON.parse(buildOpenAiNpcRequestBody({ model: 'm', maxOutputTokens: 1000 }, 'speech', context))
      .instructions,
    /writes the replies of several characters/,
  );
  assert.equal(
    openAiOutputSchema('speech', { contextHash: 'x' }).properties.ensembleLines,
    undefined,
  );
});

async function generate(context, answer) {
  const provider = new OpenAiNpcProvider(
    {
      model: 'synthetic',
      maxOutputTokens: 1000,
      enabled: true,
      apiKey: 'synthetic-no-network-key',
      version: 'ensemble-fixture',
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
    purpose: 'speech',
    context,
    signal: new AbortController().signal,
    maxCostMicros: 10000,
  });
}
test('valid ensemble lines reach the proposal; an unknown or duplicate speaker is refused', async () => {
  const context = { contextHash: 'x', ensemble };
  const ok = await generate(context, {
    text: 'Lead',
    ensembleLines: [{ speakerId: 'paul', text: 'Paul' }],
  });
  assert.equal(ok.failureCode, undefined);
  assert.deepEqual(ok.proposal.ensembleLines, [{ speakerId: 'paul', text: 'Paul' }]);
  const unknown = await generate(context, {
    text: 'Lead',
    ensembleLines: [{ speakerId: 'stranger', text: 'Hi' }],
  });
  assert.equal(unknown.failureCode, 'PROVIDER_INVALID_RESULT');
  const duplicate = await generate(context, {
    text: 'Lead',
    ensembleLines: [
      { speakerId: 'paul', text: 'One' },
      { speakerId: 'paul', text: 'Two' },
    ],
  });
  assert.equal(duplicate.failureCode, 'PROVIDER_INVALID_RESULT');
  // Without an ensemble in the context, lines are not accepted at all.
  const loose = await generate(
    { contextHash: 'x' },
    { text: 'Lead', ensembleLines: [{ speakerId: 'paul', text: 'Paul' }] },
  );
  assert.equal(loose.failureCode, 'PROVIDER_INVALID_RESULT');
});
