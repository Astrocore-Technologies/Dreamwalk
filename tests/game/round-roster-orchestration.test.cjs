process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
const { GameService, roleplayExtrasRemainSafe } = require('../../apps/api/dist/game/game.service');
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
// Exercise the real local-post boundary before admitting a director-owned turn.
function commitRoleplayFixture(fixture, text, channel = 'say', options = {}) {
  const { state, runtime } = fixture;
  const id = require('node:crypto').randomUUID();
  const input = {
    operationId: id,
    text,
    channel,
    ...(options.targetNpcId ? { targetNpcId: options.targetNpcId } : {}),
    expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
    turnFence: g.turnFence(state),
  };
  const posted = runtime.simulateTurnPost(state, 'alice', input, id, 'owner');
  assert.deepEqual(posted.state.entities, state.entities, 'no physical effect at local post');
  for (const npcId of Object.keys(state.npcBrains))
    assert.deepEqual(
      posted.state.npcBrains[npcId].living.observations,
      state.npcBrains[npcId].living.observations,
      'pending intent/words are not admitted to live memory',
    );
  assert.equal(posted.state.npcUtterances?.length ?? 0, state.npcUtterances?.length ?? 0);
  assert.ok(posted.directorText);
  assert.ok(
    posted.entries
      .filter((entry) => entry.kind === 'attempt')
      .every((entry) => entry.audienceIds.length === 1 && entry.audienceIds[0] === 'alice'),
    'an unresolved attempt is provisional until its actual ordered audience is known',
  );
  const ready = g.endPlayerTurn(posted.state, 'alice', g.turnFence(posted.state)).state;
  const worldInput = { ...input, text: posted.directorText, turnFence: g.turnFence(ready) };
  const context = g.buildStoryTurnContext(ready, 'alice', worldInput, id);
  const voice = context.sceneSpeakers?.find((entry) => entry.npcId === options.replyNpcId);
  if (options.replyNpcId) assert.ok(voice, 'reply must have an admitted exact voice');
  const proposal = {
    turnId: id,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps: context.segments.map((segment) => ({
      segmentIndex: segment.index,
      action:
        context.actionPreview.find((entry) => entry.segmentIndex === segment.index)?.action ?? null,
      reply: voice?.segmentIndex === segment.index ? { text: 'A grounded answer.' } : null,
      ...(voice?.segmentIndex === segment.index
        ? { replyNpcId: voice.npcId, replyContextHash: voice.speechHash }
        : {}),
      ...(options.impact && options.impact.segmentIndex === segment.index
        ? { narrativeImpact: { targetId: options.impact.targetId, effect: options.impact.effect } }
        : {}),
    })),
    narrative: {
      narration: 'The scene continues without any unconfirmed mechanical change.',
      newScene: null,
      newNpc: null,
      evidenceIds: [],
    },
  };
  const applied = g.applyStoryTurnProposal(ready, 'alice', worldInput, id, proposal, {
    sourceSpeechSegments: g
      .parseStorySegments(input.text)
      .segments.filter((s) => s.kind === 'speech'),
  });
  assert.equal(applied.error, undefined);
  const { settlePendingStorySpeech } = require('../../apps/api/dist/game/pending-story-speech');
  const after = settlePendingStorySpeech(applied.state, id);
  const replay = g.applyStoryTurnProposal(after, 'alice', worldInput, id, proposal);
  assert.ok(replay.error, 'a committed source cannot be replayed');
  assert.deepEqual(replay.state, after);
  return { id, input, posted, context, proposal, applied, after };
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
  const fixture = speechFixture();
  const result = commitRoleplayFixture(fixture, '*Raises a hand!* Hello', 'say', {
    replyNpcId: 'keeper',
  });
  assert.deepEqual(result.posted.requests, [], 'the director owns the one reply');
  const spoken = result.applied.entries.find((entry) => entry.kind === 'speech');
  assert.deepEqual(spoken.audienceIds, ['alice', 'keeper', 'three']);
  for (const npcId of ['keeper', 'three', 'six', 'seven'])
    assert.equal(
      result.after.npcBrains[npcId].living.observations.some((o) => o.text === 'Hello'),
      ['keeper', 'three'].includes(npcId),
    );
  assert.equal(result.after.npcUtterances.filter((u) => u.text === 'Hello').length, 1);
  assert.equal(result.applied.entries.filter((entry) => entry.kind === 'npc_reply').length, 1);
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
    reconcileTerminalTravel: async () => {},
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
  for (const length of [481, 1400]) {
    const proposal = structuredClone(base);
    proposal.cognition.innerThought = 'x'.repeat(length);
    const evaluated = await game.evaluateDecision('campaign', live.state, {
      id: `bounded-thought-${length}`,
      npcId: 'keeper',
      purpose: 'plan',
      context: request.context,
      contextHash: request.context.contextHash,
      proposal,
    });
    assert.equal(evaluated.accepted, true);
    assert.match(evaluated.decisionCode, /^NPC_INTENTION_BLOCKED:/);
    assert.equal(
      evaluated.next.npcBrains.keeper.living.cognition.innerThought,
      proposal.cognition.innerThought,
    );
    assert.deepEqual(evaluated.next.npcUtterances, live.state.npcUtterances);
  }
  for (const mutate of [
    (p) => {
      p.cognition.innerThought = 'x'.repeat(1401);
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

test('modern area speech ignores stale selected-recipient metadata and never forces one NPC to reply', () => {
  for (const targetNpcId of ['missing-old-selection', 'seven', 'keeper']) {
    const { state, runtime } = speechFixture(),
      id = require('node:crypto').randomUUID();
    const posted = runtime.simulateTurnPost(
      state,
      'alice',
      {
        operationId: id,
        text: 'Hello',
        channel: 'say',
        targetNpcId,
        expectedCanonRevision: 0,
        turnFence: g.turnFence(state),
      },
      id,
      'owner',
    );
    assert.deepEqual(posted.requests.map((request) => request.npcId).sort(), ['keeper', 'three']);
    assert.ok(posted.requests.every((request) => request.context.responseOptional));
    assert.ok(
      posted.state.npcBrains.keeper.living.observations
        .filter((observation) => observation.text === 'Hello')
        .every((observation) => observation.addressedNpcId === undefined),
    );
  }
});

test('targetless emote-only posts admit visible observers without mechanical changes', () => {
  const fixture = speechFixture();
  const text = 'Smiles gently and adjusts a scarf';
  const result = commitRoleplayFixture(fixture, `*${text}*`);
  assert.deepEqual(result.after.entities, fixture.state.entities);
  assert.deepEqual(result.applied.actions, []);
  assert.deepEqual(result.posted.requests, [], 'no second reply owner for an emote');
  const entry = result.applied.entries.find((entry) => entry.kind === 'attempt');
  assert.ok(entry.sourceId);
  assert.deepEqual(entry.audienceIds, ['alice', 'keeper', 'seven', 'six', 'three']);
  for (const npcId of ['keeper', 'seven', 'six', 'three']) {
    const observations = result.after.npcBrains[npcId].living.observations.filter(
      (o) => o.text === text,
    );
    assert.equal(observations.length, 1);
    const observation = observations[0];
    assert.equal(observation.kind, 'attempted');
    assert.equal(observation.confidence, 'reported');
    assert.deepEqual(observation.speechIdentity, { turnId: result.id, segmentIndex: 0 });
    assert.equal(
      g.npcReplyObservation(result.after, 'alice', npcId, observation.id)?.id,
      observation.id,
    );
  }
  assert.equal(result.after.npcUtterances.filter((u) => u.id === entry.sourceId).length, 1);
});

test('a whispered emote cannot disclose private contents to distant visible NPCs', () => {
  for (const targetNpcId of [undefined, 'keeper']) {
    const fixture = speechFixture();
    fixture.state.entities.bob = {
      ...structuredClone(fixture.state.entities.alice),
      id: 'bob',
      x: 5,
      y: 6,
    };
    const text = 'Shows a secret note';
    const result = commitRoleplayFixture(fixture, `*${text}*`, 'whisper', { targetNpcId });
    const audience = targetNpcId ? ['alice', 'keeper'] : ['alice'];
    assert.deepEqual(result.posted.requests, []);
    assert.deepEqual(
      result.applied.entries.find((e) => e.kind === 'attempt').audienceIds,
      audience,
    );
    assert.deepEqual(result.after.npcUtterances.at(-1).audienceIds, audience);
    assert.deepEqual(result.after.narrativeCanon.turns.at(-1).audienceIds, audience);
    for (const npcId of ['keeper', 'three', 'six', 'seven'])
      assert.equal(
        result.after.npcBrains[npcId].living.observations.some((o) => o.text === text),
        npcId === targetNpcId,
      );
    assert.equal(JSON.stringify(g.projectState(result.after, 'bob')).includes(text), false);
  }
});

test('mixed roleplay is observed separately from sound and adds no duplicate reply jobs', () => {
  const fixture = speechFixture();
  const { state } = fixture;
  state.entities.hidden = { ...structuredClone(state.entities.keeper), id: 'hidden', x: 7, y: 6 };
  state.npcBrains.hidden = structuredClone(state.npcBrains.keeper);
  state.maps.courtyard.blocked.push({ x: 6, y: 5 });
  Object.assign(state.entities.keeper, { x: 5, y: 4 });
  Object.assign(state.entities.three, { x: 5, y: 8 });
  assert.equal(g.visible(state, state.entities.hidden, state.entities.alice), false);
  assert.equal(g.canNpcHear(state, state.entities.hidden, state.entities.alice, 3), true);
  const result = commitRoleplayFixture(fixture, '*Smiles gently* Hello', 'say', {
    replyNpcId: 'keeper',
  });
  assert.deepEqual(result.posted.requests, []);
  assert.deepEqual(result.applied.entries.find((e) => e.kind === 'speech').audienceIds, [
    'alice',
    'hidden',
    'keeper',
    'three',
  ]);
  assert.equal(
    result.after.npcBrains.hidden.living.observations.some((o) => o.text === 'Smiles gently'),
    false,
  );
  assert.equal(
    result.after.npcBrains.hidden.living.observations.filter((o) => o.text === 'Hello').length,
    1,
  );
  assert.equal(
    result.applied.entries.find((e) => e.kind === 'attempt').audienceIds.includes('hidden'),
    false,
  );
  const keeper = result.context.sceneSpeakers.find((voice) => voice.npcId === 'keeper');
  const claim = keeper.claims.find((claim) => claim.untrustedAttempt === 'Smiles gently');
  assert.ok(claim, 'exact safe voice can remember the visible descriptive intent');
  assert.equal(claim.kind, 'attempted');
  assert.equal(result.applied.entries.filter((entry) => entry.kind === 'npc_reply').length, 1);
  assert.equal(result.after.npcUtterances.filter((u) => u.text === 'Smiles gently').length, 1);
  assert.equal(result.after.npcUtterances.filter((u) => u.text === 'Hello').length, 1);
});

test('deferred roleplay extras cannot bypass the complete outgoing audience disclosure check', () => {
  const fixture = speechFixture();
  const { game } = fixture;
  const result = commitRoleplayFixture(fixture, '*Smiles secretly*', 'whisper', {
    targetNpcId: 'keeper',
  });
  const nextRound = g.finishWorldPhase(result.after, g.turnFence(result.after));
  assert.equal(nextRound.error, undefined);
  const spoken = game.prepareAreaTurnSpeech(
    nextRound.state,
    'alice',
    { channel: 'whisper', text: 'Hello' },
    'owner',
    { turnId: require('node:crypto').randomUUID(), segmentIndex: 0 },
  );
  const request = spoken.requests.find((r) => r.npcId === 'keeper');
  const attempt = spoken.state.npcBrains.keeper.living.observations.find(
    (o) => o.text === 'Smiles secretly',
  );
  // Historical/scoped roleplay extras must retain their independently admitted source.
  request.context.untrustedRoleplay = [
    {
      actorId: 'alice',
      segmentIndex: 0,
      text: attempt.text,
      observationId: attempt.id,
      verified: false,
    },
  ];
  game.ai = { contextBudgetBytes: () => 64000 };
  const worldState = g.endPlayerTurn(spoken.state, 'alice', g.turnFence(spoken.state)).state;
  const original = game.deferredSpeechContext(worldState, request);
  assert.equal(original.untrustedRoleplay.length, 1, 'safe complete audience retains the source');
  worldState.entities.bob = {
    ...structuredClone(worldState.entities.alice),
    id: 'bob',
    x: 7,
    y: 5,
  };
  // Only the second source has the broader audience. Permission for the first cannot grow.
  worldState.npcBrains.keeper.living.observations
    .find((o) => o.id === request.context.replyToObservationId)
    .audienceIds.push('bob');
  const current = game.deferredSpeechContext(worldState, request);
  assert.ok(current.audienceIds.includes('bob'));
  assert.equal(current.untrustedRoleplay, undefined);
  assert.equal(JSON.stringify(current).includes('Smiles secretly'), false);
  assert.equal(roleplayExtrasRemainSafe(request.context, current), false);
});

test('ordered descriptive sources exclude incapacitated witnesses and retain attempt provenance', () => {
  const fixture = speechFixture();
  const result = commitRoleplayFixture(
    fixture,
    '*I strike at the keeper* *Adjusts a scarf*',
    'say',
    {
      impact: { segmentIndex: 0, targetId: 'keeper', effect: 'death' },
    },
  );
  const keeper = result.after.npcBrains.keeper.living.observations;
  assert.equal(
    keeper.some((o) => o.text === 'Adjusts a scarf'),
    false,
  );
  assert.equal(result.after.entities.keeper.lifeState, 'dead');
  const seen = result.after.npcBrains.three.living.observations.filter(
    (o) => o.text === 'Adjusts a scarf',
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'attempted');
  assert.equal(seen[0].confidence, 'reported');
  assert.equal(
    result.applied.entries.filter((e) => e.kind === 'attempt')[1].audienceIds.includes('keeper'),
    false,
  );
  assert.equal(result.after.npcUtterances.filter((u) => u.text === 'Adjusts a scarf').length, 1);
});

test('conditional revival voice cannot borrow a future private gesture as present knowledge', () => {
  const fixture = speechFixture();
  Object.assign(fixture.state.entities.keeper, { lifeState: 'dead', lifeRevision: 2, vitality: 0 });
  fixture.state = g.endPlayerTurn(fixture.state, 'alice', g.turnFence(fixture.state)).state;
  const id = require('node:crypto').randomUUID();
  const input = {
    operationId: id,
    text: '*I revive the keeper* *Shows PRIVATE_FUTURE_NOTE* Hello',
    channel: 'whisper',
    targetNpcId: 'keeper',
    expectedCanonRevision: 0,
    turnFence: g.turnFence(fixture.state),
  };
  const context = g.buildStoryTurnContext(fixture.state, 'alice', input, id);
  assert.ok(context.sceneSpeakerImpactVariants.length);
  for (const voice of [...context.sceneSpeakers, ...context.sceneSpeakerImpactBases])
    assert.equal(JSON.stringify(voice.claims).includes('PRIVATE_FUTURE_NOTE'), false);
  for (const variant of context.sceneSpeakerImpactVariants)
    assert.equal(JSON.stringify(variant.replacedClaims).includes('PRIVATE_FUTURE_NOTE'), false);
});

test('attempt source retry preserves its original audience rather than newly arrived witnesses', () => {
  const { admitStoryRoleplayAttempt } = require('../../packages/game-core/dist/story-roleplay');
  const fixture = speechFixture();
  const id = require('node:crypto').randomUUID();
  const input = {
    operationId: id,
    text: '*Smiles gently*',
    channel: 'say',
    expectedCanonRevision: 0,
  };
  const segment = g.parseStorySegments(input.text).segments[0];
  const admitted = admitStoryRoleplayAttempt(fixture.state, 'alice', input, id, segment);
  assert.equal(admitted.error, undefined);
  const arrived = structuredClone(admitted.state);
  arrived.entities.arrival = { ...structuredClone(arrived.entities.keeper), id: 'arrival' };
  arrived.npcBrains.arrival = structuredClone(fixture.state.npcBrains.keeper);
  const repeated = admitStoryRoleplayAttempt(arrived, 'alice', input, id, segment);
  assert.deepEqual(repeated.state, arrived);
  assert.deepEqual(repeated.events, []);
  assert.deepEqual(repeated.source, admitted.source);
  assert.equal(repeated.source.audienceIds.includes('arrival'), false);
  assert.equal(repeated.state.npcUtterances.filter((u) => u.id === admitted.source.id).length, 1);
});

test('pending public words wait for ordered travel before admitting actual hearers', () => {
  const fixture = speechFixture();
  fixture.state.maps.annex = {
    ...structuredClone(fixture.state.maps.courtyard),
    id: 'annex',
    label: 'Annex',
    spawns: [{ x: 5, y: 5 }],
    exits: [],
  };
  fixture.state.entities.destination = {
    ...structuredClone(fixture.state.entities.keeper),
    id: 'destination',
    mapId: 'annex',
    x: 6,
    y: 5,
  };
  fixture.state.npcBrains.destination = structuredClone(fixture.state.npcBrains.keeper);
  fixture.state.entities.guest = {
    ...structuredClone(fixture.state.entities.alice),
    id: 'guest',
    x: 5,
    y: 6,
  };
  const result = commitRoleplayFixture(
    fixture,
    '*go to Annex* *Smiles at the new room* WORDS_AT_DESTINATION',
    'say',
    { replyNpcId: 'destination' },
  );
  for (const entry of result.posted.entries) assert.deepEqual(entry.audienceIds, ['alice']);
  const spoken = result.applied.entries.find((entry) => entry.kind === 'speech');
  assert.deepEqual(spoken.audienceIds, ['alice', 'destination']);
  assert.equal(result.after.entities.alice.mapId, 'annex');
  for (const npcId of ['keeper', 'three', 'six', 'seven'])
    assert.equal(
      result.after.npcBrains[npcId].living.observations.some(
        (o) => o.text === 'WORDS_AT_DESTINATION' || o.text === 'Smiles at the new room',
      ),
      false,
    );
  assert.equal(
    result.after.npcBrains.destination.living.observations.filter(
      (o) => o.text === 'WORDS_AT_DESTINATION',
    ).length,
    1,
  );
  assert.deepEqual(
    result.applied.entries.find((entry) => entry.text === 'Smiles at the new room').audienceIds,
    ['alice', 'destination'],
  );
  assert.equal(result.applied.entries.filter((entry) => entry.kind === 'npc_reply').length, 1);
});

function releaseCommunicationFixture(targetId = 'npc-1', channel = 'say') {
  let state = world(2);
  const npc = state.entities.keeper;
  Object.assign(state.entities.alice, { mapId: npc.mapId, x: npc.x, y: npc.y + 1 });
  Object.assign(state.entities['npc-1'], { mapId: npc.mapId, x: npc.x + 1, y: npc.y });
  const heard = g.applyNpcSpeech(
    state,
    'alice',
    'keeper',
    {
      channel: 'say',
      text: 'Расскажи о городе.',
    },
    { suppressReply: true },
  );
  assert.equal(heard.error, undefined);
  state = heard.state;
  const observation = state.npcBrains.keeper.living.observations.find(
    (item) =>
      item.actorId === 'alice' && item.kind === 'said' && item.text === 'Расскажи о городе.',
  );
  assert.ok(observation);
  const action = { kind: 'communicate', targetId, channel, observationIds: [observation.id] };
  const accepted = g.acceptNpcPlan(state, 'keeper', {
    ...g.createMockNpcPlan(state, 'keeper'),
    actions: [action],
    targetRevisions: { [targetId]: state.entities[targetId].revision },
  });
  assert.equal(accepted.error, undefined);
  state = accepted.state;
  const game = Object.create(GameService.prototype),
    replies = [],
    requests = [];
  const parentId = 'ac1b17e0-86cb-4c89-a4f3-9223f4c96072';
  game.ai = { releaseGeneration: () => true, contextBudgetBytes: () => 64000 };
  game.db = {
    query: async (sql) => {
      if (sql.startsWith('SELECT r.status,r.result_code')) return requests;
      if (sql.startsWith('SELECT context,proposal FROM npc_ai_jobs')) return replies;
      if (sql.startsWith('SELECT r.id FROM game_npc_decision_requests r JOIN npc_ai_jobs'))
        return [{ id: parentId }];
      if (sql.startsWith('SELECT COALESCE((SELECT r.context')) return [{ reply_locale: 'ru' }];
      throw new Error(sql);
    },
  };
  return { game, state, action, replies, requests, parentId };
}
function commitReleaseFixtureReply(fixture, recipientId, channel = 'say') {
  const { game, state, action } = fixture;
  const context = game.speechContext(
    state,
    'keeper',
    recipientId,
    channel,
    action.observationIds,
    undefined,
    undefined,
    undefined,
    'ru',
  );
  const proposal = { text: 'По вечерам здесь собираются путешественники.' };
  const spoken = g.commitNpcPublicUtterance(state, 'keeper', {
    ...proposal,
    channel,
    recipientId,
    observationIds: action.observationIds,
    contextHash: context.speechHash,
    replyLocale: 'ru',
  });
  assert.equal(spoken.error, undefined);
  fixture.state = spoken.state;
  fixture.replies.push({ context, proposal });
}

test('release world communication queues exact speech consent without fixture speech or reported knowledge', async () => {
  const f = releaseCommunicationFixture();
  commitReleaseFixtureReply(f, 'alice');
  const before = structuredClone(f.state);
  const pending = await f.game.prepareWorldPlanCommunication('campaign', f.state, 'keeper');
  assert.equal(pending.pending, true);
  assert.equal(pending.request.purpose, 'speech');
  assert.equal(pending.request.context.recipientId, 'npc-1');
  assert.equal(pending.request.context.replyLocale, 'ru');
  assert.equal(pending.request.context.worldPlanCommunication.sourceRequestId, f.parentId);
  assert.equal(pending.request.context.worldPrepared, true);
  assert.equal(pending.request.context.generationPolicy, 'world-batch-v1');
  assert.equal(pending.request.context.mockProposal, undefined);
  assert.equal(pending.request.context.runtimeMapImage, undefined);
  assert.deepEqual(pending.state.npcUtterances, before.npcUtterances);
  assert.deepEqual(pending.state.npcBrains['npc-1'].living, before.npcBrains['npc-1'].living);
  assert.equal(pending.state.npcBrains.keeper.cursor, before.npcBrains.keeper.cursor);
  assert.equal(pending.state.npcBrains.keeper.living.lastActionOutcome.status, 'blocked');
  const replay = await f.game.prepareWorldPlanCommunication(
    'campaign',
    JSON.parse(JSON.stringify(before)),
    'keeper',
  );
  assert.equal(
    replay.request.id,
    pending.request.id,
    'restore preserves the exact request identity',
  );
  f.requests.push({ status: 'queued' });
  const waiting = await f.game.prepareWorldPlanCommunication('campaign', pending.state, 'keeper');
  assert.equal(waiting.pending, true);
  assert.equal(waiting.request, undefined, 'no second request while waiting for consent');
});

test('release communication dedupes only the exact committed same-round speech intent', async () => {
  const exact = releaseCommunicationFixture('alice');
  commitReleaseFixtureReply(exact, 'alice');
  const before = exact.state.npcUtterances.length;
  const delivered = await exact.game.prepareWorldPlanCommunication(
    'campaign',
    exact.state,
    'keeper',
  );
  assert.equal(delivered.request, undefined);
  assert.equal(delivered.pending, undefined);
  assert.equal(delivered.state.npcUtterances.length, before);
  assert.equal(delivered.state.npcBrains.keeper.cursor, 1);
  assert.equal(delivered.state.npcBrains.keeper.living.lastActionOutcome.status, 'completed');
  assert.equal(delivered.state.turnController.worldNpcActions.keeper, 1);
  const otherChannel = releaseCommunicationFixture('alice', 'whisper');
  commitReleaseFixtureReply(otherChannel, 'alice', 'say');
  const different = await otherChannel.game.prepareWorldPlanCommunication(
    'campaign',
    otherChannel.state,
    'keeper',
  );
  assert.ok(different.request, 'public reply does not satisfy a whisper intent');
});

test('admitted real NPC-to-NPC speech commits once with action budget and report provenance', async () => {
  const f = releaseCommunicationFixture();
  const prepared = await f.game.prepareWorldPlanCommunication('campaign', f.state, 'keeper');
  const request = prepared.request;
  const before = prepared.state.npcUtterances.length;
  const job = {
    id: request.id,
    npcId: request.npcId,
    purpose: 'speech',
    context: request.context,
    contextHash: request.context.contextHash,
    proposal: { text: 'Борис, путешественник спрашивает о городе.' },
  };
  const result = await f.game.evaluateDecision('campaign', prepared.state, job);
  assert.equal(result.accepted, true);
  assert.equal(result.next.npcUtterances.length, before + 1);
  assert.equal(result.next.npcUtterances.at(-1).text, job.proposal.text);
  assert.equal(result.next.npcBrains.keeper.cursor, 1);
  assert.equal(result.next.turnController.worldNpcActions.keeper, 1);
  assert.equal(result.next.npcBrains.keeper.living.lastActionOutcome.status, 'completed');
  assert.ok(
    result.next.npcBrains['npc-1'].living.observations.some(
      (item) =>
        item.channel === 'report' &&
        item.sourceNpcId === 'keeper' &&
        item.confidence === 'reported',
    ),
  );
  const replay = await f.game.evaluateDecision(
    'campaign',
    JSON.parse(JSON.stringify(result.next)),
    job,
  );
  assert.equal(replay.accepted, false);
  assert.deepEqual(replay.next, JSON.parse(JSON.stringify(result.next)));
});

test('stale and declined real communication never substitutes fixture text or propagates a report', async () => {
  const f = releaseCommunicationFixture();
  const prepared = await f.game.prepareWorldPlanCommunication('campaign', f.state, 'keeper');
  const before = structuredClone(prepared.state);
  prepared.state.entities['npc-1'].x += 8;
  const request = prepared.request;
  const stale = await f.game.evaluateDecision('campaign', prepared.state, {
    id: request.id,
    npcId: 'keeper',
    purpose: 'speech',
    context: request.context,
    contextHash: request.context.contextHash,
    proposal: { text: 'Это настоящая реплика.' },
  });
  assert.equal(stale.accepted, false);
  assert.deepEqual(stale.next.npcUtterances, before.npcUtterances);
  f.requests.push({ status: 'cancelled', result_code: 'USER_DECLINED' });
  const declined = await f.game.prepareWorldPlanCommunication('campaign', before, 'keeper');
  assert.equal(declined.pending, undefined);
  assert.equal(declined.request, undefined);
  assert.deepEqual(declined.state.npcUtterances, before.npcUtterances);
  assert.deepEqual(declined.state.npcBrains.keeper.plan, []);
  assert.equal(declined.state.npcBrains.keeper.living.lastActionOutcome.code, 'USER_DECLINED');
});

for (const noOpMoves of [0, 1, 2])
  test(`release world completion intercepts communication after ${noOpMoves} no-op moves without fixture speech`, async () => {
    const f = releaseCommunicationFixture();
    commitReleaseFixtureReply(f, 'alice');
    const keeper = f.state.entities.keeper;
    f.state.npcBrains.keeper.plan.unshift(
      ...Array.from({ length: noOpMoves }, () => ({
        kind: 'move_to',
        target: { x: keeper.x, y: keeper.y },
      })),
    );
    const originalQuery = f.game.db.query;
    let queued = null;
    const kinds = [];
    f.game.db.query = async (sql, values) => {
      if (sql.startsWith('UPDATE game_npc_decision_requests r SET')) return [];
      if (sql.startsWith('SELECT 1 FROM game_npc_decision_requests r LEFT JOIN'))
        return queued ? [{}] : [];
      if (sql.startsWith('SELECT roster FROM game_world_round_rosters'))
        return [{ roster: [{ npcId: 'keeper', consideration: 'plan' }] }];
      return originalQuery(sql, values);
    };
    f.game.reconcileWorldOrphans = async () => {};
    f.game.scheduleAutonomousRequests = async () => {};
    f.game.processDecisionRequests = async () => {};
    f.game.persist = async (id, live, state, kind, operation, extra) => {
      kinds.push(kind);
      if (extra)
        await extra({
          query: async (sql, values) => {
            if (sql.startsWith('INSERT INTO game_npc_decision_requests'))
              queued = { id: values[0], npcId: values[2], context: JSON.parse(values[7]) };
            return { rows: [], rowCount: 1 };
          },
        });
      live.state = state;
    };
    const live = { state: f.state };
    const utterances = structuredClone(f.state.npcUtterances);
    await f.game.advanceTurnWorld('campaign', live);
    assert.ok(queued);
    assert.equal(queued.context.worldPlanCommunication.cursor, noOpMoves);
    assert.equal(live.state.turnController.phase, 'world');
    assert.deepEqual(live.state.npcUtterances, utterances);
    assert.deepEqual(kinds, ['npc.communication.requested']);
    live.state = JSON.parse(JSON.stringify(live.state));
    await f.game.advanceTurnWorld('campaign', live);
    assert.deepEqual(kinds, ['npc.communication.requested']);
    assert.deepEqual(live.state.npcUtterances, JSON.parse(JSON.stringify(utterances)));
    const generated = await f.game.evaluateDecision('campaign', live.state, {
      id: queued.id,
      npcId: queued.npcId,
      purpose: 'speech',
      context: queued.context,
      contextHash: queued.context.contextHash,
      proposal: { text: 'Борис, расскажи гостю о городе.' },
    });
    assert.equal(generated.accepted, true);
    assert.equal(generated.next.npcBrains.keeper.cursor, noOpMoves + 1);
    live.state = generated.next;
    queued = null;
    await f.game.advanceTurnWorld('campaign', live);
    assert.equal(live.state.turnController.phase, 'player');
    assert.equal(live.state.npcUtterances.length, utterances.length + 1);
    assert.equal(live.state.npcUtterances.at(-1).text, 'Борис, расскажи гостю о городе.');
    assert.equal(kinds.at(-1), 'turn.world.completed');
  });

test('real communication rejects extra executable speech intents instead of claiming unsupported actions', async () => {
  const f = releaseCommunicationFixture();
  const prepared = await f.game.prepareWorldPlanCommunication('campaign', f.state, 'keeper');
  const request = prepared.request;
  const result = await f.game.evaluateDecision('campaign', prepared.state, {
    id: request.id,
    npcId: 'keeper',
    purpose: 'speech',
    context: request.context,
    contextHash: request.context.contextHash,
    proposal: { text: 'Сейчас подойду.', actionIntent: { actions: [{ kind: 'wait' }] } },
  });
  assert.equal(result.accepted, false);
  assert.deepEqual(result.next, prepared.state);
});

test('real communication remains available in an admitted location-only scene without invented coordinates', async () => {
  const f = releaseCommunicationFixture();
  const map = f.state.maps[f.state.entities.keeper.mapId];
  map.spatialMode = 'location_only';
  map.scenePresence = {
    entrySceneId: 'room',
    scenes: [{ id: 'room', label: 'Room', participantIds: [] }],
  };
  for (const entity of Object.values(f.state.entities).filter(
    (entity) => entity.mapId === map.id,
  )) {
    entity.spatialMode = 'location_only';
    entity.sceneId = 'room';
    delete entity.x;
    delete entity.y;
    if (!entity.ownerId) map.scenePresence.scenes[0].participantIds.push(entity.id);
  }
  const prepared = await f.game.prepareWorldPlanCommunication('campaign', f.state, 'keeper');
  assert.ok(prepared.request);
  const request = prepared.request;
  const result = await f.game.evaluateDecision('campaign', prepared.state, {
    id: request.id,
    npcId: 'keeper',
    purpose: 'speech',
    context: request.context,
    contextHash: request.context.contextHash,
    proposal: { text: 'Давай расскажем гостю об этом месте.' },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.next.npcUtterances.at(-1).text, 'Давай расскажем гостю об этом месте.');
  assert.equal(result.next.entities.keeper.x, undefined);
  assert.equal(result.next.npcBrains.keeper.cursor, 1);
});

test('first autonomous speech dispatch adopts only the exact bound request payer', async () => {
  for (const mismatch of [false, true]) {
    const f = releaseCommunicationFixture();
    const prepared = await f.game.prepareWorldPlanCommunication('campaign', f.state, 'keeper');
    const request = prepared.request;
    const ownerId = 'f5d00f79-1fdd-4ca2-9c06-8da53cdbebbe';
    const row = {
      id: request.id,
      npc_id: request.npcId,
      purpose: request.purpose,
      status: 'queued',
      cause_key: request.causeKey,
      context: request.context,
      requester_user_id: null,
    };
    const queued = [],
      failures = [];
    f.game.reconcileIntents = async () => {};
    f.game.story = {
      reconcileTerminalTravel: async () => {},
      requireLegacyReplyConsent: async () => false,
      quotedReply: async () => null,
    };
    f.game.worldGeneration = {
      quotedWorldRequest: async () => ({
        quote: { id: '939bc12c-0f48-4c47-bb1d-a53f4dd765ea' },
        batchId: '05d5f7a3-009c-48ce-8897-e8f2b8716a8f',
        request: {
          ...request,
          requesterUserId: ownerId,
          ...(mismatch ? { causeKey: 'different-request' } : {}),
        },
      }),
      failUnspent: async (...args) => failures.push(args),
    };
    f.game.ai = {
      ...f.game.ai,
      contextWindow: () => false,
      manualLive: () => true,
      configuration: () => ({ enabled: true, provider: 'release', creditPrice: 0 }),
      queue: async (input) => {
        queued.push(input);
        assert.equal(input.requesterUserId, ownerId);
        assert.equal(input.scope.requesterUserId, ownerId);
        assert.equal(input.scope.origin, 'user');
        return { id: 'bc528724-fe3d-4af7-95d4-6003e7751994' };
      },
    };
    f.game.db.query = async (sql) =>
      sql.startsWith('SELECT * FROM game_npc_decision_requests') ? [structuredClone(row)] : [];
    f.game.dispatchAi = () => {};
    await f.game.processDecisionRequests('campaign', { state: prepared.state });
    assert.equal(queued.length, mismatch ? 0 : 1);
    assert.equal(failures.length, mismatch ? 1 : 0);
    if (mismatch) assert.equal(failures[0][2], 'WORLD_ADMISSION_FAILED');
    assert.equal(row.requester_user_id, null, 'the pre-bind row remains a stale read');
  }
});

test('autonomous paid speech has durable private-safe history beyond 128 later utterances and reload', async () => {
  const f = releaseCommunicationFixture('npc-1', 'whisper');
  const { StoryTurnRuntime } = require('../../apps/api/dist/game/story-turn-runtime');
  const runtime = Object.create(StoryTurnRuntime.prototype);
  const prepared = await f.game.prepareWorldPlanCommunication('campaign', f.state, 'keeper');
  const request = prepared.request;
  const job = {
    id: '679f39af-5b2d-4e9c-8a4e-c0c1844c50f6',
    npcId: 'keeper',
    purpose: 'speech',
    context: request.context,
    contextHash: request.context.contextHash,
    proposal: { text: 'PRIVATE_DURABLE_AUTONOMOUS_LINE' },
  };
  const delivered = await f.game.evaluateDecision('campaign', prepared.state, job);
  assert.equal(delivered.accepted, true);
  const utterance = delivered.next.npcUtterances.at(-1);
  assert.ok(utterance.audienceIds.includes('alice'));
  // Frozen emission-time recognition must win over the later currently-visible identity.
  utterance.speakerKnownToIds = utterance.speakerKnownToIds.filter((actor) => actor !== 'alice');
  const stored = [];
  let erased = false,
    nativeReads = 0;
  const client = {
    query: async (sql, values) => {
      if (sql.startsWith('SELECT r.id FROM npc_ai_jobs')) {
        nativeReads++;
        assert.match(sql, /j.status='committed'/);
        assert.match(sql, /j.context_hash<>'erased'/);
        assert.equal(values[0], job.id);
        return { rows: erased ? [] : [{ id: request.id }], rowCount: erased ? 0 : 1 };
      }
      assert.match(sql, /INSERT INTO game_story_feed/);
      assert.match(sql, /ON CONFLICT DO NOTHING/);
      assert.equal(values[7], job.id);
      assert.equal(values[8], request.id);
      if (!stored.some((row) => row.npc_job_id === values[7] || row.entry.sourceId === values[9]))
        stored.push({
          id: values[0],
          turn_id: null,
          campaign_id: values[1],
          sequence: values[2],
          ordinal: 0,
          tick: values[3],
          channel: values[4],
          audience_ids: [...values[5]],
          entry: JSON.parse(values[6]),
          npc_job_id: values[7],
          npc_request_id: values[8],
          created_at: new Date(),
        });
      return { rows: [], rowCount: 1 };
    },
  };
  await runtime.writeAutonomousReply(client, 'campaign', prepared.state, delivered.next, job, 42);
  await runtime.writeAutonomousReply(client, 'campaign', prepared.state, delivered.next, job, 42);
  assert.equal(stored.length, 1, 'same accepted job cannot duplicate its feed line');
  const reads = nativeReads;
  await runtime.writeAutonomousReply(client, 'campaign', delivered.next, delivered.next, job, 43);
  assert.equal(
    nativeReads,
    reads,
    'already delivered intent does not create another native operation',
  );
  assert.equal(stored[0].turn_id, null, 'never invents a player-authored turn');
  assert.equal(stored[0].channel, 'whisper');
  assert.deepEqual(stored[0].audience_ids, utterance.audienceIds);
  assert.deepEqual(stored[0].entry.speakerKnownToIds, utterance.speakerKnownToIds);
  let later = delivered.next;
  for (let index = 0; index < 130; index++) {
    const context = f.game.speechContext(
      later,
      'keeper',
      'alice',
      'say',
      [],
      undefined,
      undefined,
      undefined,
      'ru',
    );
    const next = g.commitNpcPublicUtterance(later, 'keeper', {
      text: `Later public line ${index}`,
      recipientId: 'alice',
      channel: 'say',
      observationIds: [],
      contextHash: context.speechHash,
      replyLocale: 'ru',
    });
    assert.equal(next.error, undefined);
    later = next.state;
  }
  assert.equal(later.npcUtterances.length, 128);
  assert.ok(!later.npcUtterances.some((entry) => entry.id === utterance.id));
  const restored = JSON.parse(JSON.stringify(later));
  restored.entities.outsider = { ...restored.entities.alice, id: 'outsider' };
  runtime.reconcile = async () => {};
  runtime.db = {
    query: async (sql, values) => {
      if (sql.startsWith('SELECT f.*')) {
        assert.match(sql, /LEFT JOIN npc_ai_jobs/);
        assert.match(sql, /j.context_hash<>'erased'/);
        assert.match(sql, /\$2=ANY\(f.audience_ids\)/);
        return erased
          ? []
          : stored
              .filter((row) => row.audience_ids.includes(values[1]))
              .map((row) => structuredClone(row));
      }
      return [];
    },
  };
  for (const viewer of ['alice', 'outsider']) {
    runtime.port = {
      serial: async (_id, run) => run(),
      access: async () => ({ actorId: viewer, user: { id: viewer } }),
      load: async () => ({ state: restored }),
    };
    const feed = await runtime.feed({}, 'campaign');
    const entry = feed.entries.find((item) => item.text === job.proposal.text);
    if (viewer === 'outsider') {
      assert.equal(entry, undefined);
      continue;
    }
    assert.ok(entry);
    assert.equal(entry.sequence, 42);
    assert.equal(entry.channel, 'whisper');
    assert.equal(entry.kind, 'npc_reply');
    for (const key of [
      'turnId',
      'authorId',
      'authorLabel',
      'speakerKnownToIds',
      'sourceId',
      'npc_job_id',
      'npc_request_id',
    ])
      assert.equal(key in entry, false, key);
    assert.equal(feed.entries.filter((item) => item.text === job.proposal.text).length, 1);
  }
  erased = true;
  await assert.rejects(
    runtime.writeAutonomousReply(client, 'campaign', prepared.state, delivered.next, job, 42),
    /STALE_STATE/,
  );
  assert.equal(stored.length, 1);
  runtime.port.access = async () => ({ actorId: 'alice', user: { id: 'alice' } });
  assert.ok(
    !(await runtime.feed({}, 'campaign')).entries.some((entry) => entry.text === job.proposal.text),
  );
});

test('accepted autonomous jobs pin a durable delivery identity rather than merging identical quoted words', async () => {
  const f = releaseCommunicationFixture('alice', 'say');
  const prepared = await f.game.prepareWorldPlanCommunication('campaign', f.state, 'keeper');
  const job = {
    id: '679f39af-5b2d-4e9c-8a4e-c0c1844c50f6',
    npcId: 'keeper',
    purpose: 'speech',
    context: prepared.request.context,
    contextHash: prepared.request.context.contextHash,
    proposal: { text: 'The same permitted words.' },
  };
  const first = await f.game.evaluateDecision('campaign', prepared.state, job);
  assert.equal(first.accepted, true);
  const old = first.next.npcUtterances.at(-1);
  // This unit exercises delivery after separate native admission, not permission to
  // issue another request. Hold the exact quoted public context fixed and retain an
  // earlier line, as is possible when a later plan selects the same permitted facts.
  const retained = structuredClone(prepared.state);
  retained.npcUtterances = structuredClone(first.next.npcUtterances);
  const later = await f.game.evaluateDecision('campaign', retained, {
    ...job,
    id: '80808762-8dfa-452f-8c51-3ea43f238890',
  });
  assert.equal(later.accepted, true);
  assert.equal(later.next.npcUtterances.length, retained.npcUtterances.length + 1);
  assert.notEqual(later.next.npcUtterances.at(-1).id, old.id);
  assert.equal(later.next.npcUtterances.at(-1).text, old.text);
  assert.ok(!JSON.stringify(g.projectState(later.next, 'alice')).includes(job.id));
});
