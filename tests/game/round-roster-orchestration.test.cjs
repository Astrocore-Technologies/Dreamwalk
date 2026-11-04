process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
const { GameService } = require('../../apps/api/dist/game/game.service');
function world(count = 5) {
  const draft = g.createCompleteObservatoryDraft();
  draft.turnRules = g.turnRulesSchema.parse({});
  let state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
  for (let i = 1; i < count; i++) {
    const id = `npc-${i}`;
    state.entities[id] = { ...structuredClone(state.entities.keeper), id, inventory: [] };
    state.npcBrains[id] = structuredClone(state.npcBrains.keeper);
  }
  for (const brain of Object.values(state.npcBrains)) {
    brain.plan = [];
    brain.cursor = 0;
    brain.living.causes = [];
  }
  return g.endPlayerTurn(state, 'alice', g.turnFence(state)).state;
}
function service() {
  const game = Object.create(GameService.prototype),
    requests = [],
    rosters = [];
  let preparations = 0;
  const query = async (sql, values) => {
    if (sql.startsWith('SELECT 1 FROM game_world_round_rosters'))
      return rosters.filter((r) => r.roundId === values[1]);
    if (sql.startsWith('SELECT npc_id,purpose')) return requests;
    throw new Error(sql);
  };
  game.db = { query };
  game.worldGeneration = { stopUnspentForUnknown: async () => {} };
  game.story = {
    prepareWorldRequests: async () => {
      preparations++;
    },
  };
  game.decisionContext = async (id, state, npcId) => ({
    ...g.buildNpcDecisionContext(state, npcId),
    turnFence: g.turnFence(state),
  });
  game.persist = async (id, live, state, kind, operation, extra) => {
    await extra({
      query: async (sql, v) => {
        if (sql.startsWith('INSERT INTO game_world_round_rosters'))
          rosters.push({ roundId: v[1], roster: JSON.parse(v[3]) });
        else if (sql.startsWith('INSERT INTO game_npc_decision_requests'))
          requests.push({
            id: v[0],
            npc_id: v[2],
            purpose: v[3],
            cause_key: v[4],
            context: JSON.parse(v[7]),
            status: 'queued',
          });
        else if (sql.includes("result_code='ROUND_CONTINUE'")) {
          for (const r of requests) if (v[0].includes(r.id)) r.status = 'fallback';
        } else throw new Error(sql);
        return { rows: [], rowCount: 1 };
      },
    });
    live.state = state;
  };
  return { game, requests, rosters, preparations: () => preparations };
}
test('empty world turn considers all calm NPCs once, including after restart and later arrivals', async () => {
  const { game, requests, rosters, preparations } = service(),
    live = { state: world(), decisionsPending: false };
  await game.scheduleRoundRequests('campaign', live);
  assert.equal(requests.length, 5);
  assert.ok(
    requests.every(
      (r) =>
        r.purpose === 'plan' &&
        r.cause_key === `round:${live.state.turnController.roundId}:${r.npc_id}`,
    ),
  );
  assert.equal(rosters[0].roster.length, 5);
  const restarted = Object.assign(Object.create(GameService.prototype), game);
  live.state.entities.arrival = { ...structuredClone(live.state.entities.keeper), id: 'arrival' };
  live.state.npcBrains.arrival = structuredClone(live.state.npcBrains.keeper);
  await restarted.scheduleRoundRequests('campaign', live);
  assert.equal(requests.length, 5);
  assert.equal(preparations(), 1);
});
test('an agreed witnessed off-map crossing is free and never builds a private model context', async () => {
  const { game, requests, rosters } = service(),
    live = { state: world(2) };
  const state = live.state,
    exit = state.maps.observatory.exits.find((e) => e.id === 'roof-exit');
  Object.assign(state.entities.alice, { mapId: exit.destinationMapId, x: 5, y: 5 });
  Object.assign(state.entities.keeper, { x: 12, y: 5 });
  state.entities.door.open = true;
  state.npcBrains.keeper.living.companionship = {
    actorId: 'alice',
    sourceObservationId: 'agreed',
    utteranceId: 'agreement',
    crossings: [{ mapId: 'observatory', exitId: exit.id, destinationMapId: exit.destinationMapId }],
  };
  game.decisionContext = async () => {
    throw new Error('off-map private deliberation');
  };
  await game.scheduleRoundRequests('campaign', live);
  assert.deepEqual(rosters[0].roster, [{ npcId: 'keeper', consideration: 'companion' }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, 'fallback');
  assert.equal(requests[0].context.offmapCompanionContinuation, true);
  const action = g.worldTurnCompanionContinuation(live.state, 'keeper');
  assert.deepEqual(action, { kind: 'transition', targetId: exit.id });
  const applied = g.applyWorldTurnAction(live.state, 'keeper', action, g.turnFence(live.state));
  assert.equal(applied.error, undefined);
  assert.equal(applied.state.entities.keeper.mapId, exit.destinationMapId);
  assert.equal(applied.state.entities['npc-1'].mapId, 'observatory');
});
test('an admitted plan still gets a fresh model decision every active round', async () => {
  const { game, requests } = service(),
    live = { state: world(2) };
  live.state.npcBrains.keeper.plan = [{ kind: 'wait' }];
  live.state.npcBrains.keeper.living.cognition = {
    motive: 'Rest',
    belief: 'Safe',
    intent: 'Wait',
    innerThought: 'I will wait.',
    reconsiderAfterRounds: 2,
    roundNumber: live.state.turnController.roundNumber - 1,
    knowledgeRevision: live.state.npcBrains.keeper.living.knowledgeRevision,
    tick: 0,
  };
  await game.scheduleRoundRequests('campaign', live);
  assert.equal(requests.find((r) => r.npc_id === 'keeper').status, 'queued');
  assert.equal(requests.find((r) => r.npc_id === 'npc-1').status, 'queued');
});
test('more than 32 present NPCs are all considered without a silent cap', async () => {
  const { game, requests, rosters } = service();
  await game.scheduleRoundRequests('campaign', { state: world(40) });
  assert.equal(requests.length, 40);
  assert.equal(rosters[0].roster.length, 40);
});
test('continuation is reconsidered after its round window, new knowledge or a blocker', async () => {
  for (const changed of ['expired', 'knowledge', 'blocked']) {
    const { game, requests } = service(),
      live = { state: world(1) };
    const memory = live.state.npcBrains.keeper.living;
    live.state.npcBrains.keeper.plan = [{ kind: 'wait' }];
    memory.cognition = {
      motive: 'Rest',
      belief: 'Safe',
      intent: 'Wait',
      innerThought: 'Wait.',
      reconsiderAfterRounds: 1,
      roundNumber: live.state.turnController.roundNumber - (changed === 'expired' ? 1 : 0),
      knowledgeRevision: memory.knowledgeRevision - (changed === 'knowledge' ? 1 : 0),
      tick: 0,
    };
    if (changed === 'blocked')
      memory.lastActionOutcome = { actionKind: 'move_to', status: 'blocked', tick: 0 };
    await game.scheduleRoundRequests('campaign', live);
    assert.equal(requests[0].status, 'queued', changed);
  }
});
test('frozen round plan survives unrelated revisions but not actor/map/brain/phase changes', async () => {
  const { game, requests } = service(),
    live = { state: world(2) };
  await game.scheduleRoundRequests('campaign', live);
  const request = requests.find((r) => r.npc_id === 'keeper');
  const changed = structuredClone(live.state);
  changed.revision += 3;
  changed.tick++;
  assert.equal(game.frozenRoundContext(changed, 'keeper', request.context), true);
  changed.npcBrains['npc-1'].generation++;
  assert.equal(game.frozenRoundContext(changed, 'keeper', request.context), true);
  changed.entities.keeper.revision++;
  assert.equal(game.frozenRoundContext(changed, 'keeper', request.context), false);
  changed.entities.keeper.revision--;
  changed.turnController.phaseEpoch++;
  assert.equal(game.frozenRoundContext(changed, 'keeper', request.context), false);
});
test('frozen speech never bypasses audience, claim or recipient changes', () => {
  const { game } = service(),
    state = world(1);
  const frozen = {
    contextHash: 'frozen',
    generationPolicy: 'world-batch-v1',
    worldPrepared: true,
    turnFence: g.turnFence(state),
    npcId: 'keeper',
    recipientId: 'alice',
    channel: 'say',
    claims: [{ observationId: 'safe', kind: 'said' }],
    audienceIds: ['alice', 'keeper'],
  };
  assert.equal(
    game.frozenSpeechContext(state, 'keeper', frozen, { ...frozen, contextHash: 'new' }),
    true,
  );
  assert.equal(
    game.frozenSpeechContext(state, 'keeper', frozen, {
      ...frozen,
      audienceIds: ['bob', 'keeper'],
    }),
    false,
  );
  assert.equal(game.frozenSpeechContext(state, 'keeper', frozen, { ...frozen, claims: [] }), false);
  assert.equal(
    game.frozenSpeechContext(state, 'keeper', frozen, { ...frozen, recipientId: 'bob' }),
    false,
  );
});

function speechFixture() {
  const draft = g.createAuthoredDraft('courtyard');
  draft.npcBehavior = 'reactive-v1';
  draft.turnRules = g.turnRulesSchema.parse({});
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
  state.maps.courtyard.blocked = [];
  state.maps.courtyard.width = state.maps.courtyard.height = 24;
  for (const entity of Object.values(state.entities))
    if (entity.kind === 'door') entity.open = true;
  Object.assign(state.entities.alice, { x: 5, y: 5 });
  Object.assign(state.entities.keeper, { x: 6, y: 5 });
  for (const [id, x] of [
    ['three', 8],
    ['six', 11],
    ['seven', 12],
  ]) {
    state.entities[id] = { ...state.entities.keeper, id, x };
    state.npcBrains[id] = structuredClone(state.npcBrains.keeper);
  }
  const game = Object.create(GameService.prototype);
  const { StoryTurnRuntime } = require('../../apps/api/dist/game/story-turn-runtime');
  const runtime = Object.create(StoryTurnRuntime.prototype);
  runtime.port = { prepareAreaTurnSpeech: game.prepareAreaTurnSpeech.bind(game) };
  return { state, game, runtime };
}
test('one area utterance creates all listener decisions and one player feed entry', () => {
  for (const [channel, text, expected] of [
    ['say', 'Hello', ['keeper', 'three']],
    ['say', 'Hello!', ['keeper', 'six', 'three']],
    ['whisper', 'Hello!', ['keeper']],
  ]) {
    const { state, runtime } = speechFixture();
    const id = require('node:crypto').randomUUID();
    const result = runtime.simulateTurnPost(
      state,
      'alice',
      {
        operationId: id,
        text,
        channel,
        expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
        turnFence: g.turnFence(state),
      },
      id,
      'owner',
    );
    assert.deepEqual(result.requests.map((r) => r.npcId).sort(), expected);
    assert.equal(result.entries.filter((e) => e.kind === 'speech').length, 1);
    assert.equal(result.state.npcUtterances.filter((e) => e.speakerId === 'alice').length, 1);
    assert.ok(result.requests.every((r) => r.context.responseOptional));
    assert.equal(
      result.directorText,
      '',
      'ordinary local conversation is not a second director charge',
    );
  }
});
test('exclamation inside emote does not make following normal speech a shout', () => {
  const { state, runtime } = speechFixture(),
    id = require('node:crypto').randomUUID();
  const result = runtime.simulateTurnPost(
    state,
    'alice',
    {
      operationId: id,
      text: '*Raises a hand!* Hello',
      channel: 'say',
      expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
      turnFence: g.turnFence(state),
    },
    id,
    'owner',
  );
  assert.deepEqual(result.requests.map((r) => r.npcId).sort(), ['keeper', 'three']);
});
test('one spoken segment can schedule more than 32 listeners without multiplying player speech', () => {
  const { state, runtime } = speechFixture();
  for (let i = 0; i < 40; i++) {
    const id = `crowd-${i}`;
    state.entities[id] = { ...state.entities.keeper, id };
    state.npcBrains[id] = structuredClone(state.npcBrains.keeper);
  }
  const id = require('node:crypto').randomUUID();
  const result = runtime.simulateTurnPost(
    state,
    'alice',
    {
      operationId: id,
      text: 'Hello',
      channel: 'say',
      expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
      turnFence: g.turnFence(state),
    },
    id,
    'owner',
  );
  assert.equal(result.requests.length, 42);
  assert.equal(result.entries.filter((e) => e.kind === 'speech').length, 1);
});
test('legacy unified story feed uses actual speech range and whisper bystanders', () => {
  for (const [channel, text, bob, heard] of [
    ['say', 'Hello', { x: 9, y: 5 }, false],
    ['say', 'Hello!', { x: 9, y: 5 }, true],
    ['whisper', 'Hello!', { x: 5, y: 6 }, true],
  ]) {
    const { state } = speechFixture();
    state.entities.bob = { ...structuredClone(state.entities.alice), id: 'bob', ...bob };
    const id = require('node:crypto').randomUUID();
    const input = {
      operationId: id,
      text,
      channel,
      targetNpcId: 'keeper',
      expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
    };
    const proposal = g.createMockStoryTurnProposal(state, 'alice', input, id);
    const applied = g.applyStoryTurnProposal(state, 'alice', input, id, proposal);
    assert.equal(applied.error, undefined);
    const spoken = applied.entries.find((entry) => entry.kind === 'speech');
    assert.equal(spoken.audienceIds.includes('bob'), heard, `${channel} ${text}`);
  }
});
test('optional listener silence resolves consideration without a fabricated utterance', async () => {
  const { state, game, runtime } = speechFixture(),
    id = require('node:crypto').randomUUID();
  game.ai = { contextBudgetBytes: () => 64000 };
  const posted = runtime.simulateTurnPost(
    state,
    'alice',
    {
      operationId: id,
      text: 'Hello',
      channel: 'say',
      expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
      turnFence: g.turnFence(state),
    },
    id,
    'owner',
  );
  const world = g.endPlayerTurn(posted.state, 'alice', g.turnFence(posted.state)).state;
  const request = posted.requests.find((r) => r.npcId === 'keeper');
  const context = game.deferredSpeechContext(world, request);
  const count = world.npcUtterances.length;
  const decision = await game.evaluateDecision('campaign', world, {
    id: request.id,
    npcId: request.npcId,
    purpose: 'speech',
    context,
    contextHash: context.contextHash,
    proposal: { silent: true },
  });
  assert.equal(decision.accepted, true);
  assert.equal(decision.next.npcUtterances.length, count);
  assert.ok(!decision.next.turnController.deferredSpeech.some((ref) => ref.id === request.id));
});
test('unsafe outgoing whisper becomes a free no-safe-response instead of blocking the world roster', async () => {
  const { state, game, runtime } = speechFixture(),
    id = require('node:crypto').randomUUID();
  state.entities.bob = { ...structuredClone(state.entities.alice), id: 'bob', x: 7, y: 5 };
  game.ai = { contextBudgetBytes: () => 64000 };
  const posted = runtime.simulateTurnPost(
    state,
    'alice',
    {
      operationId: id,
      text: 'Private words',
      channel: 'whisper',
      expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
      turnFence: g.turnFence(state),
    },
    id,
    'owner',
  );
  const request = posted.requests.find((r) => r.npcId === 'keeper');
  assert.ok(request);
  const world = g.endPlayerTurn(posted.state, 'alice', g.turnFence(posted.state)).state;
  const stopped = [];
  runtime.db = {
    query: async () => [
      {
        id: request.id,
        npc_id: request.npcId,
        purpose: 'speech',
        cause_key: request.causeKey,
        requester_user_id: 'owner',
        context: request.context,
      },
    ],
  };
  runtime.row = async () => ({
    id,
    actor_id: 'alice',
    requester_user_id: 'owner',
    status: 'committed',
  });
  runtime.port = {
    deferredSpeechContext: game.deferredSpeechContext.bind(game),
    failWorldRequest: async (...args) => stopped.push(args),
  };
  await runtime.prepareWorldRequests('campaign', { state: world });
  assert.deepEqual(stopped, [['campaign', request.id, 'NO_SAFE_RESPONSE']]);
  const unexpected = new Error('unexpected context implementation error');
  runtime.port.deferredSpeechContext = () => {
    throw unexpected;
  };
  await assert.rejects(
    runtime.prepareWorldRequests('campaign', { state: world }),
    (error) => error === unexpected,
  );
  assert.equal(stopped.length, 1);
});

test('durable speech feed preserves emission-time recognition across pruning, restart and later visibility', async () => {
  const { state, game, runtime } = speechFixture();
  const turnId = require('node:crypto').randomUUID();
  Object.assign(state.entities.alice, { x: 7, y: 5, label: 'Hidden player identity' });
  Object.assign(state.entities.keeper, { x: 5, y: 5, label: 'Hidden keeper identity' });
  state.entities.bob = { ...structuredClone(state.entities.alice), id: 'bob', x: 4, y: 5 };
  state.maps.courtyard.blocked = [{ x: 6, y: 5 }];
  game.ai = { contextBudgetBytes: () => 64000 };
  const posted = runtime.simulateTurnPost(
    state,
    'alice',
    {
      operationId: turnId,
      text: 'Who is there!',
      channel: 'say',
      expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
      turnFence: g.turnFence(state),
    },
    turnId,
    'owner',
  );
  const playerEntry = posted.entries.find((e) => e.kind === 'speech');
  assert.ok(playerEntry.speakerKnownToIds.includes('alice'));
  assert.ok(!playerEntry.speakerKnownToIds.includes('bob'));
  const world = g.endPlayerTurn(posted.state, 'alice', g.turnFence(posted.state)).state;
  const request = posted.requests.find((r) => r.npcId === 'keeper');
  const context = game.deferredSpeechContext(world, request);
  const result = await game.evaluateDecision('campaign', world, {
    id: request.id,
    npcId: 'keeper',
    purpose: 'speech',
    context,
    contextHash: context.contextHash,
    proposal: { text: 'You can hear me!' },
  });
  assert.equal(result.accepted, true);
  const source = result.next.npcUtterances.find(
    (u) => u.speakerId === 'keeper' && !world.npcUtterances.some((old) => old.id === u.id),
  );
  assert.ok(source.speakerKnownToIds.includes('bob'));
  assert.ok(!source.speakerKnownToIds.includes('alice'));
  const stored = [];
  const client = {
    query: async (sql, values) => {
      if (sql.startsWith('INSERT INTO game_story_feed'))
        stored.push({
          id: values[0],
          turn_id: values[1],
          sequence: values[3],
          ordinal: values[4],
          tick: values[5],
          audience_ids: values[7],
          entry: JSON.parse(values[8]),
          created_at: new Date(),
        });
      return { rows: [], rowCount: 1 };
    },
  };
  await runtime.writeFeed(client, 'campaign', turnId, 1, [playerEntry]);
  await runtime.writeDeferredReply(
    client,
    'campaign',
    world,
    result.next,
    { ...context, storyTurnId: turnId },
    2,
  );
  assert.equal(stored.length, 2);
  assert.deepEqual(stored[1].entry.speakerKnownToIds, source.speakerKnownToIds);
  // Legacy identity has no trustworthy historical evidence, even if visible now.
  stored.push({
    ...stored[1],
    id: 'legacy-row',
    entry: { ...stored[1].entry, speakerKnownToIds: undefined, text: 'Old words' },
  });
  stored.push({
    ...stored[1],
    id: 'mechanical-row',
    entry: {
      kind: 'outcome',
      channel: 'say',
      authorId: 'keeper',
      authorLabel: 'Mechanical attribution',
      code: 'ACTION_SUCCEEDED',
    },
  });
  const restored = JSON.parse(JSON.stringify(result.next));
  restored.npcUtterances = [];
  restored.maps.courtyard.blocked = [];
  const { StoryTurnRuntime } = require('../../apps/api/dist/game/story-turn-runtime');
  const restarted = Object.create(StoryTurnRuntime.prototype);
  restarted.reconcile = async () => {};
  restarted.db = {
    query: async (sql) => (sql.startsWith('SELECT f.*') ? structuredClone(stored) : []),
  };
  for (const viewer of ['alice', 'bob']) {
    restarted.port = {
      serial: async (id, run) => run(),
      access: async () => ({ actorId: viewer, user: { id: viewer } }),
      load: async () => ({ state: restored }),
    };
    const feed = await restarted.feed({}, 'campaign');
    const npc = feed.entries.find((e) => e.text === 'You can hear me!');
    const player = feed.entries.find((e) => e.text === 'Who is there!');
    assert.equal(npc.authorId, viewer === 'bob' ? 'keeper' : undefined);
    assert.equal(npc.authorLabel, viewer === 'bob' ? 'Hidden keeper identity' : undefined);
    assert.equal(player.authorId, viewer === 'alice' ? 'alice' : undefined);
    assert.equal(feed.entries.find((e) => e.text === 'Old words').authorId, undefined);
    assert.equal(feed.entries.find((e) => e.id === 'mechanical-row').authorId, 'keeper');
    assert.ok(feed.entries.every((e) => !('speakerKnownToIds' in e) && !('sourceId' in e)));
  }
});

test('departed-speaker replies stay unpaid and drain after a real exit, including split parties and restart', async () => {
  for (const split of [false, true]) {
    const draft = g.createCompleteObservatoryDraft();
    draft.turnRules = g.turnRulesSchema.parse({});
    let state = g.createStateFromPlayable(
      g.compilePlayableDraft(draft).playable,
      split ? ['alice', 'bob'] : ['alice'],
    );
    state.entities.door.open = true;
    Object.assign(state.entities.alice, { x: 12, y: 5 });
    Object.assign(state.entities.keeper, { x: 11, y: 5 });
    if (split) Object.assign(state.entities.bob, { x: 10, y: 5 });
    const { game, requests, rosters } = service();
    const turnId = require('node:crypto').randomUUID();
    const spoken = game.prepareAreaTurnSpeech(
      state,
      'alice',
      { channel: 'say', text: 'Hello' },
      'owner',
      { turnId, segmentIndex: 0 },
    );
    const request = spoken.requests.find((r) => r.npcId === 'keeper');
    assert.ok(request);
    const crossed = g.applyTurnAction(
      spoken.state,
      'alice',
      { kind: 'transition', targetId: 'roof-exit' },
      g.turnFence(spoken.state),
    );
    assert.equal(crossed.error, undefined);
    state = g.endPlayerTurn(crossed.state, 'alice', g.turnFence(crossed.state)).state;
    if (split) state = g.endPlayerTurn(state, 'bob', g.turnFence(state)).state;
    assert.equal(state.turnController.phase, 'world');
    const observationIds = state.npcBrains.keeper.living.observations.map((o) => o.id);
    const { StoryTurnRuntime } = require('../../apps/api/dist/game/story-turn-runtime');
    let status = 'queued',
      contextCalls = 0,
      failures = 0;
    const makeRuntime = () => {
      const runtime = Object.create(StoryTurnRuntime.prototype);
      runtime.db = {
        query: async () =>
          status === 'queued'
            ? [
                {
                  ...request,
                  npc_id: request.npcId,
                  purpose: 'speech',
                  context: { ...request.context, generationPolicy: 'world-batch-v1' },
                },
              ]
            : [],
      };
      runtime.row = async () => ({
        id: turnId,
        actor_id: 'alice',
        requester_user_id: 'owner',
        status: 'committed',
      });
      runtime.port = {
        deferredSpeechContext: () => {
          contextCalls++;
          throw new Error('must not prepare a cross-map image/context');
        },
        failWorldRequest: async (id, requestId, code) => {
          assert.equal(requestId, request.id);
          assert.equal(code, 'SPEECH_PARTICIPANT_DEPARTED');
          status = 'failed';
          failures++;
        },
      };
      return runtime;
    };
    await makeRuntime().prepareWorldRequests('campaign', { state });
    await makeRuntime().prepareWorldRequests('campaign', {
      state: JSON.parse(JSON.stringify(state)),
    });
    assert.equal(contextCalls, 0);
    assert.equal(failures, 1);
    assert.deepEqual(
      state.npcBrains.keeper.living.observations.map((o) => o.id),
      observationIds,
    );
    const live = { state };
    await game.scheduleRoundRequests('campaign', live);
    assert.equal(requests.length, split ? 1 : 0);
    assert.equal(rosters[0].roster.length, split ? 1 : 0);
    // Exercise the production terminal-marker drain without any paid work remaining.
    game.reconcileWorldOrphans =
      game.scheduleAutonomousRequests =
      game.processDecisionRequests =
        async () => {};
    game.db.query = async (sql) => {
      if (sql.includes('SELECT r.id FROM game_npc_decision_requests')) return [{ id: request.id }];
      if (sql.startsWith('SELECT roster')) return [{ roster: [] }];
      return [];
    };
    game.persist = async (id, current, next) => {
      current.state = next;
    };
    await game.advanceTurnWorld('campaign', live);
    assert.equal(live.state.turnController.phase, 'player');
    assert.equal(live.state.turnController.deferredSpeech.length, 0);
    assert.equal(contextCalls, 0);
  }
});

test('existing commitments remain context and never skip an active round decision', async () => {
  for (const intent of ['plan', 'public-plan', 'obligation']) {
    const { game, requests, rosters } = service();
    const live = { state: world(1) };
    const brain = live.state.npcBrains.keeper;
    if (intent === 'obligation')
      brain.living.obligations = [
        {
          id: 'promise',
          toActorId: 'alice',
          createdTick: live.state.tick,
          dueTick: live.state.tick + 100,
          status: 'accepted',
          evidenceIds: [],
          promisedAction: { kind: 'inspect', targetId: 'key' },
          conditions: [],
        },
      ];
    else {
      brain.plan = [{ kind: 'move_to', target: { x: 3, y: 6 } }];
      brain.planMapId = live.state.entities.keeper.mapId;
      brain.movementGeneration = live.state.entities.keeper.movementGeneration ?? 0;
      if (intent === 'public-plan') {
        brain.planSource = { actorId: 'alice', sourceObservationId: 'accepted-source' };
        brain.living.observations.push({
          id: 'accepted-source',
          eventId: 'source',
          rootId: 'source',
          kind: 'said',
          tick: live.state.tick,
          mapId: live.state.entities.keeper.mapId,
          channel: 'report',
          confidence: 'reported',
          actorId: 'alice',
          depth: 0,
          disclosure: 'public',
          audienceIds: ['alice', 'keeper'],
          text: 'Please come here.',
        });
      }
    }
    await game.scheduleRoundRequests('campaign', live);
    assert.equal(requests[0].status, 'queued', intent);
    assert.equal(rosters[0].roster[0].consideration, 'plan', intent);
    const completed = structuredClone(live.state);
    completed.npcBrains.keeper.living.lastActionOutcome = {
      actionKind: 'move_to',
      status: 'progressed',
      tick: completed.tick + 1,
      roundId: completed.turnController.roundId,
    };
    completed.tick++;
    completed.turnController.roundNumber++;
    completed.turnController.roundId = 'round-2';
    delete completed.turnController.worldActorIds;
    const next = service();
    await next.game.scheduleRoundRequests('campaign', { state: completed });
    assert.equal(next.requests[0].status, 'queued', `${intent} reconsiders after first action`);
  }
});

test('repeated empty same-tick rounds and renewed commitments each get model decisions', async () => {
  const live = { state: world(1) };
  const brain = live.state.npcBrains.keeper;
  brain.plan = [{ kind: 'move_to', target: { x: 3, y: 6 } }];
  brain.planSource = { actorId: 'alice', sourceObservationId: 'source-a' };
  brain.living.observations.push({
    id: 'source-a',
    eventId: 'a',
    rootId: 'a',
    kind: 'said',
    tick: live.state.tick,
    mapId: 'observatory',
    channel: 'report',
    confidence: 'reported',
    actorId: 'alice',
    depth: 0,
    disclosure: 'public',
    audienceIds: ['alice', 'keeper'],
    text: 'Come here.',
  });
  const initial = service();
  await initial.game.scheduleRoundRequests('campaign', live);
  assert.equal(initial.requests[0].status, 'queued');
  // Round advancement is not a tick advance, and serialization retains the consumed opportunity.
  live.state = JSON.parse(JSON.stringify(live.state));
  live.state.turnController.roundNumber = 2;
  live.state.turnController.roundId = 'round-2';
  delete live.state.turnController.worldActorIds;
  const sameTick = service();
  await sameTick.game.scheduleRoundRequests('campaign', live);
  assert.equal(sameTick.requests[0].status, 'queued');
  live.state.npcBrains.keeper.living.lastActionOutcome = {
    actionKind: 'move_to',
    status: 'blocked',
    tick: live.state.tick,
    roundId: 'round-2',
  };
  live.state.turnController.roundNumber = 3;
  live.state.turnController.roundId = 'round-3';
  delete live.state.turnController.worldActorIds;
  const renewedBrain = live.state.npcBrains.keeper;
  renewedBrain.planSource.sourceObservationId = 'source-b';
  renewedBrain.generation++;
  renewedBrain.living.observations.push({
    ...renewedBrain.living.observations.find((o) => o.id === 'source-a'),
    id: 'source-b',
    eventId: 'b',
    rootId: 'b',
    text: 'Try the other way.',
  });
  const renewed = service();
  await renewed.game.scheduleRoundRequests('campaign', live);
  assert.equal(renewed.requests[0].status, 'queued');
});

test('a busy earlier reply blocks later NPC replies without blocking private round decisions', async () => {
  const state = world(2);
  const replies = [
    { id: 'second', sequence: 2 },
    { id: 'third', sequence: 3 },
    { id: 'first', sequence: 1 },
  ];
  state.turnController.deferredSpeech = replies;
  const game = Object.create(GameService.prototype);
  const visited = [];
  game.reconcileIntents = async () => {};
  game.db = {
    query: async (sql) => {
      if (
        sql.startsWith('SELECT 1 FROM game_npc_decision_requests') ||
        sql.startsWith('SELECT npc_id FROM game_npc_decision_requests')
      )
        return [];
      assert.ok(sql.startsWith('SELECT * FROM game_npc_decision_requests'));
      return [
        {
          id: 'private-plan',
          npc_id: 'keeper',
          purpose: 'plan',
          context: { turnFence: g.turnFence(state) },
        },
        {
          id: 'second',
          npc_id: 'keeper',
          purpose: 'speech',
          context: { deferredSpeechId: 'second' },
        },
        { id: 'third', npc_id: 'npc-1', purpose: 'speech', context: { deferredSpeechId: 'third' } },
      ];
    },
  };
  game.story = {
    requireLegacyReplyConsent: async (_id, request) => {
      visited.push(request.id);
      return true;
    },
  };
  await game.processDecisionRequests('campaign', { state });
  assert.deepEqual(visited, ['private-plan']);
  // The prior scheduled request has committed or been safely terminally drained.
  state.turnController.deferredSpeech = replies.filter((entry) => entry.id !== 'first');
  visited.length = 0;
  await game.processDecisionRequests('campaign', { state });
  assert.deepEqual(visited, ['private-plan', 'second']);
  // Restarting with the same persisted markers must not admit the third early.
  visited.length = 0;
  await game.processDecisionRequests('campaign', { state: JSON.parse(JSON.stringify(state)) });
  assert.deepEqual(visited, ['private-plan', 'second']);
});

test('distant whisper intention is blocked without discarding valid cognition or the following player reply', async () => {
  const { state, game, runtime } = speechFixture();
  game.ai = { contextBudgetBytes: () => 64000 };
  const id = require('node:crypto').randomUUID();
  const posted = runtime.simulateTurnPost(
    state,
    'alice',
    {
      operationId: id,
      text: 'Mira, can you hear me?',
      channel: 'say',
      targetNpcId: 'keeper',
      expectedCanonRevision: 0,
      turnFence: g.turnFence(state),
    },
    id,
    'owner',
  );
  const speech = posted.requests.find((r) => r.npcId === 'keeper');
  const worldState = g.endPlayerTurn(posted.state, 'alice', g.turnFence(posted.state)).state;
  const speechContext = {
    ...game.deferredSpeechContext(worldState, speech),
    generationPolicy: 'world-batch-v1',
    worldPrepared: true,
  };
  const round = service();
  const live = { state: worldState };
  await round.game.scheduleRoundRequests('campaign', live);
  const request = round.requests.find((r) => r.npc_id === 'keeper');
  const thought = {
    motive: 'Speak quietly.',
    belief: 'The other NPC may know.',
    intent: 'Ask nearby.',
    innerThought: 'I should ask, if they can hear me.',
    reconsiderAfterRounds: 1,
  };
  const proposal = {
    ...g.createMockNpcPlan(live.state, 'keeper'),
    actions: [
      {
        kind: 'communicate',
        channel: 'whisper',
        targetId: 'six',
        observationIds: [speech.context.replyToObservationId],
      },
    ],
    targetRevisions: { six: live.state.entities.six.revision },
    cognition: thought,
    knowledgeRevision: live.state.npcBrains.keeper.living.knowledgeRevision,
  };
  assert.equal(g.acceptNpcPlan(live.state, 'keeper', proposal).error, 'TARGET_UNAVAILABLE');
  const considered = await game.evaluateDecision('campaign', live.state, {
    id: 'blocked-plan',
    npcId: 'keeper',
    purpose: 'plan',
    context: request.context,
    contextHash: request.context.contextHash,
    proposal,
  });
  assert.equal(considered.accepted, true);
  assert.equal(considered.decisionCode, 'NPC_INTENTION_BLOCKED:TARGET_UNAVAILABLE');
  assert.deepEqual(considered.next.npcBrains.keeper.plan, []);
  assert.equal(
    considered.next.npcBrains.keeper.living.cognition.innerThought,
    thought.innerThought,
  );
  assert.equal(considered.next.npcBrains.keeper.living.lastActionOutcome.status, 'blocked');
  assert.deepEqual(considered.next.npcUtterances, live.state.npcUtterances);
  assert.deepEqual(considered.next.entities, {
    ...live.state.entities,
    keeper: {
      ...live.state.entities.keeper,
      path: [],
      movementGeneration: (live.state.entities.keeper.movementGeneration ?? 0) + 1,
    },
  });
  const reply = await game.evaluateDecision('campaign', considered.next, {
    id: speech.id,
    npcId: 'keeper',
    purpose: 'speech',
    context: speechContext,
    contextHash: speechContext.contextHash,
    proposal: { text: 'Yes, I hear you.' },
  });
  assert.equal(reply.accepted, true);
  assert.equal(reply.next.npcUtterances.at(-1).text, 'Yes, I hear you.');
  assert.ok(reply.next.npcUtterances.at(-1).audienceIds.includes('alice'));
  assert.equal(reply.next.npcBrains.keeper.living.cognition.innerThought, thought.innerThought);
});

test('blocked-intention admission cannot bypass malformed cognition or stale round, entity, map, brain, deadline and knowledge fences', async () => {
  const { game, requests } = service();
  const live = { state: world(1) };
  await game.scheduleRoundRequests('campaign', live);
  const request = requests[0];
  const base = {
    ...g.createMockNpcPlan(live.state, 'keeper'),
    actions: [{ kind: 'give', targetId: 'alice', itemId: 'imaginary' }],
    targetRevisions: { alice: live.state.entities.alice.revision },
    cognition: {
      motive: 'Share.',
      belief: 'I can help.',
      intent: 'Give an item.',
      innerThought: 'Perhaps I can help.',
      reconsiderAfterRounds: 1,
    },
    knowledgeRevision: live.state.npcBrains.keeper.living.knowledgeRevision,
  };
  for (const mutate of [
    (p) => {
      p.cognition.innerThought = 'x'.repeat(481);
    },
    (p) => {
      p.turnFence.phaseEpoch++;
    },
    (p) => {
      p.entityRevision++;
    },
    (p) => {
      p.mapRevision++;
    },
    (p) => {
      p.brainGeneration++;
    },
    (p) => {
      p.deadlineTick = -1;
    },
    (p) => {
      p.knowledgeRevision++;
    },
    (p) => {
      delete p.turnFence;
    },
  ]) {
    const proposal = structuredClone(base);
    mutate(proposal);
    const evaluated = await game.evaluateDecision('campaign', live.state, {
      id: 'bad',
      npcId: 'keeper',
      purpose: 'plan',
      context: request.context,
      contextHash: request.context.contextHash,
      proposal,
    });
    assert.equal(evaluated.accepted, false);
    assert.deepEqual(evaluated.next, live.state);
  }
});

test('planner communication guidance exposes only adjacent recipients and actual prospective audiences', () => {
  const { state } = speechFixture();
  const context = g.buildNpcDecisionContext(state, 'keeper');
  assert.ok(context.communicationPolicy.adjacentRecipientIds.includes('alice'));
  assert.ok(!context.communicationPolicy.adjacentRecipientIds.includes('six'));
  assert.deepEqual(
    context.communicationPolicy.whisperAudienceIds,
    g.npcSpeechProspectiveListenerIds(state, 'keeper', 'whisper'),
  );
  assert.deepEqual(
    context.communicationPolicy.publicAudienceIds,
    g.npcSpeechProspectiveListenerIds(state, 'keeper', 'say'),
  );
});

test('blocked private communication never publishes the secret or applies an unsupported belief', async () => {
  const { game, requests } = service();
  const live = { state: world(1) };
  Object.assign(live.state.entities.alice, {
    mapId: live.state.entities.keeper.mapId,
    x: live.state.entities.keeper.x + 1,
    y: live.state.entities.keeper.y,
  });
  live.state.npcBrains.keeper.living.observations.push({
    id: 'private-source',
    eventId: 'private-source',
    rootId: 'private-source',
    kind: 'said',
    tick: live.state.tick,
    mapId: live.state.entities.keeper.mapId,
    channel: 'report',
    confidence: 'reported',
    actorId: 'alice',
    depth: 0,
    disclosure: 'private',
    audienceIds: ['keeper'],
    revealCondition: 'never',
    text: 'SECRET_NOT_FOR_PLAYER',
  });
  await game.scheduleRoundRequests('campaign', live);
  const request = requests[0];
  const proposal = {
    ...g.createMockNpcPlan(live.state, 'keeper'),
    actions: [
      {
        kind: 'communicate',
        targetId: 'alice',
        channel: 'whisper',
        observationIds: ['private-source'],
      },
    ],
    targetRevisions: { alice: live.state.entities.alice.revision },
    cognition: {
      motive: 'Consider a reply.',
      belief: 'I must keep the confidence.',
      intent: 'Remain quiet.',
      innerThought: 'I should not reveal this.',
      reconsiderAfterRounds: 1,
    },
    knowledgeRevision: live.state.npcBrains.keeper.living.knowledgeRevision,
  };
  const before = structuredClone(live.state);
  assert.equal(g.acceptNpcPlan(live.state, 'keeper', proposal).error, 'FORBIDDEN');
  const result = await game.evaluateDecision('campaign', live.state, {
    id: 'private-blocked',
    npcId: 'keeper',
    purpose: 'plan',
    context: request.context,
    contextHash: request.context.contextHash,
    proposal,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.decisionCode, 'NPC_INTENTION_BLOCKED:FORBIDDEN');
  assert.deepEqual(result.next.npcUtterances, before.npcUtterances);
  assert.deepEqual(
    result.next.npcBrains.keeper.living.beliefs,
    before.npcBrains.keeper.living.beliefs,
  );
  assert.deepEqual(
    result.next.npcBrains.keeper.living.observations,
    before.npcBrains.keeper.living.observations,
  );
  assert.ok(
    !JSON.stringify(g.projectState(result.next, 'alice')).includes('SECRET_NOT_FOR_PLAYER'),
  );
  assert.ok(
    !JSON.stringify(g.projectState(result.next, 'alice')).includes('I should not reveal this.'),
  );
});
