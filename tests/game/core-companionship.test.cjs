const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');

function fixture(turns = true) {
  const draft = g.createCompleteObservatoryDraft();
  if (turns) draft.turnRules = g.turnRulesSchema.parse({});
  else delete draft.turnRules;
  const compiled = g.compilePlayableDraft(draft);
  assert.deepEqual(compiled.errors, []);
  const s = g.createStateFromPlayable(compiled.playable, ['alice']);
  Object.assign(s.entities.alice, { x: 5, y: 4 });
  return s;
}
function story(s, text = 'Да...думаю знаю. Пойдешь со мной?', decision = 'follow') {
  const input = {
    operationId: randomUUID(),
    text,
    channel: 'say',
    targetNpcId: 'keeper',
    expectedCanonRevision: s.narrativeCanon?.revision ?? 0,
  };
  const id = randomUUID();
  const context = g.buildStoryTurnContext(s, 'alice', input, id);
  const proposal = g.createMockStoryTurnProposal(s, 'alice', input, id);
  proposal.steps[0].reply = {
    text: decision === 'stop' ? 'Я останусь здесь.' : 'Да, пойдем вместе. Покажешь, где его найти?',
    ...(decision
      ? {
          companionIntent: {
            kind: decision,
            actorId: 'alice',
            sourceObservationId: context.dialogues[0].replyToObservationId,
          },
        }
      : {}),
  };
  return { ...g.applyStoryTurnProposal(s, 'alice', input, id, proposal), input, id, proposal };
}
function world(s) {
  const r = g.endPlayerTurn(s, 'alice', g.turnFence(s));
  assert.equal(r.error, undefined);
  return r.state;
}
function execute(s) {
  const action = g.companionAction(s, 'keeper');
  const r = g.applyWorldTurnAction(s, 'keeper', action, g.turnFence(s));
  assert.equal(r.error, undefined, JSON.stringify(action));
  return r.state;
}

test('Mira agreement becomes a durable NPC decision; player request or RP prose alone grants no consent', () => {
  const s = fixture();
  const noDecision = story(s, undefined, null);
  assert.equal(noDecision.error, undefined);
  assert.equal(noDecision.state.npcBrains.keeper.living.companionship, undefined);
  assert.equal(g.companionAction(s, 'keeper'), undefined);
  const r = story(s);
  assert.equal(r.error, undefined);
  const agreement = r.state.npcBrains.keeper.living.companionship;
  assert.equal(agreement.actorId, 'alice');
  assert.ok(
    r.state.npcUtterances.some((u) => u.id === agreement.utteranceId && u.speakerId === 'keeper'),
  );
  assert.equal(s.npcBrains.keeper.living.companionship, undefined);
  const restored = JSON.parse(JSON.stringify(r.state));
  assert.deepEqual(restored.npcBrains.keeper.living.companionship, agreement);
  assert.equal(
    JSON.stringify(g.projectState(restored, 'alice')).includes('sourceObservationId'),
    false,
  );
  assert.equal(g.gameProjectionSchema.safeParse(g.projectState(restored, 'alice')).success, true);
});

test('following runs only after end-turn, uses normal movement budget and stops adjacent without overlap', () => {
  let s = story(fixture()).state;
  const moved = g.applyTurnMove(s, 'alice', { x: 3, y: 6 }, g.turnFence(s));
  assert.equal(moved.error, undefined);
  s = moved.state;
  const before = structuredClone(s.entities.keeper);
  assert.deepEqual(g.stepLivingNpcs(s).state.entities.keeper, before);
  assert.equal(
    g.applyWorldTurnAction(s, 'keeper', g.companionAction(s, 'keeper'), g.turnFence(s)).error,
    'WRONG_MODE',
  );
  s = world(s);
  const action = g.companionAction(s, 'keeper');
  assert.equal(action.kind, 'move_to');
  s = execute(s);
  assert.ok(g.footprintDistance(s.entities.keeper, s.entities.alice) <= 1);
  assert.equal(g.footprintOverlaps(s.entities.keeper, s.entities.alice), false);
  assert.equal(s.turnController.worldNpcActions.keeper, 1);
  assert.deepEqual(g.companionAction(s, 'keeper'), { kind: 'wait' });
});

test('blocked paths wait and recover; stale planned destination revalidates all actor collisions', () => {
  let s = world(story(fixture()).state);
  Object.assign(s.entities.alice, { x: 3, y: 4 });
  const planned = g.companionAction(s, 'keeper');
  assert.equal(planned.kind, 'move_to');
  s.entities.blocker = {
    id: 'blocker',
    kind: 'npc',
    mapId: s.entities.keeper.mapId,
    ...planned.target,
    revision: 0,
  };
  const blocked = g.applyWorldTurnAction(s, 'keeper', planned, g.turnFence(s));
  assert.equal(blocked.error, 'PATH_BLOCKED');
  assert.strictEqual(blocked.state, s);
  delete s.entities.blocker;
  const npc = s.entities.keeper;
  const map = s.maps[npc.mapId];
  const prior = structuredClone(map.blocked);
  map.blocked.push(
    { x: npc.x - 1, y: npc.y },
    { x: npc.x + 1, y: npc.y },
    { x: npc.x, y: npc.y - 1 },
    { x: npc.x, y: npc.y + 1 },
  );
  assert.deepEqual(g.companionAction(s, 'keeper'), { kind: 'wait' });
  map.blocked = prior;
  assert.equal(g.companionAction(s, 'keeper').kind, 'move_to');
});

test('different actor footprints find adjacent anchors and never squeeze through a one-cell gap', () => {
  const s = world(story(fixture()).state);
  const npc = s.entities.keeper;
  npc.tokenSize = 'large';
  Object.assign(s.entities.alice, { x: 3, y: 6 });
  const action = g.companionAction(s, 'keeper');
  assert.equal(action.kind, 'move_to');
  const result = g.applyWorldTurnAction(s, 'keeper', action, g.turnFence(s));
  assert.equal(result.error, undefined);
  assert.equal(
    g.footprintOverlaps(result.state.entities.keeper, result.state.entities.alice),
    false,
  );
  assert.ok(g.footprintDistance(result.state.entities.keeper, result.state.entities.alice) <= 1);
  Object.assign(s.entities.alice, { x: 10, y: 5 });
  s.entities.door.open = true;
  s.maps[npc.mapId].blocked = Array.from({ length: 24 }, (_, y) => ({ x: 8, y })).filter(
    (p) => p.y !== 5,
  );
  assert.deepEqual(g.companionAction(s, 'keeper'), { kind: 'wait' });
});

test('NPC may stop or disagree; cancellation invalidates a preexisting patrol/path', () => {
  let s = story(fixture()).state;
  s.npcBrains.keeper.plan = [{ kind: 'move_to', target: { x: 9, y: 6 } }];
  s.npcBrains.keeper.cursor = 0;
  s.entities.keeper.path = [{ x: 7, y: 4 }];
  const r = story(s, 'Можешь остаться здесь.', 'stop');
  assert.equal(r.error, undefined);
  assert.equal(r.state.npcBrains.keeper.living.companionship, undefined);
  assert.deepEqual(r.state.npcBrains.keeper.plan, []);
  assert.deepEqual(r.state.entities.keeper.path, []);
});

test('observed exits, doors and destination occupancy gate following across scenes without teleportation', () => {
  let s = story(fixture()).state;
  Object.assign(s.entities.alice, { x: 13, y: 5 });
  Object.assign(s.entities.keeper, { x: 12, y: 5 });
  s.entities.door.open = true;
  const crossed = g.applyTurnAction(
    s,
    'alice',
    { kind: 'transition', targetId: 'roof-exit' },
    g.turnFence(s),
  );
  assert.equal(crossed.error, undefined);
  s = world(crossed.state);
  assert.equal(s.entities.keeper.mapId, 'observatory');
  const action = g.companionAction(s, 'keeper');
  assert.deepEqual(action, { kind: 'transition', targetId: 'roof-exit' });
  // This is continuation of an agreed, witnessed departure, not off-map simulation.
  assert.deepEqual(g.worldTurnCompanionContinuation(s, 'keeper'), action);
  const admitted = g.admitWorldTurnActors(s, ['keeper'], g.turnFence(s));
  assert.equal(admitted.error, undefined);
  s = admitted.state;
  assert.equal(
    g.applyWorldTurnAction(s, 'keeper', { kind: 'wait' }, g.turnFence(s)).error,
    'FORBIDDEN',
  );
  assert.equal(
    g.applyWorldTurnAction(
      s,
      'keeper',
      {
        kind: 'move_to',
        target: { x: 5, y: 4 },
      },
      g.turnFence(s),
    ).error,
    'FORBIDDEN',
  );
  assert.equal(g.applyWorldTurnAction(s, 'keeper', action, g.turnFence(s)).error, 'PATH_BLOCKED');
  Object.assign(s.entities.alice, { x: 4, y: 3 });
  s.entities.door.open = false;
  s.maps.observatory.exits[0].doorId = 'door';
  assert.equal(g.applyWorldTurnAction(s, 'keeper', action, g.turnFence(s)).error, 'PATH_BLOCKED');
  s.entities.door.open = true;
  s = execute(s);
  assert.equal(s.entities.keeper.mapId, 'roof');
  assert.deepEqual(s.npcBrains.keeper.living.companionship.crossings, []);
  assert.equal(g.footprintOverlaps(s.entities.keeper, s.entities.alice), false);
  const unseen = world(story(fixture()).state);
  Object.assign(unseen.entities.alice, { mapId: 'roof', x: 4, y: 3 });
  assert.deepEqual(g.companionAction(unseen, 'keeper'), { kind: 'wait' });
  assert.equal(g.worldTurnCompanionContinuation(unseen, 'keeper'), undefined);
  assert.equal(g.admitWorldTurnActors(unseen, ['keeper'], g.turnFence(unseen)).error, 'FORBIDDEN');
  assert.equal(
    g.applyWorldTurnAction(unseen, 'keeper', action, g.turnFence(unseen)).error,
    'FORBIDDEN',
  );
  assert.equal(s.turnController.worldNpcActions.keeper, 1);
  assert.equal(
    g.applyWorldTurnAction(s, 'keeper', { kind: 'wait' }, g.turnFence(s)).error,
    'ROUND_LOCKED',
  );
});

test('deferred world speech uses the same intent admission, rejects wrong actor/evidence/whisper atomically', () => {
  let initial = fixture();
  const speech = { channel: 'say', text: 'Will you come with me?' };
  const identity = { turnId: randomUUID(), segmentIndex: 0 };
  initial = g.applyNpcSpeech(initial, 'alice', 'keeper', speech, {
    suppressReply: true,
    identity,
  }).state;
  const marker = g.admittedNpcSpeechObservationId(initial, 'alice', 'keeper', speech, identity);
  const queued = g.queueTurnSpeech(
    initial,
    'alice',
    {
      id: randomUUID(),
      recipientId: 'keeper',
      channel: 'say',
      utteranceId: marker,
      audienceIds: ['alice', 'keeper'],
    },
    g.turnFence(initial),
  );
  assert.equal(queued.error, undefined);
  const s = world(queued.state);
  const deferred = s.turnController.deferredSpeech[0];
  const ids = [deferred.utteranceId];
  const context = g.buildNpcPublicSpeechContext(
    s,
    'keeper',
    deferred.audienceIds,
    ids,
    [],
    deferred.id,
    'en',
    'alice',
  );
  const input = {
    text: 'Yes, I will come with you.',
    companionIntent: { kind: 'follow', actorId: 'alice', sourceObservationId: ids[0] },
    channel: 'say',
    recipientId: 'alice',
    observationIds: ids,
    deferredSpeechId: deferred.id,
    contextHash: g.npcContextFingerprint(context),
  };
  const good = g.commitNpcPublicUtterance(s, 'keeper', input);
  assert.equal(good.error, undefined);
  assert.equal(good.state.npcBrains.keeper.living.companionship.actorId, 'alice');
  for (const companionIntent of [
    { ...input.companionIntent, actorId: 'other' },
    { ...input.companionIntent, sourceObservationId: 'private-secret' },
    { ...input.companionIntent, kind: 'teleport' },
  ]) {
    const r = g.commitNpcPublicUtterance(s, 'keeper', { ...input, companionIntent });
    assert.ok(r.error);
    assert.strictEqual(r.state, s);
  }
});

test('multiple speech segments retain their exact source fence when an earlier NPC reply changes companionship', () => {
  const s = fixture(),
    id = randomUUID();
  const input = {
    operationId: randomUUID(),
    text: 'Will you come? *wait* Thank you.',
    channel: 'say',
    targetNpcId: 'keeper',
    expectedCanonRevision: 0,
  };
  const context = g.buildStoryTurnContext(s, 'alice', input, id);
  const proposal = g.createMockStoryTurnProposal(s, 'alice', input, id);
  proposal.steps[0].reply = {
    text: 'Yes, let us go together.',
    companionIntent: {
      kind: 'follow',
      actorId: 'alice',
      sourceObservationId: context.dialogues[0].replyToObservationId,
    },
  };
  const r = g.applyStoryTurnProposal(s, 'alice', input, id, proposal);
  assert.equal(r.error, undefined);
  assert.equal(r.state.npcBrains.keeper.living.companionship.actorId, 'alice');
  assert.equal(r.entries.filter((e) => e.kind === 'npc_reply').length, 2);
});

test('queued real-time companion movement rechecks occupancy; an ordinary RP invitation remains inert', () => {
  let s = story(fixture(false)).state;
  Object.assign(s.entities.alice, { x: 3, y: 4 });
  const action = g.companionAction(s, 'keeper');
  const r = g.applyAction(s, 'keeper', action);
  assert.equal(r.error, undefined);
  s = r.state;
  const point = s.entities.keeper.path[0];
  s.entities.blocker = {
    id: 'blocker',
    kind: 'npc',
    mapId: s.entities.keeper.mapId,
    ...point,
    revision: 0,
  };
  const before = structuredClone(s.entities.keeper);
  s = g.tick(s, 4).state;
  assert.equal(s.entities.keeper.x, before.x);
  assert.equal(s.entities.keeper.y, before.y);
  assert.deepEqual(s.entities.keeper.path, []);
});

test('leader returning before companion crosses does not send NPC away along a stale route', () => {
  const s = world(story(fixture()).state);
  s.npcBrains.keeper.living.companionship.crossings = [
    { mapId: 'observatory', exitId: 'roof-exit', destinationMapId: 'roof' },
  ];
  assert.deepEqual(g.companionAction(s, 'keeper'), { kind: 'wait' });
});

test('active consent source survives long conversation, but companions are removed with a revoked participant', () => {
  let s = story(fixture()).state;
  const original = s.npcBrains.keeper.living.companionship.sourceObservationId;
  for (let i = 0; i < 140; i++) {
    const identity = { turnId: randomUUID(), segmentIndex: 0 };
    const r = g.applyNpcSpeech(
      s,
      'alice',
      'keeper',
      { channel: 'say', text: `Ordinary conversation ${i}` },
      { suppressReply: true, identity },
    );
    assert.equal(r.error, undefined);
    s = r.state;
  }
  assert.ok(s.npcBrains.keeper.living.observations.some((o) => o.id === original));
  s.entities.keeper.path = [{ x: 7, y: 4 }];
  s = g.removeTurnParticipant(s, 'alice').state;
  assert.equal(s.npcBrains.keeper.living.companionship, undefined);
  assert.deepEqual(s.entities.keeper.path, []);
});
