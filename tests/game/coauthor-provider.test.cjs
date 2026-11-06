process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const { OpenAiNpcProvider, openAiOutputSchema } = require('../../apps/api/dist/ai/openai-provider');
const { GameService } = require('../../apps/api/dist/game/game.service');
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
  runtime.port = {
    prepareAreaTurnSpeech: (...args) => GameService.prototype.prepareAreaTurnSpeech(...args),
  };
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
  let capturedRequest;
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
      capturedRequest = JSON.parse(init.body);
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
  const request = capturedRequest;
  assert.ok(
    request.text.format.schema.properties.steps.items.anyOf.find((entry) => entry.properties)
      .properties.replyContextHash,
  );
  assert.match(
    request.instructions,
    /newly introduced NPC has only its immediate public identity and perception/,
  );
  assert.match(request.instructions, /newborn reply.*companionIntent=null and actionIntent=null/i);
  assert.match(request.instructions, /only wait actions/);
  assert.match(request.instructions, /Never invent or infer a source observation ID/);
  assert.match(request.instructions, /does not prove Mira said it/);
  assert.match(request.instructions, /Russian/);
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

test('deferred RP pickup survives strict provider transport and updates inventory with one synthetic dispatch', async () => {
  let state = g.createStateFromPlayable(
    g.compilePlayableDraft(g.createCompleteObservatoryDraft()).playable,
    ['alice'],
  );
  state = g.initializeTurnController(state, ['alice']).state;
  const input = {
    operationId: randomUUID(),
    text: '*положил синий платок себе в карман*',
    channel: 'say',
    replyLocale: 'ru',
    expectedCanonRevision: 0,
    turnFence: g.turnFence(state),
  };
  const turnId = randomUUID(),
    runtime = Object.create(StoryTurnRuntime.prototype);
  runtime.port = {
    prepareAreaTurnSpeech: (...args) => GameService.prototype.prepareAreaTurnSpeech(...args),
  };
  const post = runtime.simulateTurnPost(state, 'alice', input, turnId, 'synthetic-owner');
  assert.equal(post.untrustedRoleplay.length, 1);
  state = g.endPlayerTurn(post.state, 'alice', g.turnFence(post.state)).state;
  const worldInput = { ...input, text: post.directorText, turnFence: g.turnFence(state) };
  const context = {
    ...g.buildStoryTurnContext(state, 'alice', worldInput, turnId),
    turnBasedDeferredDirector: true,
    untrustedRoleplay: post.untrustedRoleplay,
  };
  const response = {
    status: 'ready',
    code: null,
    steps: [
      {
        segmentIndex: 0,
        action: { kind: 'pick_up', targetId: 'new_item', itemId: null },
        reply: null,
        replyNpcId: null,
        replyContextHash: null,
      },
    ],
    narrative: {
      narration: 'Вещь теперь в кармане.',
      newScene: null,
      newNpc: null,
      newItem: { name: 'синий платок', description: 'Обычная вещь неизвестного происхождения.' },
      evidenceIds: [],
    },
  };
  let calls = 0;
  let capturedRequest;
  const provider = new OpenAiNpcProvider(
    {
      enabled: true,
      apiKey: 'synthetic-fixture-key',
      model: 'synthetic-model',
      version: 'inventory-test',
      maxInputBytes: 64000,
      maxOutputTokens: 1000,
      maxResponseBytes: 1000000,
      inputMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
    },
    async (_url, init) => {
      calls++;
      capturedRequest = JSON.parse(init.body);
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
  const request = capturedRequest;
  assert.ok(request.text.format.schema.properties.narrative.anyOf[0].properties.newItem);
  assert.match(request.instructions, /create_prop creates an ordinary named prop in actorId/);
  assert.match(request.instructions, /Never invent a prior owner/);
  assert.equal(generated.failureCode, undefined);
  assert.equal(calls, 1);
  const applied = g.applyStoryTurnProposal(state, 'alice', worldInput, turnId, generated.proposal);
  assert.equal(applied.error, undefined);
  assert.equal(applied.clarification, undefined);
  assert.ok(applied.state.entities.alice.inventory.includes(`prop-${turnId}`));
  assert.equal(applied.state.entities[`prop-${turnId}`].ownerId, 'alice');
  assert.ok(applied.events.some((event) => event.kind === 'action.pick_up'));
});

test('turn-post pocketing an already carried prop is a no-op success, not a duplicate or failed action', () => {
  let state = g.createStateFromPlayable(
    g.compilePlayableDraft(g.createCompleteObservatoryDraft()).playable,
    ['alice'],
  );
  state = g.initializeTurnController(state, ['alice']).state;
  Object.assign(state.entities.key, { label: 'ribbon', ownerId: 'alice' });
  state.entities.alice.inventory.push('key');
  const input = {
    operationId: randomUUID(),
    text: '*put ribbon in my pocket*',
    channel: 'say',
    replyLocale: 'en',
    expectedCanonRevision: 0,
    turnFence: g.turnFence(state),
  };
  const runtime = Object.create(StoryTurnRuntime.prototype);
  runtime.port = {
    prepareAreaTurnSpeech: (...args) => GameService.prototype.prepareAreaTurnSpeech(...args),
  };
  const post = runtime.simulateTurnPost(state, 'alice', input, randomUUID(), 'synthetic-owner');
  assert.deepEqual(post.state.entities.alice.inventory, ['key']);
  assert.equal(
    post.state.turnController.resources.alice.additional,
    state.turnController.resources.alice.additional,
  );
  assert.equal(
    post.entries.some((entry) => entry.kind === 'outcome'),
    false,
  );
  assert.equal(post.untrustedRoleplay.length, 1);
  assert.equal(post.directorText, input.text);
  state = g.endPlayerTurn(post.state, 'alice', g.turnFence(post.state)).state;
  const worldInput = { ...input, text: post.directorText, turnFence: g.turnFence(state) };
  const turnId = randomUUID();
  const context = g.buildStoryTurnContext(state, 'alice', worldInput, turnId);
  const proposal = {
    turnId,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps: [
      {
        segmentIndex: 0,
        action: null,
        reply: null,
        establishedEvents: [
          { description: 'The ribbon stays in the pocket.', entityIds: [], effects: [] },
        ],
      },
    ],
    narrative: {
      narration: 'The ribbon stays in the pocket.',
      newScene: null,
      newNpc: null,
      evidenceIds: [],
    },
  };
  const applied = g.applyStoryTurnProposal(state, 'alice', worldInput, turnId, proposal);
  assert.equal(applied.error, undefined);
  assert.deepEqual(applied.state.entities.alice.inventory, ['key']);
  assert.deepEqual(applied.state.entities.key, state.entities.key);
  assert.equal(Object.keys(applied.state.entities).length, Object.keys(state.entities).length);
});

test('natural existing-item handoff survives deferred post, one injected provider response and atomic admission', async () => {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  let state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
  Object.assign(state.entities.alice, { x: 5, y: 4, inventory: ['key'] });
  Object.assign(state.entities.keeper, { x: 6, y: 4, label: 'Борис', inventory: [] });
  Object.assign(state.entities.key, { ownerId: 'alice', label: 'латунный ключ' });
  const oldFailureId = randomUUID();
  state.narrativeCanon = {
    revision: 1,
    turns: [
      {
        id: oldFailureId,
        actorId: 'alice',
        requestHash: 'old-failed-attempt',
        tick: state.tick,
        narration: 'Ты протягиваешь ключ; передача ещё не подтверждена.',
        evidenceIds: [],
      },
    ],
  };
  const oldHistory = structuredClone(state.narrativeCanon.turns[0]);
  state = g.initializeTurnController(state, ['alice']).state;
  const turnId = randomUUID();
  const input = {
    operationId: randomUUID(),
    text: '*Передаю Борису латунный ключ, который нашёл у входа.*',
    channel: 'say',
    replyLocale: 'ru',
    expectedCanonRevision: 1,
    turnFence: g.turnFence(state),
  };
  const runtime = Object.create(StoryTurnRuntime.prototype);
  runtime.port = {};
  const post = runtime.simulateTurnPost(state, 'alice', input, turnId, 'synthetic-owner');
  assert.equal(post.state.entities.key.ownerId, 'alice');
  state = g.endPlayerTurn(post.state, 'alice', g.turnFence(post.state)).state;
  const worldInput = { ...input, text: post.directorText, turnFence: g.turnFence(state) };
  const context = {
    ...g.buildStoryTurnContext(state, 'alice', worldInput, turnId),
    turnBasedDeferredDirector: true,
    untrustedRoleplay: post.untrustedRoleplay,
    roleplayPolicy: 'Player-authored RP, not a mechanical action or validated inventory change.',
  };
  assert.deepEqual(context.actionPreview, []);
  assert.deepEqual(context.actionOutcomes, []);
  assert.deepEqual(context.director.evidenceIds, [oldFailureId]);
  const beforeContext = structuredClone(context);
  assert.equal(context.itemTransferPolicy.segmentCandidates[0].items[0].id, 'key');
  let calls = 0;
  let capturedRequest;
  const provider = new OpenAiNpcProvider(
    {
      enabled: true,
      apiKey: 'synthetic-fixture-key',
      model: 'synthetic-model',
      version: 'handoff-test',
      maxInputBytes: 64000,
      maxOutputTokens: 1000,
      maxResponseBytes: 1000000,
      inputMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
    },
    async (_url, init) => {
      calls++;
      capturedRequest = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          id: 'synthetic-handoff',
          status: 'completed',
          service_tier: 'default',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    status: 'ready',
                    code: null,
                    steps: [
                      {
                        segmentIndex: 0,
                        action: { kind: 'give', itemId: 'key', targetId: 'keeper' },
                        reply: null,
                      },
                    ],
                    narrative: {
                      narration: 'Борис принял латунный ключ.',
                      newScene: null,
                      newNpc: null,
                      evidenceIds: [],
                    },
                  }),
                },
              ],
            },
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
  const request = capturedRequest;
  const supplied = JSON.parse(request.input).context;
  assert.equal(supplied.roleplayPolicy, g.storyDirectorRoleplayPolicy);
  assert.equal(supplied.resolutionPolicy, g.storyDirectorResolutionVersion);
  assert.match(
    request.instructions,
    /Write the successful candidate result, not an unconfirmed intention/,
  );
  assert.match(
    request.instructions,
    /ordinary current roleplay does not require a canon citation/i,
  );
  assert.equal(supplied.director.confirmedTurns[0].narration, oldHistory.narration);
  assert.match(request.instructions, /item_custody uses a named carried item for a handoff/);
  assert.match(request.instructions, /not a command vocabulary/);
  assert.match(
    request.instructions,
    /Fictional coins, trades and services never mutate Sparks, Dreams, wallets or payment state/,
  );
  assert.equal(generated.failureCode, undefined);
  assert.equal(calls, 1);
  const result = g.applyStoryTurnProposal(state, 'alice', worldInput, turnId, generated.proposal);
  assert.equal(result.error, undefined);
  assert.equal(result.clarification, undefined);
  assert.equal(result.state.entities.key.ownerId, 'keeper');
  assert.deepEqual(result.state.entities.keeper.inventory, ['key']);
  assert.equal(result.events.filter((e) => e.kind === 'action.give').length, 1);
  assert.deepEqual(
    context,
    beforeContext,
    'normalization must not rewrite stored context or history',
  );
  assert.deepEqual(result.state.narrativeCanon.turns[0], oldHistory);
  assert.deepEqual(result.state.narrativeCanon.turns.at(-1).evidenceIds, []);
  assert.equal(result.state.narrativeCanon.turns.at(-1).narration, 'Борис принял латунный ключ.');
  const reloaded = JSON.parse(JSON.stringify(result.state));
  const replay = g.applyStoryTurnProposal(
    reloaded,
    'alice',
    worldInput,
    turnId,
    generated.proposal,
  );
  assert.strictEqual(replay.state, reloaded);
  assert.deepEqual(replay.events, []);
  assert.equal(calls, 1);
});
