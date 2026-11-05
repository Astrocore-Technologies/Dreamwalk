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

test('ongoing agreement replaces an old approach and gives each planner the current voluntary follow step', () => {
  const initial = fixture();
  initial.npcBrains.keeper.plan = [{ kind: 'move_to', target: { x: 9, y: 6 } }];
  initial.npcBrains.keeper.cursor = 0;
  initial.entities.keeper.path = [{ x: 7, y: 4 }];
  const accepted = story(initial).state;
  assert.deepEqual(accepted.npcBrains.keeper.plan, []);
  assert.deepEqual(accepted.entities.keeper.path, []);
  assert.deepEqual(g.buildNpcDecisionContext(accepted, 'keeper').companionship, {
    actorId: 'alice',
    nextAction: { kind: 'wait' },
  });
  const moved = g.applyTurnMove(accepted, 'alice', { x: 3, y: 6 }, g.turnFence(accepted));
  assert.equal(moved.error, undefined);
  let s = world(moved.state);
  const decision = g.buildNpcDecisionContext(s, 'keeper');
  assert.deepEqual(decision.companionship.nextAction, g.companionAction(s, 'keeper'));
  assert.equal(decision.companionship.nextAction.kind, 'move_to');
  assert.notDeepEqual(decision.companionship.nextAction.target, { x: 9, y: 6 });
  const plan = {
    ...g.createMockNpcPlan(s, 'keeper'),
    actions: [decision.companionship.nextAction],
    targetRevisions: {},
  };
  const admitted = g.acceptNpcPlan(s, 'keeper', plan);
  assert.equal(admitted.error, undefined);
  const executed = g.stepWorldNpcPlan(admitted.state, 'keeper');
  assert.equal(executed.error, undefined);
  s = executed.state;
  assert.ok(g.footprintDistance(s.entities.keeper, s.entities.alice) <= 1);
  assert.equal(s.npcBrains.keeper.living.companionship.actorId, 'alice');
  assert.equal(s.turnController.worldNpcActions.keeper, 1);
});

test('an established companion may deliberately pause a round and later revoke the agreement', () => {
  let s = story(fixture()).state;
  s = g.applyTurnMove(s, 'alice', { x: 3, y: 6 }, g.turnFence(s)).state;
  s = world(s);
  assert.equal(g.buildNpcDecisionContext(s, 'keeper').companionship.nextAction.kind, 'move_to');
  const before = { x: s.entities.keeper.x, y: s.entities.keeper.y };
  const deliberatePause = g.acceptNpcPlan(s, 'keeper', {
    ...g.createMockNpcPlan(s, 'keeper'),
    actions: [{ kind: 'wait' }],
    targetRevisions: {},
  });
  assert.equal(deliberatePause.error, undefined);
  const paused = g.stepWorldNpcPlan(deliberatePause.state, 'keeper');
  assert.equal(paused.error, undefined);
  assert.deepEqual(
    { x: paused.state.entities.keeper.x, y: paused.state.entities.keeper.y },
    before,
  );
  assert.equal(paused.state.npcBrains.keeper.living.companionship.actorId, 'alice');
  const stopped = story(story(fixture()).state, 'Do you still want to come?', 'stop');
  assert.equal(stopped.error, undefined);
  assert.equal(g.buildNpcDecisionContext(stopped.state, 'keeper').companionship, null);
  assert.equal(g.companionAction(stopped.state, 'keeper'), undefined);
});

test('a deliberate same-map pause preserves an agreed observed crossing in the next round', () => {
  let s = story(fixture()).state;
  Object.assign(s.entities.alice, { x: 13, y: 5 });
  Object.assign(s.entities.keeper, { x: 12, y: 5 });
  s.entities.door.open = true;
  s = world(s);
  const paused = g.acceptNpcPlan(s, 'keeper', {
    ...g.createMockNpcPlan(s, 'keeper'),
    actions: [{ kind: 'wait' }],
    targetRevisions: {},
  });
  assert.equal(paused.error, undefined);
  const acted = g.stepWorldNpcPlan(paused.state, 'keeper');
  assert.equal(acted.error, undefined);
  const finished = g.finishWorldPhase(acted.state, g.turnFence(acted.state));
  assert.equal(finished.error, undefined);
  s = finished.state;
  const crossed = g.applyTurnAction(
    s,
    'alice',
    { kind: 'transition', targetId: 'roof-exit' },
    g.turnFence(s),
  );
  assert.equal(crossed.error, undefined);
  s = world(crossed.state);
  assert.equal(s.npcBrains.keeper.living.companionship.actorId, 'alice');
  assert.deepEqual(g.worldTurnCompanionContinuation(s, 'keeper'), {
    kind: 'transition',
    targetId: 'roof-exit',
  });
  Object.assign(s.entities.alice, { x: 4, y: 3 });
  const admitted = g.admitWorldTurnActors(s, ['keeper'], g.turnFence(s));
  assert.equal(admitted.error, undefined);
  s = execute(admitted.state);
  assert.equal(s.entities.keeper.mapId, s.entities.alice.mapId);
  assert.equal(s.turnController.worldNpcActions.keeper, 1);
});

test('speech sees only an established agreement heard and recognized by its full current audience', () => {
  const s = story(fixture()).state;
  const agreement = s.npcBrains.keeper.living.companionship;
  const publicContext = (state, audience, recipient = 'alice') =>
    g.buildNpcPublicSpeechContext(
      state,
      'keeper',
      audience,
      [agreement.sourceObservationId],
      [],
      undefined,
      'en',
      recipient,
    );
  assert.deepEqual(publicContext(s, ['alice', 'keeper']).companionship, { actorId: 'alice' });
  s.entities.bob = { ...s.entities.alice, id: 'bob', x: 4, y: 4 };
  const newAudience = ['alice', 'keeper', 'bob'];
  assert.equal(publicContext(s, newAudience).companionship, undefined);
  assert.equal(publicContext(s, ['bob', 'keeper'], 'bob').companionship, undefined);
  const withoutAgreement = structuredClone(s);
  delete withoutAgreement.npcBrains.keeper.living.companionship;
  assert.deepEqual(publicContext(s, newAudience), publicContext(withoutAgreement, newAudience));
  // Neither the old route, evidence identity nor private current plan goes to speech.
  const safe = publicContext(s, ['alice', 'keeper']);
  assert.deepEqual(Object.keys(safe.companionship), ['actorId']);
  assert.equal(safe.currentPlan, undefined);
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

test('observed exits and doors gate following, with a free nearby arrival when the leader occupies the exit', () => {
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
  const followed = g.applyWorldTurnAction(s, 'keeper', action, g.turnFence(s));
  assert.equal(followed.error, undefined);
  assert.equal(followed.state.entities.keeper.mapId, 'roof');
  assert.deepEqual(followed.state.entities.alice, s.entities.alice);
  assert.equal(g.footprintOverlaps(followed.state.entities.keeper, s.entities.alice), false);
  assert.deepEqual(followed.state.npcBrains.keeper.living.companionship.crossings, []);
  assert.equal(followed.state.turnController.worldNpcActions.keeper, 1);
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

test('mixed director speech retains exact source fences when its one reply changes companionship', () => {
  const s = fixture(),
    id = randomUUID();
  const input = {
    operationId: randomUUID(),
    text: 'Will you come? *wait* Thank you.',
    channel: 'say',
    targetNpcId: 'keeper',
    expectedCanonRevision: 0,
    turnFence: g.turnFence(s),
  };
  const context = g.buildStoryTurnContext(s, 'alice', input, id);
  assert.equal(context.mode, 'director');
  const first = context.sceneSpeakers.find(
    (voice) => voice.npcId === 'keeper' && voice.segmentIndex === 0,
  );
  const last = context.sceneSpeakers.find(
    (voice) => voice.npcId === 'keeper' && voice.segmentIndex === 2,
  );
  assert.ok(first && last);
  assert.notEqual(first.replyToObservationId, last.replyToObservationId);
  const proposal = g.createMockStoryTurnProposal(s, 'alice', input, id);
  for (const step of proposal.steps) {
    step.reply = null;
    step.replyNpcId = null;
    step.replyContextHash = null;
  }
  Object.assign(proposal.steps[0], {
    replyNpcId: 'keeper',
    replyContextHash: first.speechHash,
    reply: {
      text: 'Yes, let us go together.',
      companionIntent: {
        kind: 'follow',
        actorId: 'alice',
        sourceObservationId: first.replyToObservationId,
      },
    },
  });
  const r = g.applyStoryTurnProposal(s, 'alice', input, id, proposal);
  assert.equal(r.error, undefined);
  assert.equal(r.state.npcBrains.keeper.living.companionship.actorId, 'alice');
  assert.equal(
    r.state.npcBrains.keeper.living.companionship.sourceObservationId,
    first.replyToObservationId,
  );
  assert.equal(r.entries.filter((e) => e.kind === 'npc_reply').length, 1);
  const speech = r.entries.filter((entry) => entry.kind === 'speech');
  assert.deepEqual(
    speech.map((entry) => entry.text),
    ['Will you come?', 'Thank you.'],
  );
  assert.equal(new Set(speech.map((entry) => entry.sourceId)).size, 2);
  const remembered = r.state.npcBrains.keeper.living.observations;
  assert.equal(
    remembered.find((entry) => entry.id === first.replyToObservationId).text,
    'Will you come?',
  );
  assert.equal(
    remembered.find((entry) => entry.id === last.replyToObservationId).text,
    'Thank you.',
  );
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
