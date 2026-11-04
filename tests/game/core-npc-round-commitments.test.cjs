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
function world(s) {
  const r = g.endPlayerTurn(s, 'alice', g.turnFence(s));
  assert.equal(r.error, undefined);
  return r.state;
}
function promisedMovement() {
  const speech = { channel: 'say', text: 'Please come and look.' };
  const identity = { turnId: randomUUID(), segmentIndex: 0 };
  const s = g.applyNpcSpeech(fixture(), 'alice', 'keeper', speech, {
    suppressReply: true,
    identity,
  }).state;
  const source = g.admittedNpcSpeechObservationId(s, 'alice', 'keeper', speech, identity);
  const context = g.buildNpcPublicSpeechContext(s, 'keeper', ['keeper', 'alice'], [source]);
  const r = g.commitNpcPublicUtterance(s, 'keeper', {
    text: 'I will come and look.',
    channel: 'say',
    recipientId: 'alice',
    observationIds: [source],
    replyToObservationId: source,
    contextHash: g.npcContextFingerprint(context),
    actionIntent: {
      sourceObservationId: source,
      actions: [{ kind: 'move_to', target: { x: 3, y: 6 } }],
    },
  });
  assert.equal(r.error, undefined);
  return r.state;
}
function reconsider(s, npcId = 'keeper') {
  const proposal = g.createMockNpcPlan(s, npcId);
  const r = g.acceptNpcPlan(s, npcId, proposal);
  assert.equal(r.error, undefined);
  return r.state;
}
function obligation(s, overrides = {}) {
  s.npcBrains.keeper.living.obligations = [
    {
      id: 'accepted-inspection',
      toActorId: 'alice',
      createdTick: s.tick,
      dueTick: s.tick + 200,
      status: 'accepted',
      evidenceIds: [],
      promisedAction: { kind: 'inspect', targetId: 'key' },
      conditions: [],
      ...overrides,
    },
  ];
  return s;
}

test('fresh mock decisions preserve a public movement commitment across bounded rounds and reload', () => {
  let s = world(promisedMovement());
  const source = structuredClone(s.npcBrains.keeper.planSource);
  const expected = structuredClone(s.npcBrains.keeper.plan);
  for (let round = 0; round < 6; round++) {
    const before = structuredClone(s);
    const proposal = g.createMockNpcPlan(s, 'keeper');
    assert.deepEqual(s, before, 'planning is read-only');
    assert.deepEqual(proposal.actions, expected);
    assert.deepEqual(proposal.turnFence, g.turnFence(s));
    s = reconsider(s);
    assert.deepEqual(s.npcBrains.keeper.planSource, source);
    const stepped = g.stepWorldNpcPlan(s, 'keeper');
    assert.equal(stepped.error, undefined);
    s = stepped.state;
    assert.equal(g.footprintOverlaps(s.entities.keeper, s.entities.alice), false);
    if (s.npcBrains.keeper.cursor === s.npcBrains.keeper.plan.length) break;
    assert.equal(s.npcBrains.keeper.cursor, 0);
    s = JSON.parse(JSON.stringify(s));
    s = world(g.finishWorldPhase(s, g.turnFence(s)).state);
  }
  assert.deepEqual({ x: s.entities.keeper.x, y: s.entities.keeper.y }, { x: 3, y: 6 });
  assert.equal(g.buildNpcDecisionContext(s, 'keeper').currentPlan, null);
});

test('private current plan contains remaining intent and selected original evidence, never a public projection', () => {
  const s = world(promisedMovement());
  const brain = s.npcBrains.keeper;
  brain.plan.unshift({ kind: 'wait' });
  brain.cursor = 1;
  const original = brain.living.observations.find(
    (o) => o.id === brain.planSource.sourceObservationId,
  );
  for (let i = 0; i < 20; i++) {
    const id = `competing-goal-evidence-${i}`;
    brain.living.observations.push({ ...original, id, tick: s.tick + i + 1 });
    brain.living.goal.evidenceIds.push(id);
  }
  const context = g.buildNpcDecisionContext(s, 'keeper');
  assert.deepEqual(context.currentPlan, { actions: brain.plan.slice(1), source: brain.planSource });
  assert.ok(context.observations.some((o) => o.id === original.id));
  assert.equal(context.observations.length, 16);
  context.currentPlan.actions[0].target.x = 19;
  assert.equal(brain.plan[1].target.x, 3, 'private context is detached');
  assert.equal(JSON.stringify(g.projectState(s, 'alice')).includes('currentPlan'), false);
  assert.equal(JSON.stringify(g.projectState(s, 'alice')).includes('planSource'), false);
  assert.equal(
    JSON.stringify(g.buildNpcPublicSpeechContext(s, 'keeper', ['keeper', 'alice'], [])).includes(
      'currentPlan',
    ),
    false,
  );
  const changed = g.acceptNpcPlan(s, 'keeper', {
    ...g.createMockNpcPlan(s, 'keeper'),
    actions: [{ kind: 'wait' }],
    targetRevisions: {},
  });
  assert.equal(changed.error, undefined);
  assert.equal(
    changed.state.npcBrains.keeper.planSource,
    undefined,
    'a new choice does not inherit old evidence',
  );
});

test('mandatory mock reconsideration rejects stale maps, movement, evidence and unavailable or forbidden actions', () => {
  const changes = [
    (s) => {
      s.npcBrains.keeper.planMapId = 'roof';
    },
    (s) => {
      s.npcBrains.keeper.movementGeneration = 999;
    },
    (s) => {
      s.npcBrains.keeper.planSource.sourceObservationId = 'missing';
    },
    (s) => {
      s.npcBrains.keeper.planSource.actorId = 'another-player';
    },
    (s) => {
      s.npcBrains.keeper.living.observations = [];
    },
    (s) => {
      s.npcBrains.keeper.plan = [{ kind: 'inspect', targetId: 'missing' }];
    },
    (s) => {
      s.npcBrains.keeper.plan = [{ kind: 'inspect', targetId: 'journal' }];
    },
    (s) => {
      s.npcBrains.keeper.plan = [{ kind: 'pick_up', targetId: 'key' }];
    },
    (s) => {
      s.npcBrains.keeper.plan = [{ kind: 'give', targetId: 'alice', itemId: 'key' }];
    },
    (s) => {
      s.npcBrains.keeper.plan = [{ kind: 'hit', targetId: 'alice' }];
      s.npcBrains.keeper.living.personality.taboos.push('harm');
    },
    (s) => {
      s.npcBrains.keeper.plan = [
        { kind: 'communicate', targetId: 'alice', channel: 'say', observationIds: ['missing'] },
      ];
    },
  ];
  for (const change of changes) {
    const s = world(promisedMovement());
    change(s);
    const previous = structuredClone(s.npcBrains.keeper.plan);
    assert.equal(g.buildNpcDecisionContext(s, 'keeper').currentPlan, null);
    const proposal = g.createMockNpcPlan(s, 'keeper');
    assert.notDeepEqual(proposal.actions, previous);
    assert.equal(g.acceptNpcPlan(s, 'keeper', proposal).error, undefined);
  }
});

test('world reconsideration retains permitted staged attacks and refreshes target revision fences', () => {
  let s = world(fixture());
  const brain = s.npcBrains.keeper;
  brain.plan = [{ kind: 'wait' }, { kind: 'hit', targetId: 'alice' }];
  brain.cursor = 1;
  delete brain.planMapId;
  delete brain.movementGeneration;
  const proposal = g.createMockNpcPlan(s, 'keeper');
  assert.deepEqual(proposal.actions, [{ kind: 'hit', targetId: 'alice' }]);
  assert.equal(proposal.targetRevisions.alice, s.entities.alice.revision);
  const stale = structuredClone(s);
  stale.entities.alice.revision++;
  assert.equal(g.acceptNpcPlan(stale, 'keeper', proposal).error, 'STALE_STATE');
  s = reconsider(s);
  const attack = g.stepWorldNpcPlan(s, 'keeper');
  assert.equal(attack.error, undefined);
  assert.equal(attack.state.turnController.phase, 'reaction');
});

test('world mock chooses a condition-ready accepted obligation before patrol', () => {
  const s = world(obligation(fixture()));
  const proposal = g.createMockNpcPlan(s, 'keeper');
  assert.equal(proposal.actions[0].kind, 'move_to');
  assert.deepEqual(proposal.actions.at(-1), { kind: 'inspect', targetId: 'key' });
  assert.equal(proposal.targetRevisions.key, s.entities.key.revision);
  const r = g.stepWorldNpcPlan(reconsider(s), 'keeper');
  assert.equal(r.error, undefined);
  assert.notDeepEqual(
    { x: r.state.entities.keeper.x, y: r.state.entities.keeper.y },
    { x: s.entities.keeper.x, y: s.entities.keeper.y },
  );
});

test('mock never revives proposed, expired, unmet, unsupported or ungrounded obligations', () => {
  for (const overrides of [
    { status: 'proposed' },
    { status: 'fulfilled' },
    { dueTick: 0 },
    { evidenceIds: ['missing-evidence'] },
    { conditions: [{ kind: 'elapsed', ticks: 100 }] },
    { promisedAction: { kind: 'inspect', targetId: 'missing' } },
    { promisedAction: { kind: 'pick_up', targetId: 'key' } },
    { promisedAction: undefined, itemId: 'key' },
  ]) {
    const s = world(obligation(fixture(), overrides));
    const proposal = g.createMockNpcPlan(s, 'keeper');
    const withoutObligation = structuredClone(s);
    withoutObligation.npcBrains.keeper.living.obligations = [];
    assert.deepEqual(proposal.actions, g.createMockNpcPlan(withoutObligation, 'keeper').actions);
    assert.equal(g.acceptNpcPlan(s, 'keeper', proposal).error, undefined);
  }
});

test('legacy realtime requests retain their pending-plan WRONG_MODE boundary', () => {
  const s = promisedMovement();
  delete s.turnController;
  assert.equal(g.acceptNpcPlan(s, 'keeper', g.createMockNpcPlan(s, 'keeper')).error, 'WRONG_MODE');
});

test('private decision context safely omits absent or malformed legacy plan state', () => {
  for (const legacy of [
    {},
    { plan: null, cursor: 0 },
    { plan: {}, cursor: 0 },
    { plan: 'wait', cursor: 0 },
    { plan: [{ kind: 'wait' }] },
    { plan: [{ kind: 'wait' }], cursor: null },
    { plan: [{ kind: 'wait' }], cursor: '0' },
    { plan: [{ kind: 'wait' }], cursor: -1 },
    { plan: [{ kind: 'wait' }], cursor: 0.5 },
    { plan: [{ kind: 'wait' }], cursor: NaN },
    { plan: [{ kind: 'wait' }], cursor: Infinity },
    { plan: [{ kind: 'wait' }], cursor: 1 },
    { plan: [], cursor: 0 },
    { plan: [null], cursor: 0 },
  ]) {
    const s = fixture();
    s.npcBrains.keeper = { living: s.npcBrains.keeper.living, ...legacy };
    const before = structuredClone(s);
    assert.equal(g.currentNpcPlan(s, 'keeper'), null);
    assert.equal(g.buildNpcDecisionContext(s, 'keeper').currentPlan, null);
    assert.deepEqual(s, before);
  }
});
