const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOpenAiNpcRequestBody,
  openAiOutputSchema,
} = require('../../apps/api/dist/ai/openai-provider');
const { runtimeVisionInstructions } = require('../../apps/api/dist/ai/runtime-vision');
const config = { model: 'synthetic-no-network', maxOutputTokens: 1000 };
const emptyEnvelopeDiagnostic = {
  reason: 'missing_output_text',
  outputItems: '0',
  messageItems: '0',
  contentItems: '0',
  outputTextItems: '0',
  hasMalformedMessage: false,
  hasMalformedOutputText: false,
  hasOtherOutput: false,
  hasOtherContent: false,
};
const envelopeText = { type: 'output_text', text: JSON.stringify({ text: 'Hello' }) };
const envelopeMessage = (...content) => ({ type: 'message', content });
async function generateEnvelope(output, overrides = {}) {
  const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
  let calls = 0;
  const provider = new OpenAiNpcProvider(
    {
      ...config,
      enabled: true,
      apiKey: 'synthetic-no-network-key',
      version: 'envelope-fixture',
      maxInputBytes: 64000,
      maxResponseBytes: 64000,
      inputMicrosPerMillion: 100000,
      outputMicrosPerMillion: 500000,
    },
    async () => {
      calls++;
      return new Response(
        JSON.stringify({
          id: 'synthetic-envelope',
          status: 'completed',
          service_tier: 'default',
          usage: { input_tokens: 50, output_tokens: 100 },
          output,
          ...overrides,
        }),
      );
    },
  );
  try {
    return await provider.generate({
      jobId: 'synthetic-job',
      purpose: 'speech',
      context: { contextHash: 'fixture', privateNote: 'PRIVATE_CONTEXT_CANARY' },
      signal: new AbortController().signal,
      maxCostMicros: 10000,
    });
  } finally {
    assert.equal(calls, 1, 'envelope diagnostics never dispatch a repair or retry');
  }
}

for (const [name, output, expected] of [
  ['empty output', [], {}],
  [
    'reasoning-only output',
    [{ type: 'reasoning', summary: 'PRIVATE_PROVIDER_CANARY' }],
    { outputItems: '1', hasOtherOutput: true },
  ],
  ['empty message', [envelopeMessage()], { outputItems: '1', messageItems: '1' }],
  [
    'malformed and non-message output',
    [null, { type: 'message' }, { type: 'message', content: 'PRIVATE_PROVIDER_CANARY' }],
    { outputItems: '2+', hasMalformedMessage: true, hasOtherOutput: true },
  ],
  [
    'malformed text fields',
    [envelopeMessage({ type: 'output_text' }, { type: 'output_text', text: { private: true } })],
    { outputItems: '1', messageItems: '1', contentItems: '2+', hasMalformedOutputText: true },
  ],
  [
    'unrecognized and primitive content',
    [envelopeMessage(null, { type: 'PRIVATE_PROVIDER_CANARY', text: 'PRIVATE_PROVIDER_CANARY' })],
    { outputItems: '1', messageItems: '1', contentItems: '2+', hasOtherContent: true },
  ],
  [
    'multiple texts within one message',
    [envelopeMessage(envelopeText, envelopeText, envelopeText)],
    {
      reason: 'multiple_output_texts',
      outputItems: '1',
      messageItems: '1',
      contentItems: '2+',
      outputTextItems: '2+',
    },
  ],
  [
    'multiple texts across messages',
    [envelopeMessage(envelopeText), envelopeMessage(envelopeText)],
    {
      reason: 'multiple_output_texts',
      outputItems: '2+',
      messageItems: '2+',
      contentItems: '2+',
      outputTextItems: '2+',
    },
  ],
  [
    'refusal',
    [envelopeMessage({ type: 'refusal', refusal: 'PRIVATE_PROVIDER_CANARY' })],
    { reason: 'refusal', outputItems: '1', messageItems: '1', contentItems: '1' },
  ],
  [
    'refusal wins over multiple and malformed texts',
    [
      envelopeMessage(
        envelopeText,
        envelopeText,
        { type: 'refusal', refusal: 'PRIVATE_PROVIDER_CANARY' },
        { type: 'output_text', text: 42 },
      ),
    ],
    {
      reason: 'refusal',
      outputItems: '1',
      messageItems: '1',
      contentItems: '2+',
      outputTextItems: '2+',
      hasMalformedOutputText: true,
    },
  ],
])
  test(`output envelope diagnostic: ${name}`, async () => {
    const { validateProviderResult } = require('../../apps/api/dist/ai/provider');
    const result = validateProviderResult(await generateEnvelope(output));
    assert.deepEqual(result.outputEnvelope, { ...emptyEnvelopeDiagnostic, ...expected });
    assert.equal(
      result.failureCode,
      expected.reason === 'refusal' ? 'PROVIDER_REFUSED' : 'PROVIDER_INVALID_RESULT',
    );
    assert.equal(result.failureStage, 'output_envelope');
    assert.equal(result.proposal, null);
    assert.equal(result.usage.costMicros, 55);
    assert.equal(result.usage.costEvidence, 'configured_rates');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|Hello/);
    assert.ok(JSON.stringify(result.outputEnvelope).length < 350);
  });

test('shape observation preserves permissive filtering, single-text success and later failure stages', async () => {
  const success = await generateEnvelope([
    null,
    { type: 'reasoning', summary: 'PRIVATE_PROVIDER_CANARY' },
    { type: 'message', content: 'invalid' },
    envelopeMessage({ type: 'output_text', text: false }, null, envelopeText),
  ]);
  assert.equal(success.proposal.text, 'Hello');
  assert.deepEqual(Object.keys(success).sort(), ['proposal', 'requestId', 'usage']);
  for (const [text, stage] of [
    ['PRIVATE_NON_JSON', 'json'],
    ['{}', 'response_schema'],
  ]) {
    const failure = await generateEnvelope([envelopeMessage({ type: 'output_text', text })]);
    assert.equal(failure.failureCode, 'PROVIDER_INVALID_RESULT');
    assert.equal(failure.failureStage, stage);
    assert.equal(failure.outputEnvelope, undefined);
  }
  const incomplete = await generateEnvelope([], { status: 'incomplete' });
  assert.equal(incomplete.failureCode, 'PROVIDER_INCOMPLETE');
  assert.equal(incomplete.outputEnvelope, undefined);
  const overLimit = await generateEnvelope([], {
    usage: { input_tokens: 50, output_tokens: 1001 },
  });
  assert.equal(overLimit.failureCode, 'PROVIDER_LIMIT_VIOLATION');
  assert.equal(overLimit.outputEnvelope, undefined);
});

test('unknown outer envelope, usage and tier remain uncertain with no fabricated diagnostics', async () => {
  for (const [output, overrides, code] of [
    [null, {}, 'PROVIDER_USAGE_UNKNOWN'],
    [
      [],
      { usage: { input_tokens: 'PRIVATE_USAGE', output_tokens: 100 } },
      'PROVIDER_USAGE_UNKNOWN',
    ],
    [[], { service_tier: 'unknown' }, 'PROVIDER_TIER_UNKNOWN'],
  ])
    await assert.rejects(generateEnvelope(output, overrides), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.uncertain, true);
      assert.equal(error.outputEnvelope, undefined);
      return true;
    });
});

test('optional output diagnostic is strict, finite and backward compatible', () => {
  const { validateProviderResult } = require('../../apps/api/dist/ai/provider');
  const legacy = {
    requestId: 'fixture',
    proposal: null,
    failureCode: 'PROVIDER_INVALID_RESULT',
    failureStage: 'output_envelope',
    usage: { inputTokens: 50, outputTokens: 100, costMicros: 55 },
  };
  assert.deepEqual(validateProviderResult(legacy), legacy);
  const valid = { ...legacy, outputEnvelope: { ...emptyEnvelopeDiagnostic } };
  assert.deepEqual(validateProviderResult(valid), valid);
  for (const invalid of [
    { ...emptyEnvelopeDiagnostic, text: 'PRIVATE_PROVIDER_CANARY' },
    { ...emptyEnvelopeDiagnostic, path: ['PRIVATE_PATH_CANARY'] },
    { ...emptyEnvelopeDiagnostic, reason: 'PRIVATE_REASON_CANARY' },
    { ...emptyEnvelopeDiagnostic, outputItems: 17 },
    { ...emptyEnvelopeDiagnostic, outputTextItems: '17' },
    { ...emptyEnvelopeDiagnostic, hasOtherContent: 'PRIVATE_FLAG_CANARY' },
    { ...emptyEnvelopeDiagnostic, contentItems: undefined },
    null,
  ])
    assert.throws(() => validateProviderResult({ ...legacy, outputEnvelope: invalid }));
});
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

test('real reply and planner contracts distinguish ongoing accompaniment from a one-time approach', () => {
  const plan = JSON.parse(buildOpenAiNpcRequestBody(config, 'plan', { npcId: 'keeper' }));
  assert.match(plan.instructions, /companionship.nextAction/);
  assert.match(plan.instructions, /old move_to destination/);
  assert.match(plan.instructions, /You may deliberately pause or choose a competing action/);
  assert.match(plan.instructions, /ending it requires a supported public companionIntent stop/);
  assert.match(
    plan.instructions,
    /neither a player invitation nor your cognition or move_to establishes one/,
  );
  assert.match(openAiOutputSchema('plan').properties.actions.description, /current nextAction/);
  for (const [purpose, context] of [
    ['speech', {}],
    ['story_turn', { mode: 'npc' }],
    ['story_turn', { mode: 'director' }],
  ]) {
    const body = JSON.parse(buildOpenAiNpcRequestBody(config, purpose, context));
    assert.match(
      body.instructions,
      /Choose companionIntent and (?:spoken text|the reply) together/,
    );
    assert.match(body.instructions, /one-time move_to or approach/i);
    assert.match(body.instructions, /conditional offer/i);
    assert.match(body.instructions, /Do not claim movement or arrival|do not claim arrival/);
    const replySchema =
      purpose === 'speech'
        ? openAiOutputSchema(purpose)
        : openAiOutputSchema(purpose).properties.steps.items.properties.reply.anyOf[0];
    assert.match(replySchema.properties.companionIntent.description, /agreement.*requires follow/);
    assert.match(
      replySchema.properties.companionIntent.description,
      /text alone never creates follow/,
    );
  }
});
test('map guidance explicitly locates this NPC before interpreting its visible neighborhood', () => {
  assert.match(runtimeVisionInstructions, /context.npcId in the marker legend/);
  assert.match(runtimeVisionInstructions, /image neighborhood around its own marker/);
  assert.match(runtimeVisionInstructions, /Never invent falling, drowning, collisions/);
  assert.match(runtimeVisionInstructions, /not additional entities/);
  assert.match(runtimeVisionInstructions, /uncertain visual observations/);
});

test('audience-safe speech never equates filtered memory with autobiographical amnesia', () => {
  for (const [purpose, context] of [
    ['speech', {}],
    ['story_turn', { mode: 'npc' }],
    ['story_turn', { mode: 'director' }],
  ]) {
    const body = JSON.parse(buildOpenAiNpcRequestBody(config, purpose, context));
    assert.match(body.instructions, /audience-limited context is not an exhaustive autobiography/);
    assert.match(
      body.instructions,
      /Missing dialogue is not evidence.*never heard, knew or participated/,
    );
    assert.match(body.instructions, /do not infer that hidden memories exist/);
    assert.match(body.instructions, /narrow uncertainty/);
    assert.match(body.instructions, /Intentional in-character deception.*remains possible/);
    assert.match(body.instructions, /missing evidence alone is not such a decision/);
  }
});

test('synthetic real-adapter reply commits follow and a later planner can choose its updated step', async () => {
  const g = require('../../packages/game-core/dist');
  const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
  const { randomUUID } = require('node:crypto');
  const draft = g.createCompleteObservatoryDraft();
  draft.turnRules = g.turnRulesSchema.parse({});
  let s = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
  Object.assign(s.entities.alice, { x: 5, y: 4 });
  const speech = { channel: 'say', text: 'Come closer, then come with me to the workshop.' };
  const identity = { turnId: randomUUID(), segmentIndex: 0 };
  const spoken = g.applyNpcSpeech(s, 'alice', 'keeper', speech, { suppressReply: true, identity });
  assert.equal(spoken.error, undefined);
  s = spoken.state;
  const source = g.admittedNpcSpeechObservationId(s, 'alice', 'keeper', speech, identity);
  s.npcBrains.keeper.plan = [{ kind: 'move_to', target: { x: 9, y: 6 } }];
  s.npcBrains.keeper.cursor = 0;
  const safe = g.buildNpcPublicSpeechContext(
    s,
    'keeper',
    g.npcSpeechProspectiveListenerIds(s, 'keeper', 'say'),
    [source],
    [],
    undefined,
    'en',
    'alice',
  );
  const requests = [];
  let answer;
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
    async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          id: `synthetic-${requests.length}`,
          status: 'completed',
          service_tier: 'default',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
          ],
          usage: { input_tokens: 50, output_tokens: 100 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );
  const generate = (purpose, context) =>
    provider.generate({
      jobId: `synthetic-${purpose}`,
      purpose,
      context,
      signal: new AbortController().signal,
      maxCostMicros: 100,
    });
  answer = {
    silent: false,
    cognition: null,
    text: 'Yes, I will go with you to the workshop.',
    companionIntent: { kind: 'follow', actorId: 'alice', sourceObservationId: source },
    actionIntent: null,
    itemIntents: [],
  };
  const reply = await generate('speech', {
    ...safe,
    recipientId: 'alice',
    channel: 'say',
    replyToObservationId: source,
    currentUtterance: safe.claims.find((claim) => claim.observationId === source),
  });
  assert.equal(reply.failureCode, undefined);
  assert.deepEqual(reply.proposal.companionIntent, answer.companionIntent);
  const accepted = g.commitNpcPublicUtterance(s, 'keeper', {
    ...reply.proposal,
    channel: 'say',
    recipientId: 'alice',
    observationIds: [source],
    replyToObservationId: source,
    contextHash: g.npcContextFingerprint(safe),
  });
  assert.equal(accepted.error, undefined);
  s = accepted.state;
  assert.equal(s.npcBrains.keeper.living.companionship.actorId, 'alice');
  assert.deepEqual(s.npcBrains.keeper.plan, []);
  s = g.applyTurnMove(s, 'alice', { x: 3, y: 6 }, g.turnFence(s)).state;
  s = g.endPlayerTurn(s, 'alice', g.turnFence(s)).state;
  const context = {
    ...g.buildNpcDecisionContext(s, 'keeper'),
    mockProposal: g.createMockNpcPlan(s, 'keeper'),
  };
  const followStep = context.companionship.nextAction;
  assert.equal(followStep.kind, 'move_to');
  answer = {
    cognition: null,
    beliefRevisions: [],
    socialReactions: [],
    actions: [{ ...followStep, targetId: null, itemId: null, channel: null, observationIds: null }],
  };
  const planned = await generate('plan', context);
  assert.equal(planned.failureCode, undefined);
  assert.deepEqual(planned.proposal.actions, [followStep]);
  const plan = g.acceptNpcPlan(s, 'keeper', planned.proposal);
  assert.equal(plan.error, undefined);
  const moved = g.stepWorldNpcPlan(plan.state, 'keeper');
  assert.equal(moved.error, undefined);
  assert.ok(g.footprintDistance(moved.state.entities.keeper, moved.state.entities.alice) <= 1);
  assert.equal(
    requests.length,
    2,
    'one speech and one ordinary plan; no repair or extra follow call',
  );
  assert.equal(
    requests[0].text.format.schema.properties.companionIntent.anyOf[0].properties.kind.enum.includes(
      'follow',
    ),
    true,
  );
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

test('autonomous communication quotes and dispatches a speech-only schema without changing normal replies', async () => {
  const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
  const { countRequestBody } = require('../../apps/api/dist/ai/text-preflight');
  const source = {
    npcId: 'keeper',
    recipientId: 'alice',
    channel: 'say',
    replyLocale: 'en',
    responseOptional: true,
    worldPlanCommunication: {
      sourceRequestId: 'plan',
      roundId: 'round',
      brainGeneration: 1,
      cursor: 0,
    },
  };
  const config = {
    enabled: true,
    apiKey: 'synthetic-only',
    model: 'synthetic-no-network',
    version: 'communication-contract',
    maxInputBytes: 64000,
    maxModelInputTokens: 1050000,
    maxOutputTokens: 2048,
    maxResponseBytes: 64000,
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
  const quoted = new OpenAiNpcProvider(config, async () => {
    throw Error('quote must not dispatch');
  });
  const prepared = quoted.prepareTextRequest('speech', source);
  const body = JSON.parse(prepared.body);
  const schema = body.text.format.schema.properties;
  assert.deepEqual(schema.companionIntent, { type: 'null' });
  assert.deepEqual(schema.actionIntent, { type: 'null' });
  assert.equal(schema.itemIntents.maxItems, 0);
  assert.deepEqual(JSON.parse(countRequestBody(prepared.body)).text, body.text);
  assert.match(body.instructions, /one communication selected by an existing voluntary plan/);
  assert.match(body.instructions, /Do not promise a new executable commitment/);
  assert.doesNotMatch(
    body.instructions,
    /Include follow when|include matching itemIntents|NPC engine actions are supported by actionIntent/,
  );
  const ordinary = JSON.parse(buildOpenAiNpcRequestBody(config, 'speech', { npcId: 'keeper' }));
  assert.equal(ordinary.text.format.schema.properties.itemIntents.maxItems, 2);
  assert.ok(ordinary.text.format.schema.properties.companionIntent.anyOf);
  assert.ok(ordinary.text.format.schema.properties.actionIntent.anyOf);
  assert.match(ordinary.instructions, /Include follow when/);
  for (const variant of ['speech', 'silence', 'follow', 'action', 'item']) {
    let calls = 0;
    let dispatched;
    const answer = {
      text: 'I saw the door open.',
      silent: false,
      cognition: null,
      companionIntent: null,
      actionIntent: null,
      itemIntents: [],
    };
    if (variant === 'silence') Object.assign(answer, { text: null, silent: true });
    if (variant === 'follow')
      answer.companionIntent = { kind: 'follow', actorId: 'alice', sourceObservationId: 'said' };
    if (variant === 'action')
      answer.actionIntent = { sourceObservationId: 'said', actions: [{ kind: 'wait' }] };
    if (variant === 'item')
      answer.itemIntents = [{ kind: 'give_stock', definitionId: 'key', recipientId: 'alice' }];
    const restarted = new OpenAiNpcProvider(config, async (_url, init) => {
      calls++;
      dispatched = init.body;
      return new Response(
        JSON.stringify({
          id: 'synthetic-response',
          status: 'completed',
          service_tier: 'default',
          usage: { input_tokens: 50, output_tokens: 10 },
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
          ],
        }),
      );
    });
    const restored = JSON.parse(JSON.stringify(source));
    const result = await restarted.generate({
      jobId: 'synthetic',
      purpose: 'speech',
      context: restored,
      signal: new AbortController().signal,
      maxCostMicros: prepared.snapshot.reserveMicros,
      textReservationSnapshot: structuredClone(prepared.snapshot),
    });
    assert.equal(dispatched, prepared.body);
    assert.equal(calls, 1);
    assert.equal(result.usage.costMicros, 60);
    assert.equal(result.usage.costVerifiedForSparks, true);
    if (variant === 'speech' || variant === 'silence') {
      assert.equal(result.failureCode, undefined);
      assert.equal(result.proposal.silent === true, variant === 'silence');
    } else {
      assert.equal(result.failureCode, 'PROVIDER_INVALID_ACTION');
      assert.equal(result.proposal, null);
      assert.equal(result.failureStage, 'response_schema');
    }
    const changed = { ...restored };
    delete changed.worldPlanCommunication;
    await assert.rejects(
      restarted.generate({
        jobId: 'synthetic',
        purpose: 'speech',
        context: changed,
        signal: new AbortController().signal,
        maxCostMicros: prepared.snapshot.reserveMicros,
        textReservationSnapshot: prepared.snapshot,
      }),
      (error) => error.code === 'PROVIDER_REQUEST_SNAPSHOT_CHANGED',
    );
    assert.equal(calls, 1, 'a changed execution contract cannot dispatch under the original quote');
  }
});

test('provider policy fingerprint covers the autonomous speech branch', () => {
  const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
  const providerConfig = {
    ...config,
    enabled: true,
    version: 'synthetic-contract',
    maxInputBytes: 64000,
    maxResponseBytes: 64000,
    inputMicrosPerMillion: 1,
    outputMicrosPerMillion: 1,
  };
  const original = OpenAiNpcProvider.prototype.body;
  const before = new OpenAiNpcProvider(providerConfig).version;
  try {
    OpenAiNpcProvider.prototype.body = function (purpose, context) {
      const body = original.call(this, purpose, context);
      return purpose === 'speech' && context.worldPlanCommunication
        ? JSON.stringify({
            ...JSON.parse(body),
            instructions: 'synthetic changed communication policy',
          })
        : body;
    };
    assert.notEqual(new OpenAiNpcProvider(providerConfig).version, before);
  } finally {
    OpenAiNpcProvider.prototype.body = original;
  }
  assert.equal(new OpenAiNpcProvider(providerConfig).version, before);
});
