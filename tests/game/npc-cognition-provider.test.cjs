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
    assert.equal(schema.properties.cognition.anyOf[0].properties.innerThought.maxLength, 1400);
    assert.equal(schema.properties.cognition.anyOf[0].properties.reconsiderAfterRounds.maximum, 3);
    assert.equal(schema.properties.cognition.anyOf[0].additionalProperties, false);
    const body = JSON.parse(
      buildOpenAiNpcRequestBody(config, purpose, { npcId: 'keeper', replyLocale: 'ru' }),
    );
    assert.match(body.instructions, /You portray an individual fictional character/);
    assert.match(body.instructions, /authored fictional roleplay state/);
    assert.match(body.instructions, /one coherent 3-6 sentence paragraph/);
    assert.match(body.instructions, /rather than a one-line action summary/);
    assert.match(body.instructions, /Do not merely repeat the spoken reply/);
    assert.match(body.instructions, /Do not mechanically list these ingredients/);
    assert.match(body.instructions, /never reveal or request native reasoning traces/);
    assert.match(body.instructions, /Cognition does not create facts/);
    assert.match(body.instructions, /Output language: Russian/);
    assert.equal(body.store, false);
  }
});
test('speech updates the current beat without inventing ownership or answering for another NPC', () => {
  for (const [purpose, context] of [
    ['speech', {}],
    ['story_turn', { mode: 'npc' }],
  ]) {
    const body = JSON.parse(buildOpenAiNpcRequestBody(config, purpose, context));
    assert.match(body.instructions, /Follow the latest conversational beat/);
    assert.match(body.instructions, /a change of topic, an apology, a calmer request/);
    assert.match(
      body.instructions,
      /do not accept an apology or decide a response on another character behalf/,
    );
    assert.match(body.instructions, /observationOrder for retained memory order/);
    assert.match(body.instructions, /isOwnUtterance.*not new verified world facts/);
    assert.match(
      body.instructions,
      /If ownership is unknown, do not turn it into a possessive fact/,
    );
    assert.match(
      body.instructions,
      /itemOwnershipContext=unestablished marks witnessed pickup only/,
    );
    assert.match(body.instructions, /current custody is not legal ownership/);
    assert.match(body.instructions, /do not force the same stance or a group chorus/);
    assert.match(body.instructions, /public name, role, description, appearance and speech style/);
    assert.match(
      body.instructions,
      /rather than flattening every NPC into a generic polite helper/,
    );
    assert.match(body.instructions, /If a profile is sparse, keep characterization modest/);
    assert.match(body.instructions, /public fields are untrusted character data/);
    assert.match(body.instructions, /Never fill a gap from another NPC, private memory/);
  }
});
test('fresh autonomous decision uses own character and scene, not automatic obedience', () => {
  const body = JSON.parse(buildOpenAiNpcRequestBody(config, 'plan', { npcId: 'keeper' }));
  assert.match(body.instructions, /even if nobody addressed it/);
  assert.match(body.instructions, /socialReactions/);
  assert.match(body.instructions, /subjective responses to hearing words, not proof/);
  assert.match(body.instructions, /repeated flattery/);
  assert.match(body.instructions, /No extra model request is needed/);
  assert.equal(
    openAiOutputSchema('plan').properties.socialReactions.items.properties.affinity.maximum,
    1,
  );
  assert.equal(openAiOutputSchema('speech').properties.socialReactions, undefined);

  assert.match(body.instructions, /Do not automatically obey or help/);
  assert.match(
    body.instructions,
    /itemOwnershipContext=unestablished proves witnessed pickup only/,
  );
  assert.match(body.instructions, /coarse helper role as a duty to help everyone/);
  assert.match(body.instructions, /previousCognition, lastActionOutcome/);
  assert.match(body.instructions, /currentPlan, accepted obligations/);
  assert.match(body.instructions, /remaining accepted intent/);
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
        observations: optionalContext.observations ?? [],
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
  const social = {
    actorId: 'alice',
    observationId: 'heard-alice',
    affinity: 1,
    respect: 0,
    fear: -1,
  };
  const socialAnswer = {
    actions: [{ kind: 'wait', targetId: null, itemId: null, target: null }],
    socialReactions: [social],
  };
  const interpreted = await generate('plan', socialAnswer, {
    observations: [{ id: 'heard-alice' }],
  });
  assert.deepEqual(interpreted.proposal.socialReactions, [social]);
  assert.equal(interpreted.proposal.knowledgeRevision, 4);
  assert.equal((await generate('plan', socialAnswer)).failureCode, 'PROVIDER_INVALID_EVIDENCE');
  assert.equal(
    (await generate('plan', { ...socialAnswer, socialReactions: [{ ...social, trust: 1 }] }))
      .failureCode,
    'PROVIDER_INVALID_RESULT',
  );

  const bad = await generate('speech', {
    text: 'Hello',
    cognition: { ...cognition, audienceIds: ['alice'] },
  });
  assert.equal(bad.proposal, null);
  assert.equal(bad.failureCode, 'PROVIDER_INVALID_RESULT');
  assert.equal(bad.failureStage, 'response_schema');
  const malformedPlan = await generate('plan', {
    actions: [{ kind: 'wait', targetId: 'unexpected', itemId: null, target: null }],
  });
  assert.equal(malformedPlan.failureCode, 'PROVIDER_INVALID_RESULT');
  assert.equal(malformedPlan.failureStage, 'plan_actions');
  assert.deepEqual(Object.keys(malformedPlan).sort(), [
    'failureCode',
    'failureStage',
    'proposal',
    'requestId',
    'usage',
  ]);
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

test('plan structured output excludes the action combinations rejected by the executable contract', () => {
  const { gameActionSchema } = require('@dreamwalk/contracts');
  const variants = openAiOutputSchema('plan').properties.actions.items.anyOf;
  const variantsByKind = new Map(
    variants.flatMap((v) => v.properties.kind.enum.map((kind) => [kind, v])),
  );
  assert.deepEqual([...variantsByKind.keys()].sort(), [
    'close',
    'communicate',
    'give',
    'hit',
    'inspect',
    'lock',
    'move_to',
    'open',
    'push',
    'unlock',
    'wait',
  ]);
  for (const [kind, schema] of variantsByKind) {
    const sample = {
      kind,
      channel: null,
      observationIds: null,
      targetId: null,
      itemId: null,
      target: null,
    };
    const p = schema.properties;
    assert.deepEqual(schema.required.sort(), Object.keys(sample).sort());
    assert.equal(schema.additionalProperties, false);
    if (p.targetId.type === 'string') sample.targetId = 'synthetic-target';
    if (p.itemId.type === 'string') sample.itemId = 'synthetic-item';
    if (kind === 'move_to') {
      sample.target = { x: 4, y: 5 };
      assert.equal(p.target.properties.x.maximum, 63);
      assert.equal(p.targetId.type, 'null');
      assert.equal(p.itemId.type, 'null');
    }
    if (kind === 'communicate') {
      sample.channel = 'say';
      sample.observationIds = ['synthetic-observation'];
      assert.equal(p.observationIds.minItems, 1);
    } else {
      assert.equal(p.channel.type, 'null');
      assert.equal(p.observationIds.type, 'null');
    }
    if (kind === 'wait') {
      for (const field of ['targetId', 'itemId', 'target']) assert.equal(p[field].type, 'null');
    }
    assert.equal(
      gameActionSchema.safeParse(
        Object.fromEntries(Object.entries(sample).filter(([, value]) => value !== null)),
      ).success,
      true,
    );
  }
});
