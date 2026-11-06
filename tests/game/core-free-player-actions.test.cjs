const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');

function fixture() {
  const draft = g.createAuthoredDraft('courtyard');
  draft.turnRules = g.turnRulesSchema.parse({});
  const compiled = g.compilePlayableDraft(draft);
  assert.deepEqual(compiled.errors, []);
  const state = g.createStateFromPlayable(compiled.playable, ['alice', 'bob'], 19);
  Object.assign(state.entities.alice, { x: 2, y: 3 });
  Object.assign(state.entities.bob, { x: 20, y: 20 });
  Object.assign(state.entities.keeper, { x: 3, y: 3 });
  // A real pre-change save may have exhausted every legacy resource already.
  for (const resources of Object.values(state.turnController.resources))
    for (const key of Object.keys(resources)) resources[key] = 0;
  return JSON.parse(JSON.stringify(state));
}

test('legacy exhausted saves allow long footprint-checked movement and retain the full committed path', () => {
  const state = fixture();
  const map = state.maps.courtyard;
  map.width = 64;
  map.height = 64;
  map.blocked = [{ x: 4, y: 3 }];
  Object.assign(state.entities.keeper, { x: 30, y: 30 });
  const moved = g.applyTurnMove(state, 'alice', { x: 55, y: 3 }, g.turnFence(state));
  assert.equal(moved.error, undefined);
  const points = moved.state.entities.alice.movementTrace.points;
  assert.ok(points.length > 33, 'the old animation schema cannot truncate a legal path');
  assert.deepEqual(points[0], { x: 2, y: 3 });
  assert.deepEqual(points.at(-1), { x: 55, y: 3 });
  assert.ok(!points.some((p) => p.x === 4 && p.y === 3));
  for (let i = 1; i < points.length; i++)
    assert.equal(
      Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y),
      1,
    );
  assert.deepEqual(moved.state.turnController.resources, state.turnController.resources);
  assert.equal(
    g.gameProjectionSchema.safeParse(g.projectState(moved.state, 'alice')).success,
    true,
  );
  assert.equal(
    g.projectState(moved.state, 'bob').entities.find((e) => e.id === 'alice')?.movementTrace,
    undefined,
  );
  const blocked = structuredClone(state);
  blocked.maps.courtyard.blocked.push({ x: 55, y: 3 });
  const rejected = g.applyTurnMove(blocked, 'alice', { x: 55, y: 3 }, g.turnFence(blocked));
  assert.equal(rejected.error, 'PATH_BLOCKED');
  assert.strictEqual(rejected.state, blocked);
  assert.equal(
    g.applyTurnMove(state, 'bob', { x: 19, y: 20 }, g.turnFence(state)).error,
    'WRONG_MODE',
  );
  assert.equal(
    g.applyTurnMove(state, 'alice', { x: 5, y: 3 }, { ...g.turnFence(state), phaseEpoch: 0 }).error,
    'STALE_STATE',
  );
});

test('many legal actions in one player phase do not consume resources or trigger NPC work', () => {
  let state = fixture();
  Object.assign(state.entities.door, { x: 2, y: 4, locked: false, open: false });
  const original = structuredClone(state.turnController);
  for (let i = 0; i < 20; i++) {
    const action = { kind: i % 2 === 0 ? 'open' : 'close', targetId: 'door' };
    const result = g.applyTurnAction(state, 'alice', action, g.turnFence(state));
    assert.equal(result.error, undefined, action.kind);
    state = JSON.parse(JSON.stringify(result.state));
  }
  assert.equal(state.entities.door.open, false);
  assert.deepEqual(state.turnController.resources, original.resources);
  assert.equal(state.turnController.roundId, original.roundId);
  assert.equal(state.turnController.phase, 'player');
  assert.equal(state.turnController.worldActions, 0);
  assert.deepEqual(state.turnController.worldNpcActions, {});
  assert.deepEqual(g.stepLivingNpcs(state).state, state);
});

test('exhausted reaction counters cannot remove another player’s opportunity to respond', () => {
  const state = fixture();
  Object.assign(state.entities.bob, { x: 2, y: 4 });
  const pending = g.applyTurnAction(
    state,
    'alice',
    { kind: 'hit', targetId: 'bob' },
    g.turnFence(state),
  );
  assert.equal(pending.error, undefined);
  assert.equal(pending.state.turnController.phase, 'reaction');
  assert.equal(pending.state.entities.bob.vitality, state.entities.bob.vitality);
  assert.equal(
    g.resolveTurnReaction(pending.state, 'alice', 'decline', g.turnFence(pending.state)).error,
    'FORBIDDEN',
  );
  const defended = g.resolveTurnReaction(
    pending.state,
    'bob',
    'defend',
    g.turnFence(pending.state),
  );
  assert.equal(defended.error, undefined);
  assert.equal(defended.state.entities.bob.vitality, state.entities.bob.vitality);
  assert.deepEqual(defended.state.turnController.resources, state.turnController.resources);
  assert.equal(
    g.resolveTurnReaction(defended.state, 'bob', 'defend', g.turnFence(pending.state)).error,
    'STALE_STATE',
  );
  const revoked = g.removeTurnParticipant(state, 'bob').state;
  const denied = g.applyTurnAction(
    revoked,
    'alice',
    { kind: 'hit', targetId: 'bob' },
    g.turnFence(revoked),
  );
  assert.equal(denied.error, 'FORBIDDEN');
  assert.strictEqual(denied.state, revoked);
});

test('a long queued round keeps exact private sources through memory pruning, reload, resolution and revocation', () => {
  let state = fixture();
  const admitted = [];
  for (let i = 0; i < 130; i++) {
    const input = { channel: 'whisper', text: `PRIVATE_PENDING_${i}` };
    const identity = {
      turnId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      segmentIndex: 0,
    };
    const spoken = g.applyNpcSpeech(state, 'alice', 'keeper', input, {
      suppressReply: true,
      identity,
    });
    assert.equal(spoken.error, undefined);
    state = spoken.state;
    const marker = g.admittedNpcSpeechObservationId(state, 'alice', 'keeper', input, identity);
    assert.ok(marker);
    const observation = g.npcReplyObservation(state, 'alice', 'keeper', marker);
    const queued = g.queueTurnSpeech(
      state,
      'alice',
      {
        id: `pending-${i}`,
        recipientId: 'keeper',
        utteranceId: marker,
        channel: 'whisper',
        audienceIds: observation.audienceIds,
      },
      g.turnFence(state),
    );
    assert.equal(queued.error, undefined);
    state = queued.state;
    admitted.push(marker);
  }
  state = JSON.parse(JSON.stringify(state));
  assert.equal(state.turnController.deferredSpeech.length, 130);
  for (const id of admitted) assert.ok(g.npcReplyObservation(state, 'alice', 'keeper', id), id);
  assert.equal(g.projectTurnController(state, 'alice').pendingNpcReplies[0].count, 130);
  assert.equal(
    g.turnProjectionSchema.safeParse(g.projectTurnController(state, 'alice')).success,
    true,
  );
  assert.deepEqual(g.projectTurnController(state, 'bob').pendingNpcReplies, []);
  assert.doesNotMatch(
    JSON.stringify(g.projectState(state, 'bob')),
    /PRIVATE_PENDING_|pendingSpeechObservationIds/,
  );
  const revoked = g.removeTurnParticipant(state, 'alice');
  assert.equal(revoked.error, undefined);
  assert.equal(revoked.state.npcBrains.keeper.living.pendingSpeechObservationIds, undefined);
  state = g.endPlayerTurn(state, 'alice', g.turnFence(state)).state;
  state = g.endPlayerTurn(state, 'bob', g.turnFence(state)).state;
  const resolved = g.markTurnSpeechResolved(state, 'pending-0', g.turnFence(state));
  assert.equal(resolved.error, undefined);
  assert.ok(
    !resolved.state.npcBrains.keeper.living.pendingSpeechObservationIds.includes(admitted[0]),
  );
  assert.equal(resolved.state.npcBrains.keeper.living.pendingSpeechObservationIds.length, 129);
  assert.strictEqual(
    g.markTurnSpeechResolved(resolved.state, 'pending-0', g.turnFence(resolved.state)).state,
    resolved.state,
  );
});

test('world-phase pickup rejects a removed player even when legacy resources no longer gate actions', () => {
  let state = fixture();
  const item = state.entities.key;
  assert.ok(item);
  Object.assign(item, { mapId: 'courtyard', x: 2, y: 4, label: 'key' });
  delete item.ownerId;
  state = g.removeTurnParticipant(state, 'alice').state;
  state = g.endPlayerTurn(state, 'bob', g.turnFence(state)).state;
  assert.equal(state.turnController.phase, 'world');
  const result = g.applyStoryPickup(state, 'alice', 'key', 'I take key', {
    text: '*I take key*',
    turnFence: g.turnFence(state),
  });
  assert.equal(result.error, 'STALE_STATE');
  assert.strictEqual(result.state, state);
  assert.equal(state.entities.key.ownerId, undefined);
});
