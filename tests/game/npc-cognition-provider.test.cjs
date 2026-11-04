const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOpenAiNpcRequestBody,
  openAiOutputSchema,
} = require('../../apps/api/dist/ai/openai-provider');
const { runtimeVisionInstructions } = require('../../apps/api/dist/ai/runtime-vision');
const config = { model: 'synthetic-no-network', maxOutputTokens: 1000 };
test('plan and speech use bounded authored RP, never provider hidden reasoning traces', () => {
  for (const purpose of ['plan', 'speech']) {
    const schema = openAiOutputSchema(purpose);
    assert.equal(schema.properties.cognition.anyOf[0].properties.innerThought.maxLength, 480);
    assert.equal(schema.properties.cognition.anyOf[0].properties.reconsiderAfterRounds.maximum, 3);
    assert.equal(schema.properties.cognition.anyOf[0].additionalProperties, false);
    const body = JSON.parse(
      buildOpenAiNpcRequestBody(config, purpose, { npcId: 'keeper', replyLocale: 'ru' }),
    );
    assert.match(body.instructions, /authored fictional roleplay state/);
    assert.match(body.instructions, /never reveal or request native reasoning traces/);
    assert.match(body.instructions, /Cognition does not create facts/);
    assert.match(body.instructions, /Output language: Russian/);
    assert.equal(body.store, false);
  }
});
test('fresh autonomous decision uses own character and scene, not automatic obedience', () => {
  const body = JSON.parse(buildOpenAiNpcRequestBody(config, 'plan', { npcId: 'keeper' }));
  assert.match(body.instructions, /even if nobody addressed it/);
  assert.match(body.instructions, /Do not automatically obey or help/);
  assert.match(body.instructions, /previousCognition, lastActionOutcome/);
  assert.match(body.instructions, /communicate is the supported talk action/);
  assert.match(body.instructions, /Never select private observations/);
});
test('map guidance explicitly locates this NPC before interpreting its visible neighborhood', () => {
  assert.match(runtimeVisionInstructions, /context.npcId in the marker legend/);
  assert.match(runtimeVisionInstructions, /image neighborhood around its own marker/);
  assert.match(runtimeVisionInstructions, /Never invent falling, drowning, collisions/);
  assert.match(runtimeVisionInstructions, /not additional entities/);
  assert.match(runtimeVisionInstructions, /uncertain visual observations/);
});
test('synthetic provider round-trips speech and plan cognition without granting model ACLs', async () => {
  const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
  const cognition = {
    motive: 'Watch',
    belief: 'I am uncertain',
    intent: 'Wait',
    innerThought: 'I will wait here.',
    reconsiderAfterRounds: 2,
  };
  const generate = async (purpose, answer, optionalContext = {}) => {
    const provider = new OpenAiNpcProvider(
      {
        ...config,
        enabled: true,
        apiKey: 'synthetic-no-network-key',
        version: 'fixture',
        maxInputBytes: 64000,
        maxResponseBytes: 64000,
        inputMicrosPerMillion: 1,
        outputMicrosPerMillion: 1,
      },
      async () =>
        new Response(
          JSON.stringify({
            id: 'synthetic-response',
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
    return provider.generate({
      jobId: 'synthetic-job',
      purpose,
      signal: new AbortController().signal,
      maxCostMicros: 100,
      context: {
        ...optionalContext,
        knowledgeRevision: 4,
        observations: [],
        visibleEntities: [],
        ownInventory: [],
        allowedActions: ['wait'],
        mockProposal: {
          contextRevision: 1,
          mapRevision: 0,
          entityRevision: 0,
          brainGeneration: 0,
          deadlineTick: 100,
          actions: [{ kind: 'wait' }],
          targetRevisions: {},
        },
      },
    });
  };
  const speech = await generate('speech', {
    text: 'I will wait.',
    cognition,
    itemIntents: [],
    companionIntent: null,
    actionIntent: null,
  });
  assert.deepEqual(speech.proposal.cognition, cognition);
  const plan = await generate('plan', {
    cognition,
    beliefRevisions: [],
    actions: [
      {
        kind: 'wait',
        targetId: null,
        itemId: null,
        target: null,
        channel: null,
        observationIds: null,
      },
    ],
  });
  assert.deepEqual(plan.proposal.cognition, cognition);
  assert.equal(plan.proposal.knowledgeRevision, 4);
  const bad = await generate('speech', {
    text: 'Hello',
    cognition: { ...cognition, audienceIds: ['alice'] },
  });
  assert.equal(bad.proposal, null);
  assert.equal(bad.failureCode, 'PROVIDER_INVALID_RESULT');
  const silent = {
    silent: true,
    text: null,
    cognition,
    itemIntents: [],
    actionIntent: null,
    companionIntent: null,
  };
  const quiet = await generate('speech', silent, { responseOptional: true });
  assert.deepEqual(quiet.proposal, { silent: true, cognition });
  assert.equal((await generate('speech', silent)).failureCode, 'PROVIDER_INVALID_RESULT');
  for (const invalid of [
    { ...silent, text: 'I am speaking.' },
    { ...silent, actionIntent: { sourceObservationId: 'a', actions: [{ kind: 'wait' }] } },
    { ...silent, itemIntents: [{ kind: 'give_existing', itemId: 'item', recipientId: 'alice' }] },
    { ...silent, companionIntent: { kind: 'follow', actorId: 'alice', sourceObservationId: 'a' } },
  ])
    assert.equal(
      (await generate('speech', invalid, { responseOptional: true })).failureCode,
      'PROVIDER_INVALID_RESULT',
    );
});

test('optional overheard reply and already-handled director dialogue have explicit distinct guidance', () => {
  const speech = JSON.parse(
    buildOpenAiNpcRequestBody(config, 'speech', { responseOptional: true }),
  );
  assert.match(speech.instructions, /not a demand that every nearby NPC speak/);
  assert.deepEqual(openAiOutputSchema('speech').properties.text.type, ['string', 'null']);
  const director = JSON.parse(
    buildOpenAiNpcRequestBody(config, 'story_turn', { mode: 'director', npcRepliesHandled: true }),
  );
  assert.match(
    director.instructions,
    /Every step must have reply=null, replyNpcId=null and replyContextHash=null/,
  );
  assert.match(director.instructions, /do not suppress narrative coauthoring/);
});
