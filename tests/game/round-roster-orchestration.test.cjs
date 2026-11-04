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
test('continuing an admitted plan records free consideration without suppressing other NPCs', async () => {
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
  assert.equal(requests.find((r) => r.npc_id === 'keeper').status, 'fallback');
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
