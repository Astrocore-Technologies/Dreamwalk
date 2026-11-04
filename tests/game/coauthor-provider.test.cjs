process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const { OpenAiNpcProvider, openAiOutputSchema } = require('../../apps/api/dist/ai/openai-provider');
const { StoryTurnRuntime } = require('../../apps/api/dist/game/story-turn-runtime');
test('actual turn-post route materializes and speaks as a professor with one synthetic model dispatch', async () => {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  let state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
  state = g.initializeTurnController(state, ['alice']).state;
  const input = {
    operationId: randomUUID(),
    text: '*подходя к месту, парень остановился перед профессором* Профессор, Мира сказала что не знает о пропуске.',
    channel: 'say',
    replyLocale: 'ru',
    expectedCanonRevision: 0,
    turnFence: g.turnFence(state),
  };
  const turnId = randomUUID(),
    runtime = Object.create(StoryTurnRuntime.prototype);
  const post = runtime.simulateTurnPost(state, 'alice', input, turnId, 'synthetic-owner');
  assert.equal(post.requests.length, 0);
  assert.equal(post.untrustedRoleplay.length, 1);
  assert.equal(post.directorText, input.text.replace('* Профессор', '*\nПрофессор'));
  state = g.endPlayerTurn(post.state, 'alice', g.turnFence(post.state)).state;
  const worldInput = { ...input, text: post.directorText, turnFence: g.turnFence(state) };
  const context = {
    ...g.buildStoryTurnContext(state, 'alice', worldInput, turnId),
    turnBasedDeferredDirector: true,
    untrustedRoleplay: post.untrustedRoleplay,
  };
  const seed = g.createMockNarrativeProposal(state, 'alice', worldInput.text, turnId, 'ru');
  const spawn = context.director.availableConnections.find(
    (p) => g.footprintDistance(state.entities.alice, p) === 1,
  );
  assert.ok(spawn);
  const response = {
    status: 'ready',
    code: null,
    steps: [
      { segmentIndex: 0, action: null, reply: null, replyNpcId: null, replyContextHash: null },
      {
        segmentIndex: 1,
        action: null,
        replyNpcId: 'new_npc',
        replyContextHash: null,
        reply: { text: 'Мира так сказала? Что именно ты у неё спросил?', code: null },
      },
    ],
    narrative: {
      narration: 'Профессор отрывается от своих записей.',
      newScene: null,
      newNpc: {
        ...seed.newNpc,
        name: 'Профессор Орин',
        roleLabel: 'Профессор',
        placement: 'current',
        spawn,
        knownEntityIds: [],
      },
      evidenceIds: [],
    },
  };
  let calls = 0;
  const provider = new OpenAiNpcProvider(
    {
      enabled: true,
      apiKey: 'synthetic-fixture-key',
      model: 'synthetic-model',
      version: 'coauthor-test',
      maxInputBytes: 64000,
      maxOutputTokens: 1000,
      maxResponseBytes: 1000000,
      inputMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
    },
    async (url, init) => {
      calls++;
      const request = JSON.parse(init.body);
      assert.ok(request.text.format.schema.properties.steps.items.properties.replyContextHash);
      assert.match(request.instructions, /no inherited memory/);
      assert.match(
        request.instructions,
        /newborn reply.*companionIntent=null and actionIntent=null/i,
      );
      assert.match(request.instructions, /only wait actions/);
      assert.match(request.instructions, /Never invent or infer a source observation ID/);
      assert.match(request.instructions, /does not prove Mira said it/);
      assert.match(request.instructions, /Russian/);
      return new Response(
        JSON.stringify({
          id: 'synthetic-request',
          status: 'completed',
          service_tier: 'default',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(response) }] },
          ],
          usage: { input_tokens: 50, output_tokens: 100 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );
  const generated = await provider.generate({
    jobId: randomUUID(),
    purpose: 'story_turn',
    context,
    signal: new AbortController().signal,
    maxCostMicros: 100,
  });
  assert.equal(generated.failureCode, undefined);
  assert.equal(calls, 1);
  const applied = g.applyStoryTurnProposal(state, 'alice', worldInput, turnId, generated.proposal);
  assert.equal(applied.error, undefined);
  assert.equal(applied.clarification, undefined);
  assert.equal(applied.actions.length, 0);
  assert.deepEqual(applied.state.entities.alice, state.entities.alice);
  const id = `support-${turnId}`;
  assert.ok(
    g
      .projectState(JSON.parse(JSON.stringify(applied.state)), 'alice')
      .entities.some((e) => e.id === id),
  );
  const said = applied.state.npcBrains[id].living.observations.filter((o) => o.kind === 'said');
  assert.ok(JSON.stringify(said).includes('Мира сказала'));
  assert.ok(!JSON.stringify(said).includes('подходя к месту'));
  assert.equal(applied.entries.filter((e) => e.kind === 'npc_reply').length, 1);
});
test('approach is scoped to story proposals, not arbitrary actor actions', () => {
  assert.ok(JSON.stringify(openAiOutputSchema('story_turn')).includes('approach'));
  assert.equal(
    g.gameActionSchema.safeParse({ kind: 'approach', targetId: 'keeper' }).success,
    false,
  );
});

test('director existing-speaker intents survive synthetic provider transport and atomic core admission', async () => {
  for (const kind of ['follow', 'wait']) {
    const state = g.createStateFromPlayable(
      g.compilePlayableDraft(g.createCompleteObservatoryDraft()).playable,
      ['alice'],
    );
    Object.assign(state.entities.alice, { x: 5, y: 4 });
    const input = {
      operationId: randomUUID(),
      text: kind === 'follow' ? 'Will you accompany me?' : 'Please wait here.',
      channel: 'say',
      expectedCanonRevision: 0,
      replyLocale: 'en',
    };
    const turnId = randomUUID();
    const context = g.buildStoryTurnContext(state, 'alice', input, turnId);
    const voice = context.sceneSpeakers.find(
      (entry) => entry.npcId === 'keeper' && entry.segmentIndex === 0,
    );
    assert.ok(voice?.replyToObservationId);
    assert.equal(voice.actionContext, undefined);
    const answer = {
      status: 'ready',
      code: null,
      narrative: {
        narration: 'The keeper answers.',
        newScene: null,
        newNpc: null,
        evidenceIds: [],
      },
      steps: [
        {
          segmentIndex: 0,
          action: null,
          replyNpcId: 'keeper',
          replyContextHash: voice.speechHash,
          reply: {
            text: kind === 'follow' ? 'I will accompany you.' : 'I will wait here.',
            code: null,
            companionIntent:
              kind === 'follow'
                ? {
                    kind: 'follow',
                    actorId: 'alice',
                    sourceObservationId: voice.replyToObservationId,
                  }
                : null,
            actionIntent:
              kind === 'wait'
                ? {
                    sourceObservationId: voice.replyToObservationId,
                    actions: [{ kind: 'wait', targetId: null, target: null }],
                  }
                : null,
          },
        },
      ],
    };
    let calls = 0;
    const provider = new OpenAiNpcProvider(
      {
        enabled: true,
        apiKey: 'synthetic-fixture-key',
        model: 'synthetic-model',
        version: 'director-binding-test',
        maxInputBytes: 64000,
        maxOutputTokens: 1000,
        maxResponseBytes: 1000000,
        inputMicrosPerMillion: 1,
        outputMicrosPerMillion: 1,
      },
      async (_url, init) => {
        calls++;
        const request = JSON.parse(init.body);
        assert.match(request.instructions, /only wait actions/);
        assert.match(
          request.instructions,
          /Copy sourceObservationId exactly from that voice replyToObservationId/,
        );
        return new Response(
          JSON.stringify({
            id: 'synthetic-director-intent',
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
    const generated = await provider.generate({
      jobId: randomUUID(),
      purpose: 'story_turn',
      context,
      signal: new AbortController().signal,
      maxCostMicros: 100,
    });
    assert.equal(generated.failureCode, undefined);
    assert.equal(calls, 1);
    const applied = g.applyStoryTurnProposal(state, 'alice', input, turnId, generated.proposal);
    assert.equal(applied.error, undefined);
    assert.equal(applied.state.narrativeCanon.revision, 1);
    assert.equal(applied.entries.filter((entry) => entry.kind === 'npc_reply').length, 1);
    if (kind === 'follow')
      assert.equal(applied.state.npcBrains.keeper.living.companionship.actorId, 'alice');
    else assert.deepEqual(applied.state.npcBrains.keeper.plan, [{ kind: 'wait' }]);
    assert.deepEqual(applied.state.entities.alice, state.entities.alice);
  }
});
