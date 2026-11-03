process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  OpenAiNpcProvider,
  openAiOutputSchema,
  buildOpenAiNpcRequestBody,
} = require('../../apps/api/dist/ai/openai-provider');
const { GameService } = require('../../apps/api/dist/game/game.service');
const g = require('../../packages/game-core/dist');
const { protectedNpcEvidence } = require('../../apps/api/dist/game/npc-retention');
const config = {
  enabled: true,
  apiKey: 'synthetic-no-network-key',
  model: 'synthetic',
  version: 'companion-test',
  maxInputBytes: 64000,
  maxOutputTokens: 1000,
  maxResponseBytes: 64000,
  inputMicrosPerMillion: 1,
  outputMicrosPerMillion: 1,
};
function fixture() {
  const draft = g.createCompleteObservatoryDraft();
  draft.turnRules = g.turnRulesSchema.parse({});
  const s = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
  Object.assign(s.entities.alice, { x: 5, y: 4 });
  return s;
}
function provider(answer, calls) {
  return new OpenAiNpcProvider(config, async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        id: 'synthetic-response',
        status: 'completed',
        service_tier: 'default',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
        ],
        usage: { input_tokens: 50, output_tokens: 35 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
}
const generate = (p, purpose, context) =>
  p.generate({
    jobId: randomUUID(),
    purpose,
    context,
    signal: new AbortController().signal,
    maxCostMicros: 100,
  });

test('both strict provider reply schemas and guidance expose the same bounded companionship intent', () => {
  assert.deepEqual(
    [
      ...protectedNpcEvidence({
        companionship: { sourceObservationId: 'consent-source', utteranceId: 'npc-reply' },
      }),
    ].sort(),
    ['consent-source', 'npc-reply'],
  );
  const speech = openAiOutputSchema('speech').properties.companionIntent;
  const story =
    openAiOutputSchema('story_turn').properties.steps.items.properties.reply.anyOf[0].properties
      .companionIntent;
  assert.deepEqual(story, speech);
  for (const purpose of ['speech', 'story_turn']) {
    const body = JSON.parse(buildOpenAiNpcRequestBody(config, purpose, {}));
    assert.match(body.instructions, /player request.*never NPC agreement/);
    assert.match(body.instructions, /companionIntent/);
    assert.match(body.instructions, /free everyday roleplay/);
  }
});

test('fake Responses transport -> deferred speech evaluator -> authoritative agreement, without network or extra calls', async () => {
  let s = fixture();
  const speech = { text: 'Will you come with me?', channel: 'say' },
    identity = { turnId: randomUUID(), segmentIndex: 0 };
  s = g.applyNpcSpeech(s, 'alice', 'keeper', speech, { suppressReply: true, identity }).state;
  const marker = g.admittedNpcSpeechObservationId(s, 'alice', 'keeper', speech, identity);
  const deferredId = randomUUID();
  s = g.queueTurnSpeech(
    s,
    'alice',
    {
      id: deferredId,
      recipientId: 'keeper',
      utteranceId: marker,
      audienceIds: ['alice', 'keeper'],
      channel: 'say',
    },
    g.turnFence(s),
  ).state;
  s = g.endPlayerTurn(s, 'alice', g.turnFence(s)).state;
  const service = Object.create(GameService.prototype);
  service.ai = { contextBudgetBytes: () => 64000 };
  const context = service.speechContext(
    s,
    'keeper',
    'alice',
    'say',
    [marker],
    undefined,
    marker,
    deferredId,
    'ru',
  );
  const calls = [];
  const p = provider(
    {
      text: 'Да, пойдем вместе. Покажешь, где его найти?',
      itemIntents: [],
      companionIntent: { kind: 'follow', actorId: 'alice', sourceObservationId: marker },
    },
    calls,
  );
  const response = await generate(p, 'speech', context);
  assert.ok(response.proposal);
  const job = {
    id: randomUUID(),
    npcId: 'keeper',
    purpose: 'speech',
    context,
    contextHash: context.contextHash,
    proposal: response.proposal,
  };
  const evaluated = await service.evaluateDecision('synthetic-campaign', s, job);
  assert.equal(evaluated.accepted, true);
  assert.equal(evaluated.next.npcBrains.keeper.living.companionship.actorId, 'alice');
  Object.assign(evaluated.next.entities.alice, { x: 3, y: 6 });
  assert.equal(g.companionAction(evaluated.next, 'keeper').kind, 'move_to');
  assert.equal(calls.length, 1);
  const invalid = {
    ...job,
    proposal: {
      ...response.proposal,
      companionIntent: { ...response.proposal.companionIntent, actorId: 'other' },
    },
  };
  assert.equal((await service.evaluateDecision('synthetic-campaign', s, invalid)).accepted, false);
});

test('fake story-turn transport normalizes nullable fields and commits only validated NPC decision', async () => {
  const s = fixture(),
    turnId = randomUUID();
  const input = {
    operationId: randomUUID(),
    text: 'Come with me?',
    targetNpcId: 'keeper',
    channel: 'say',
    expectedCanonRevision: 0,
  };
  const context = g.buildStoryTurnContext(s, 'alice', input, turnId);
  const calls = [];
  const answer = {
    status: 'ready',
    code: null,
    narrative: null,
    steps: [
      {
        segmentIndex: 0,
        action: null,
        reply: {
          text: 'Yes, I will accompany you.',
          code: null,
          companionIntent: {
            kind: 'follow',
            actorId: 'alice',
            sourceObservationId: context.dialogues[0].replyToObservationId,
          },
        },
      },
    ],
  };
  const response = await generate(provider(answer, calls), 'story_turn', context);
  assert.ok(response.proposal);
  const result = g.applyStoryTurnProposal(s, 'alice', input, turnId, response.proposal);
  assert.equal(result.error, undefined);
  assert.equal(result.state.npcBrains.keeper.living.companionship.actorId, 'alice');
  answer.steps[0].reply.companionIntent = null;
  const flavor = await generate(provider(answer, calls), 'story_turn', context);
  assert.ok(flavor.proposal);
  assert.equal(
    g.applyStoryTurnProposal(s, 'alice', input, turnId, flavor.proposal).state.npcBrains.keeper
      .living.companionship,
    undefined,
  );
});
