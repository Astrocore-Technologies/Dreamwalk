const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
function fixture(rules = {}) {
  const d = g.createAuthoredDraft('courtyard');
  d.turnRules = g.turnRulesSchema.parse(rules);
  const compiled = g.compilePlayableDraft(d);
  assert.deepEqual(compiled.errors, []);
  const s = g.createStateFromPlayable(compiled.playable, ['alice', 'bob'], 19);
  Object.assign(s.entities.alice, { x: 2, y: 3 });
  Object.assign(s.entities.bob, { x: 2, y: 4 });
  return s;
}
const fence = (s) => g.turnFence(s);
const advanceToWorld = (s) => {
  s = g.endPlayerTurn(s, 'alice', fence(s)).state;
  return g.endPlayerTurn(s, 'bob', fence(s)).state;
};

test('turn mode is explicit, versioned, strictly projected and does not silently reinterpret old paths', () => {
  const old = g.createObservatoryState(['alice']);
  assert.equal(old.turnController, undefined);
  const queued = g.moveInput(old, 'alice', {
    inputSeq: 1,
    movementGeneration: 0,
    target: { x: 4, y: 4 },
  });
  assert.equal(g.initializeTurnController(queued.state, ['alice']).error, 'WRONG_MODE');
  const state = fixture({ movement: 7 });
  assert.equal(state.turnController.ruleset.id, 'dreamwalk-base');
  assert.equal(state.turnController.ruleset.movement, 7);
  const view = g.projectState(state, 'alice');
  assert.equal(view.turn.ownTurn, true);
  assert.equal(view.turn.resources.movement, 7);
  assert.equal(g.gameProjectionSchema.safeParse(view).success, true);
  assert.equal(g.turnRulesSchema.safeParse({ movement: 100 }).success, false);
  assert.equal(g.turnRulesSchema.safeParse({ script: 'arbitrary executable code' }).success, false);
});

test('committed turn movement validates every step without a distance budget or foreign path leak', () => {
  const s = fixture({ movement: 6 });
  const result = g.applyTurnMove(s, 'alice', { x: 5, y: 3 }, fence(s));
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.alice.x, 5);
  assert.equal(result.state.turnController.resources.alice.movement, 6);
  assert.deepEqual(result.state.entities.alice.movementTrace.points, [
    { x: 2, y: 3 },
    { x: 3, y: 3 },
    { x: 4, y: 3 },
    { x: 5, y: 3 },
  ]);
  assert.equal(result.state.entities.alice.path, undefined);
  assert.equal(
    g.projectState(result.state, 'bob').entities.find((e) => e.id === 'alice').movementTrace,
    undefined,
  );
  const continued = g.applyTurnMove(result.state, 'alice', { x: 10, y: 3 }, fence(result.state));
  assert.equal(continued.error, undefined);
  assert.equal(continued.state.entities.alice.x, 10);
  const invalid = g.applyTurnMove(result.state, 'alice', { x: 64, y: 3 }, fence(result.state));
  assert.equal(invalid.error, 'PATH_BLOCKED');
  assert.strictEqual(invalid.state, result.state);
  assert.equal(
    g.applyTurnMove(result.state, 'bob', { x: 3, y: 4 }, fence(result.state)).error,
    'WRONG_MODE',
  );
  assert.equal(
    g.moveInput(result.state, 'alice', {
      inputSeq: 2,
      movementGeneration: 1,
      target: { x: 6, y: 3 },
    }).error,
    'WRONG_MODE',
  );
});

test('wall clock tick, living routines and old queued plans are inert while a player is reading', () => {
  const s = fixture();
  s.entities.keeper.path = [{ x: 7, y: 4 }];
  s.npcBrains.keeper.plan = [{ kind: 'move_to', target: { x: 7, y: 4 } }];
  s.npcBrains.keeper.cursor = 0;
  assert.deepEqual(g.tick(s, 20).state, s);
  assert.deepEqual(g.stepLivingNpcs(s).state, s);
  assert.deepEqual(g.stepNpcPlan(s, 'keeper').state, s);
  assert.equal(g.applyWorldTurnAction(s, 'keeper', { kind: 'wait' }, fence(s)).error, 'WRONG_MODE');
});

test('click and interpreted text share authority and do not spend player resources', () => {
  const s = fixture();
  Object.assign(s.entities.keeper, { x: 3, y: 3 });
  const action = g.parsePlayerTextAction(s, 'alice', 'push keeper');
  assert.deepEqual(action, { kind: 'push', targetId: 'keeper' });
  const click = g.applyTurnAction(s, 'alice', action, fence(s));
  const proposal = g.proposePlayerTextIntent(s, 'alice', 'push keeper');
  assert.ok(proposal);
  const text = g.confirmPlayerTextIntent(s, 'alice', proposal, true);
  assert.deepEqual(text, click);
  assert.equal(click.state.entities.keeper.x, 4);
  assert.equal(click.state.turnController.resources.alice.main, 1);
  assert.equal(click.state.entities.keeper.feedback.kind, 'push');
  assert.equal(
    g.applyTurnAction(click.state, 'alice', { kind: 'hit', targetId: 'keeper' }, fence(click.state))
      .error,
    'OUT_OF_RANGE',
  );
  const invalid = g.applyTurnAction(s, 'alice', { kind: 'hit', targetId: 'missing' }, fence(s));
  assert.equal(invalid.error, 'TARGET_UNAVAILABLE');
  assert.strictEqual(invalid.state, s);
  assert.equal(s.turnController.resources.alice.main, 1);
});

test('a valid blocked push does not consume player actions or move someone through collision', () => {
  const s = fixture();
  Object.assign(s.entities.keeper, { x: 3, y: 3 });
  s.maps.courtyard.blocked.push({ x: 4, y: 3 });
  const r = g.applyTurnAction(s, 'alice', { kind: 'push', targetId: 'keeper' }, fence(s));
  assert.equal(r.error, undefined);
  assert.equal(r.state.entities.keeper.x, 3);
  assert.equal(r.state.turnController.resources.alice.main, 1);
  assert.equal(r.events[0].kind, 'action.push_blocked');
});

test('player reaction interrupts durably without a consumable quota and returns to the original actor', () => {
  const s = fixture();
  Object.assign(s.entities.bob, { x: 3, y: 3 });
  const pending = g.applyTurnAction(s, 'alice', { kind: 'hit', targetId: 'bob' }, fence(s));
  assert.equal(pending.error, undefined);
  assert.equal(pending.state.turnController.phase, 'reaction');
  assert.equal(pending.state.turnController.activeActorId, 'bob');
  assert.ok(pending.state.turnController.pendingResolution);
  assert.equal(pending.state.turnController.resources.alice.main, 1);
  assert.equal(g.endPlayerTurn(pending.state, 'alice', fence(pending.state)).error, 'WRONG_MODE');
  assert.equal(
    g.beginTurnReaction(
      pending.state,
      {
        id: 'nested',
        reactorId: 'alice',
        causeActorId: 'bob',
        action: { kind: 'hit', targetId: 'alice' },
      },
      fence(pending.state),
    ).error,
    'ROUND_LOCKED',
  );
  const saved = JSON.parse(JSON.stringify(pending.state));
  const reply = g.resolveTurnReaction(saved, 'bob', 'defend', fence(saved));
  assert.equal(reply.error, undefined);
  assert.equal(reply.state.entities.bob.vitality, 6);
  assert.equal(reply.state.turnController.phase, 'player');
  assert.equal(reply.state.turnController.activeActorId, 'alice');
  assert.equal(reply.state.turnController.resources.alice.main, 1);
  assert.equal(reply.state.turnController.resources.bob.reaction, 1);
  assert.equal(reply.state.turnController.pendingResolution, undefined);
  assert.equal(
    g.resolveTurnReaction(reply.state, 'bob', 'defend', fence(saved)).error,
    'STALE_STATE',
  );
  assert.equal(
    g.applyTurnMove(reply.state, 'alice', { x: 2, y: 2 }, fence(s)).error,
    'STALE_STATE',
  );
});

test('ordered multi-recipient speech waits for world phase and whisper addressees stay private', () => {
  let s = fixture();
  Object.assign(s.entities.bob, { x: 10, y: 7 });
  Object.assign(s.entities.keeper, { x: 3, y: 3 });
  s.entities.helper = { id: 'helper', kind: 'npc', mapId: 'courtyard', x: 4, y: 3, revision: 0 };
  s.npcBrains.helper = structuredClone(s.npcBrains.keeper);
  const inputA = { channel: 'whisper', text: 'A private question for keeper' },
    identityA = { turnId: '00000000-0000-4000-8000-000000000001', segmentIndex: 0 };
  s = g.applyNpcSpeech(s, 'alice', 'keeper', inputA, {
    suppressReply: true,
    identity: identityA,
  }).state;
  const markerA = g.admittedNpcSpeechObservationId(s, 'alice', 'keeper', inputA, identityA);
  assert.ok(markerA);
  const first = {
    id: 'speech-a',
    recipientId: 'keeper',
    utteranceId: markerA,
    channel: 'whisper',
    audienceIds: ['alice', 'keeper'],
  };
  s = g.queueTurnSpeech(s, 'alice', first, fence(s)).state;
  assert.deepEqual(g.queueTurnSpeech(s, 'alice', first, fence(s)).state, s);
  Object.assign(s.entities.alice, { x: 4, y: 2 });
  const inputB = { channel: 'whisper', text: 'A private question for helper' },
    identityB = { turnId: '00000000-0000-4000-8000-000000000002', segmentIndex: 0 };
  s = g.applyNpcSpeech(s, 'alice', 'helper', inputB, {
    suppressReply: true,
    identity: identityB,
  }).state;
  const markerB = g.admittedNpcSpeechObservationId(s, 'alice', 'helper', inputB, identityB);
  assert.ok(markerB);
  s = g.queueTurnSpeech(
    s,
    'alice',
    {
      id: 'speech-b',
      recipientId: 'helper',
      utteranceId: markerB,
      channel: 'whisper',
      audienceIds: ['alice', 'helper'],
    },
    fence(s),
  ).state;
  assert.deepEqual(
    s.turnController.deferredSpeech.map((q) => q.recipientId),
    ['keeper', 'helper'],
  );
  assert.deepEqual(
    s.turnController.deferredSpeech.map((q) => q.sequence),
    [1, 2],
  );
  assert.equal(s.turnController.resources.alice.main, 1);
  assert.equal(g.projectState(s, 'alice').turn.pendingNpcReplies.length, 2);
  assert.deepEqual(g.projectState(s, 'bob').turn.pendingNpcReplies, []);
  assert.equal(g.markTurnSpeechResolved(s, 'speech-a', fence(s)).error, 'WRONG_MODE');
  s = advanceToWorld(s);
  assert.equal(g.finishWorldPhase(s, fence(s)).error, 'ROUND_LOCKED');
  s = g.markTurnSpeechResolved(s, 'speech-a', fence(s)).state;
  s = g.markTurnSpeechResolved(s, 'speech-b', fence(s)).state;
  const oldFence = fence(s);
  s = g.finishWorldPhase(s, oldFence).state;
  assert.equal(s.turnController.roundNumber, 2);
  assert.equal(s.turnController.activeActorId, 'alice');
  assert.equal(s.turnController.resources.alice.main, 1);
  assert.equal(
    g.applyWorldTurnAction(s, 'keeper', { kind: 'wait' }, oldFence).error,
    'STALE_STATE',
  );
});

test('end turn cannot skip a player and world actions are finite before budgets reset', () => {
  let s = fixture({ maxNpcActions: 1, maxWorldActions: 1 });
  const initial = fence(s);
  s = g.endPlayerTurn(s, 'alice', initial).state;
  assert.equal(s.turnController.activeActorId, 'bob');
  assert.equal(g.endPlayerTurn(s, 'alice', initial).error, 'STALE_STATE');
  assert.equal(g.endPlayerTurn(s, 'alice', fence(s)).error, 'WRONG_MODE');
  s = g.endPlayerTurn(s, 'bob', fence(s)).state;
  assert.equal(s.turnController.phase, 'world');
  s = g.applyWorldTurnAction(s, 'keeper', { kind: 'wait' }, fence(s)).state;
  assert.equal(
    g.applyWorldTurnAction(s, 'keeper', { kind: 'wait' }, fence(s)).error,
    'ROUND_LOCKED',
  );
  s = g.finishWorldPhase(s, fence(s)).state;
  assert.equal(s.turnController.phase, 'player');
  assert.equal(s.turnController.roundNumber, 2);
});

test('explicit revocation removes blocked active turn; mere disconnection does not skip anyone', () => {
  let s = fixture();
  const saved = JSON.parse(JSON.stringify(s));
  assert.equal(saved.turnController.activeActorId, 'alice');
  s = g.removeTurnParticipant(s, 'alice').state;
  assert.equal(s.turnController.activeActorId, 'bob');
  assert.deepEqual(s.turnController.actorOrder, ['bob']);
  assert.equal(s.turnController.resources.alice, undefined);
  assert.equal(g.applyTurnMove(s, 'alice', { x: 3, y: 3 }, fence(s)).error, 'FORBIDDEN');
});

test('deferred reply preserves source provenance but only current listeners hear its response', () => {
  let s = fixture();
  Object.assign(s.entities.bob, { x: 10, y: 7 });
  Object.assign(s.entities.keeper, { x: 3, y: 3 });
  const speech = { channel: 'whisper', text: 'PRIVATE_ORIGINAL_QUESTION' },
    identity = { turnId: '00000000-0000-4000-8000-000000000003', segmentIndex: 0 };
  s = g.applyNpcSpeech(s, 'alice', 'keeper', speech, { suppressReply: true, identity }).state;
  const marker = g.admittedNpcSpeechObservationId(s, 'alice', 'keeper', speech, identity);
  s = g.queueTurnSpeech(
    s,
    'alice',
    {
      id: 'deferred-reply',
      recipientId: 'keeper',
      utteranceId: marker,
      channel: 'whisper',
      audienceIds: ['alice', 'keeper'],
    },
    fence(s),
  ).state;
  Object.assign(s.entities.alice, { x: 10, y: 7 });
  s = advanceToWorld(s);
  assert.deepEqual(
    g.buildNpcPublicSpeechContext(s, 'keeper', ['alice', 'keeper'], [marker]).claims,
    [],
  );
  assert.deepEqual(s.turnController.deferredSpeech[0].audienceIds, ['alice', 'keeper']);
  const prospective = g.npcSpeechProspectiveListenerIds(s, 'keeper', 'whisper');
  assert.deepEqual(prospective, ['keeper']);
  const context = g.buildNpcPublicSpeechContext(
    s,
    'keeper',
    prospective,
    [marker],
    [],
    'deferred-reply',
  );
  assert.equal(context.claims.length, 1);
  const reply = g.commitNpcPublicUtterance(s, 'keeper', {
    text: 'A reply to the saved question',
    channel: 'whisper',
    recipientId: 'alice',
    observationIds: [marker],
    requestedFactIds: [],
    contextHash: g.npcContextFingerprint(context),
    deferredSpeechId: 'deferred-reply',
  });
  assert.equal(reply.error, undefined);
  assert.deepEqual(reply.state.npcUtterances.at(-1).audienceIds, ['keeper']);
  assert.ok(
    !JSON.stringify(g.projectState(reply.state, 'alice')).includes('A reply to the saved question'),
  );
  assert.ok(
    !JSON.stringify(g.projectState(reply.state, 'bob')).includes('A reply to the saved question'),
  );
  assert.equal(
    g.buildNpcPublicSpeechContext(
      s,
      'keeper',
      ['alice', 'keeper', 'bob'],
      [marker],
      [],
      'deferred-reply',
    ).claims.length,
    0,
  );
  const stale = g.commitNpcPublicUtterance(s, 'keeper', {
    text: 'wrong queue',
    channel: 'whisper',
    recipientId: 'alice',
    observationIds: [marker],
    contextHash: g.npcContextFingerprint(context),
    deferredSpeechId: 'nonexistent',
  });
  assert.equal(stale.error, 'STALE_STATE');
});

test('physical NPC consequences are perceived as causes; personality response remains a later decision', () => {
  const s = fixture();
  Object.assign(s.entities.keeper, { x: 3, y: 3 });
  const hit = g.applyTurnAction(s, 'alice', { kind: 'hit', targetId: 'keeper' }, fence(s));
  const recorded = g.recordNpcEvents(s, hit.state, hit.events, 'physical-hit');
  const observation = recorded.state.npcBrains.keeper.living.observations.find(
    (o) => o.kind === 'harmed',
  );
  assert.ok(observation);
  assert.equal(observation.actorId, 'alice');
  assert.ok(
    recorded.state.npcBrains.keeper.living.causes.some((c) => c.observationId === observation.id),
  );
  assert.equal(
    recorded.state.npcUtterances?.filter((u) => u.speakerId === 'keeper').length ?? 0,
    0,
  );
  assert.deepEqual(g.stepLivingNpcs(recorded.state).state, recorded.state);
});

test('AI physical proposals are admitted only in the new world phase and still obey authored harm taboos', () => {
  const player = fixture();
  Object.assign(player.entities.keeper, { x: 3, y: 3 });
  const proposal = (state) => ({
    ...g.createMockNpcPlan(state, 'keeper'),
    actions: [{ kind: 'hit', targetId: 'alice' }],
    targetRevisions: { alice: state.entities.alice.revision },
  });
  assert.equal(g.acceptNpcPlan(player, 'keeper', proposal(player)).error, 'INVALID_ACTION');
  const world = advanceToWorld(player);
  assert.equal(g.acceptNpcPlan(world, 'keeper', proposal(world)).error, undefined);
  const forbidden = structuredClone(world);
  forbidden.npcBrains.keeper.living.personality.taboos.push('harm');
  assert.equal(g.acceptNpcPlan(forbidden, 'keeper', proposal(forbidden)).error, 'FORBIDDEN');
  assert.equal(
    g.applyWorldTurnAction(
      forbidden,
      'keeper',
      { kind: 'hit', targetId: 'alice' },
      fence(forbidden),
    ).error,
    'FORBIDDEN',
  );
});

test('legacy reducer entrypoints preserve authority and finite world work without player budgets', () => {
  const s = fixture();
  Object.assign(s.entities.keeper, { x: 3, y: 3 });
  const first = g.applyAction(s, 'alice', { kind: 'hit', targetId: 'keeper' });
  assert.equal(first.error, undefined);
  assert.equal(first.state.turnController.resources.alice.main, 1);
  assert.equal(
    g.applyAction(first.state, 'alice', { kind: 'push', targetId: 'keeper' }).error,
    undefined,
  );
  assert.equal(g.applyAction(s, 'bob', { kind: 'wait' }).error, 'WRONG_MODE');
  assert.equal(g.applyAction(s, 'keeper', { kind: 'wait' }).error, 'WRONG_MODE');
  const world = advanceToWorld(s);
  assert.equal(
    g.applyAction(world, 'alice', { kind: 'open', targetId: 'door' }).error,
    'WRONG_MODE',
  );
  const acting = g.applyAction(world, 'keeper', { kind: 'wait' });
  assert.equal(acting.state.turnController.worldActions, 1);
  assert.equal(g.applyAction(acting.state, 'keeper', { kind: 'wait' }).error, 'ROUND_LOCKED');
});

test('world NPC contact pauses for player defense then resumes the finite world phase exactly once', () => {
  const player = fixture();
  Object.assign(player.entities.keeper, { x: 3, y: 3 });
  const world = advanceToWorld(player),
    oldFence = fence(world);
  const pending = g.applyWorldTurnAction(
    world,
    'keeper',
    { kind: 'hit', targetId: 'alice' },
    oldFence,
  );
  assert.equal(pending.error, undefined);
  assert.equal(pending.state.turnController.phase, 'reaction');
  assert.equal(pending.state.turnController.activeActorId, 'alice');
  assert.equal(pending.state.turnController.reaction.resumePhase, 'world');
  assert.equal(pending.state.turnController.worldActions, 0);
  assert.equal(g.finishWorldPhase(pending.state, fence(pending.state)).error, 'ROUND_LOCKED');
  const restored = JSON.parse(JSON.stringify(pending.state));
  const defended = g.resolveTurnReaction(restored, 'alice', 'defend', fence(restored));
  assert.equal(defended.error, undefined);
  assert.equal(defended.state.turnController.phase, 'world');
  assert.equal(defended.state.turnController.activeActorId, null);
  assert.equal(defended.state.entities.alice.vitality, 6);
  assert.equal(defended.state.turnController.resources.alice.reaction, 1);
  assert.equal(defended.state.turnController.worldActions, 1);
  assert.equal(defended.state.turnController.worldNpcActions.keeper, 1);
  assert.equal(
    g.applyWorldTurnAction(
      defended.state,
      'keeper',
      { kind: 'hit', targetId: 'alice' },
      fence(defended.state),
    ).error,
    'ROUND_LOCKED',
  );
  assert.equal(
    g.applyWorldTurnAction(defended.state, 'keeper', { kind: 'wait' }, oldFence).error,
    'STALE_STATE',
  );
  assert.equal(
    g.finishWorldPhase(defended.state, fence(defended.state)).state.turnController.roundNumber,
    2,
  );
});

test('declining a world push reaction commits the push and revoking its reactor resumes world safely', () => {
  const player = fixture();
  Object.assign(player.entities.keeper, { x: 3, y: 3 });
  const world = advanceToWorld(player);
  const pending = g.applyWorldTurnAction(
    world,
    'keeper',
    { kind: 'push', targetId: 'alice' },
    fence(world),
  );
  const resolved = g.resolveTurnReaction(pending.state, 'alice', 'decline', fence(pending.state));
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.state.entities.alice.x, 1);
  assert.equal(resolved.state.turnController.resources.alice.reaction, 1);
  assert.equal(resolved.state.turnController.phase, 'world');
  const removed = g.removeTurnParticipant(pending.state, 'alice');
  assert.equal(removed.state.turnController.phase, 'world');
  assert.equal(removed.state.turnController.pendingResolution, undefined);
  assert.deepEqual(removed.state.turnController.actorOrder, ['bob']);
});
