const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
function fixture() {
  const draft = g.createCompleteObservatoryDraft();
  draft.turnRules = g.turnRulesSchema.parse({ movement: 2 });
  const s = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
  Object.assign(s.entities.alice, { x: 5, y: 4 });
  return s;
}
function reply(s, actions, presentationKind) {
  const speech = {
    channel: 'say',
    text: presentationKind ? 'Points toward the window' : 'Please come and look.',
  };
  const identity = { turnId: randomUUID(), segmentIndex: 0 };
  s = g.applyNpcSpeech(s, 'alice', 'keeper', speech, {
    suppressReply: true,
    identity,
    presentationKind,
  }).state;
  const marker = g.admittedNpcSpeechObservationId(s, 'alice', 'keeper', speech, identity);
  const audience = Object.values(s.entities)
    .filter((e) => ['npc', 'player'].includes(e.kind) && g.canNpcHear(s, e, s.entities.keeper))
    .map((e) => e.id);
  const context = g.buildNpcPublicSpeechContext(
    s,
    'keeper',
    audience,
    [marker],
    [],
    undefined,
    'en',
    'alice',
  );
  const input = {
    text: 'I will come and look.',
    channel: 'say',
    recipientId: 'alice',
    observationIds: [marker],
    replyToObservationId: marker,
    contextHash: g.npcContextFingerprint(context),
    ...(actions ? { actionIntent: { sourceObservationId: marker, actions } } : {}),
  };
  return { s, marker, context, input, result: g.commitNpcPublicUtterance(s, 'keeper', input) };
}
function world(s) {
  return g.endPlayerTurn(s, 'alice', g.turnFence(s)).state;
}
function nextRound(s) {
  s = g.finishWorldPhase(s, g.turnFence(s)).state;
  return world(s);
}

test('NPC chooses a one-time movement without a forced follow agreement, only after end turn', () => {
  const r = reply(fixture(), [{ kind: 'move_to', target: { x: 3, y: 6 } }]);
  assert.equal(r.result.error, undefined);
  let s = r.result.state;
  assert.equal(s.npcBrains.keeper.living.companionship, undefined);
  assert.equal(s.entities.keeper.x, 6);
  assert.equal(g.stepWorldNpcPlan(s, 'keeper').error, 'WRONG_MODE');
  s = world(s);
  const origin = { ...s.entities.keeper };
  s = g.stepWorldNpcPlan(s, 'keeper').state;
  assert.ok(
    Math.abs(s.entities.keeper.x - origin.x) + Math.abs(s.entities.keeper.y - origin.y) <= 2,
  );
  assert.equal(s.npcBrains.keeper.cursor, 0, 'long movement remains queued');
  assert.equal(g.stepWorldNpcPlan(s, 'keeper').error, 'ROUND_LOCKED');
  for (let i = 0; i < 5 && s.npcBrains.keeper.cursor === 0; i++)
    s = g.stepWorldNpcPlan(nextRound(s), 'keeper').state;
  assert.equal(s.entities.keeper.x, 3);
  assert.equal(s.entities.keeper.y, 6);
  assert.equal(s.npcBrains.keeper.cursor, 1);
});

test('model target restrictions reject hidden or invented entities and coordinates atomically', () => {
  for (const actions of [
    [{ kind: 'inspect', targetId: 'journal' }],
    [{ kind: 'move_to', target: { x: 23, y: 23 } }],
    [{ kind: 'approach', targetId: 'invented-window' }],
    [{ kind: 'hit', targetId: 'alice' }],
  ]) {
    const r = reply(fixture(), actions);
    assert.ok(r.result.error);
    assert.strictEqual(r.result.state, r.s);
  }
  const flavor = reply(fixture());
  assert.equal(flavor.result.error, undefined);
  assert.deepEqual(flavor.result.state.npcBrains.keeper.plan, []);
});

test('movement rechecks colliding actors and preserves a blocked path for a later world turn', () => {
  let s = world(reply(fixture(), [{ kind: 'move_to', target: { x: 3, y: 6 } }]).result.state);
  s.entities.blocker = {
    id: 'blocker',
    kind: 'npc',
    mapId: 'observatory',
    x: 3,
    y: 6,
    revision: 0,
  };
  const blocked = g.stepWorldNpcPlan(s, 'keeper');
  assert.equal(blocked.error, 'PATH_BLOCKED');
  assert.strictEqual(blocked.state, s);
  delete s.entities.blocker;
  s = g.stepWorldNpcPlan(s, 'keeper').state;
  assert.equal(g.footprintOverlaps(s.entities.keeper, s.entities.alice), false);
});

test('NPC world plans abort on encounter, map or movement-generation changes', () => {
  for (const change of [{ encounterId: 'other' }, { mapId: 'roof' }, { movementGeneration: 999 }]) {
    const s = world(reply(fixture(), [{ kind: 'move_to', target: { x: 3, y: 6 } }]).result.state);
    Object.assign(s.entities.keeper, change);
    const before = { x: s.entities.keeper.x, y: s.entities.keeper.y };
    const r = g.stepWorldNpcPlan(s, 'keeper');
    assert.deepEqual({ x: r.state.entities.keeper.x, y: r.state.entities.keeper.y }, before);
    assert.deepEqual(r.state.npcBrains.keeper.plan, []);
  }
});

test('visual attempts retain modality and do not grant damage, speech claims or companion consent', () => {
  const r = reply(fixture(), [{ kind: 'wait' }], 'attempt');
  assert.equal(r.result.error, undefined);
  const source = g.npcReplyObservation(r.s, 'alice', 'keeper', r.marker);
  assert.equal(source.kind, 'attempted');
  assert.equal(source.confidence, 'reported');
  assert.equal(r.context.claims[0].kind, 'attempted');
  assert.equal(r.s.npcUtterances.at(-1).presentationKind, 'attempt');
  assert.equal(g.projectState(r.s, 'alice').npcUtterances.length, 0);
  assert.ok(
    g.commitNpcPublicUtterance(r.s, 'keeper', {
      ...r.input,
      companionIntent: { kind: 'follow', actorId: 'alice', sourceObservationId: r.marker },
    }).error,
  );
});

test('an audible unseen NPC does not learn the contents of a silent gesture', () => {
  const s = fixture();
  s.entities.hidden = { ...s.entities.keeper, id: 'hidden', x: 7, y: 6 };
  s.npcBrains.hidden = structuredClone(s.npcBrains.keeper);
  s.maps.observatory.blocked.push({ x: 6, y: 5 });
  assert.equal(g.visible(s, s.entities.hidden, s.entities.alice), false);
  assert.equal(g.canNpcHear(s, s.entities.hidden, s.entities.alice), true);
  const speech = { channel: 'say', text: 'A silent gesture' },
    identity = { turnId: randomUUID(), segmentIndex: 0 };
  const r = g.applyNpcSpeech(s, 'alice', 'keeper', speech, {
    suppressReply: true,
    identity,
    presentationKind: 'attempt',
  });
  assert.equal(r.error, undefined);
  assert.equal(
    r.state.npcBrains.hidden.living.observations.some((o) => o.text === 'A silent gesture'),
    false,
  );
});
module.exports = { fixture, reply };

test('inspect requires an adjacent ordered endpoint; approach then inspect works and removed targets cancel the plan', () => {
  const distant = reply(fixture(), [{ kind: 'inspect', targetId: 'key' }]);
  assert.equal(distant.result.error, 'INVALID_ACTION');
  let s = world(
    reply(fixture(), [
      { kind: 'approach', targetId: 'key' },
      { kind: 'inspect', targetId: 'key' },
    ]).result.state,
  );
  const first = g.stepWorldNpcPlan(s, 'keeper');
  assert.equal(first.error, undefined);
  s = first.state;
  while (s.npcBrains.keeper.cursor === 0) s = g.stepWorldNpcPlan(nextRound(s), 'keeper').state;
  s = nextRound(s);
  const inspected = g.stepWorldNpcPlan(s, 'keeper');
  assert.equal(inspected.error, undefined);
  assert.equal(inspected.state.npcBrains.keeper.cursor, 2);
  assert.ok(inspected.events.length);
  delete s.entities.key;
  const stopped = g.stepWorldNpcPlan(s, 'keeper');
  assert.equal(stopped.error, undefined);
  assert.deepEqual(stopped.state.npcBrains.keeper.plan, []);
});

test('completed stale plans remain inert; grounded unseen entities and hidden speaker geometry stay private', () => {
  let s = world(fixture());
  s.npcBrains.keeper.plan = [];
  s.npcBrains.keeper.movementGeneration = 999;
  const inert = g.stepWorldNpcPlan(s, 'keeper');
  assert.strictEqual(inert.state, s);
  assert.deepEqual(inert.events, []);
  s = fixture();
  s.entities.hidden = {
    id: 'hidden',
    label: 'UNSEEN_LABEL',
    kind: 'item',
    mapId: 'observatory',
    x: 8,
    y: 4,
    revision: 0,
  };
  const rows = Array.from({ length: 24 }, () => '.'.repeat(24));
  rows[4] = '.......#................';
  s.maps.observatory.spatialGrounding = {
    imageRevisionId: 'fixture',
    rows,
    doors: [],
    landmarks: [],
    confidence: 'high',
  };
  const context = g.npcActionContext(s, 'keeper', ['alice', 'keeper']);
  assert.equal(
    context.targets.some((e) => e.id === 'hidden'),
    false,
  );
  assert.equal(
    context.moveTargets.some((p) => p.x === 8 && p.y === 4),
    false,
  );
  Object.assign(s.entities.alice, { x: 8, y: 4 });
  const unseen = g.npcActionContext(s, 'keeper', ['alice', 'keeper']);
  assert.equal(unseen.position, undefined);
  assert.equal(unseen.mapId, undefined);
  assert.deepEqual(unseen.targets, []);
  assert.deepEqual(unseen.moveTargets, []);
});
