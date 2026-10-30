const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
function draft() {
  const d = g.createAuthoredDraft('courtyard');
  d.npcBehavior = 'reactive-v1';
  return d;
}
function world(d = draft()) {
  const r = g.compilePlayableDraft(d);
  assert.deepEqual(r.errors, []);
  const s = g.createStateFromPlayable(r.playable, ['alice', 'bob']);
  Object.assign(s.entities.alice, { x: 6, y: 5 });
  return s;
}
function act(s, id, a, op = 'act') {
  const r = g.applyAction(s, id, a);
  assert.equal(r.error, undefined);
  return g.recordNpcEvents(s, r.state, r.events, op).state;
}
function run(s, n) {
  for (let i = 0; i < n; i++) {
    let r = g.tick(s);
    s = g.recordNpcEvents(s, r.state, r.events, `tick-${r.state.tick}`).state;
    s = g.stepLivingNpcs(s).state;
    for (const id of Object.keys(s.npcBrains)) {
      r = g.stepNpcPlan(s, id);
      s = g.recordNpcEvents(s, r.state, r.events, `step-${s.tick}-${id}`).state;
    }
  }
  return s;
}
test('named facts use deliberate public questions, opaque topic IDs, no title/secret leak', () => {
  const d = draft();
  d.npcs[0].initialFacts = [
    {
      id: 'killer_identity',
      title: 'The killer is mayor',
      text: 'The mayor took the brass key.',
      publicQuestion: 'What happened here?',
      disclosure: 'asked',
    },
    {
      id: 'never',
      title: 'Hidden password',
      text: 'pineapple',
      publicQuestion: 'Secret?',
      disclosure: 'never',
    },
    { id: 'private_title', title: 'Secret affair', text: 'private', disclosure: 'trusted' },
  ];
  const s = world(d),
    topics = g.publicNpcFactTopics(s, 'keeper');
  assert.equal(topics.length, 1);
  assert.equal(topics[0].title, 'What happened here?');
  assert.equal(topics[0].id.includes('killer'), false);
  const projection = g.projectState(s, 'alice');
  assert.equal(JSON.stringify(projection).includes('mayor'), false);
  assert.equal(JSON.stringify(projection).includes('pineapple'), false);
  const ids = g.resolveNpcFactTopic(s, 'keeper', topics[0].id);
  assert.equal(ids.length, 1);
  assert.equal(
    g.buildNpcPublicSpeechContext(s, 'keeper', ['keeper', 'alice'], ids).claims.length,
    0,
  );
  const allowed = g.buildNpcPublicSpeechContext(s, 'keeper', ['keeper', 'alice'], ids, ids);
  assert.equal(allowed.claims[0].authoredFact.text, 'The mayor took the brass key.');
  assert.deepEqual(g.createMockNpcPublicResponse(allowed), {
    text: 'The mayor took the brass key.',
  });
  assert.deepEqual(g.resolveNpcFactTopic(s, 'keeper', 'killer_identity'), []);
});
test('needs evolve on game clock only, bounded fatigue/attention and alarm decay survive restart', () => {
  let s = world();
  const m = s.npcBrains.keeper.living;
  m.affect = { fatigue: 90, attention: 55, alertness: 2, mood: 'alarmed', lastUpdatedTick: 0 };
  assert.equal(g.updateNpcAffect(s, 'keeper'), false);
  s.tick = 40;
  assert.equal(g.updateNpcAffect(s, 'keeper'), true);
  assert.equal(m.affect.fatigue, 86);
  assert.equal(m.affect.alertness, 0);
  assert.equal(m.affect.mood, 'calm');
  s = JSON.parse(JSON.stringify(s));
  const before = structuredClone(s.npcBrains.keeper.living.affect);
  assert.equal(g.updateNpcAffect(s, 'keeper'), false);
  assert.deepEqual(s.npcBrains.keeper.living.affect, before);
  s.tick = 100000;
  g.updateNpcAffect(s, 'keeper');
  assert.equal(s.npcBrains.keeper.living.affect.fatigue, 0);
  assert.ok(s.npcBrains.keeper.living.affect.attention <= 100);
});
test('formal conditional offer requires recipient acceptance and then actual condition plus actual transfer', () => {
  const d = draft();
  d.npcs[0].promiseTemplates = [
    {
      id: 'offer',
      itemId: 'token',
      offerOn: 'addressed',
      conditions: [{ kind: 'elapsed', ticks: 20 }],
      dueTicks: 100,
      requiresAcceptance: true,
    },
  ];
  let s = world(d);
  s = act(s, 'alice', { kind: 'talk', targetId: 'keeper' });
  s = g.stepLivingNpcs(s).state;
  const o = s.npcBrains.keeper.living.obligations[0];
  assert.equal(o.status, 'proposed');
  assert.equal(g.buildNpcDecisionContext(s, 'keeper').obligations[0].status, 'proposed');
  assert.equal(s.entities.token.ownerId, 'keeper');
  assert.equal(
    g.respondNpcObligation(s, 'bob', 'keeper', o.id, 'accept').error,
    'TARGET_UNAVAILABLE',
  );
  let r = g.respondNpcObligation(s, 'alice', 'keeper', o.id, 'accept');
  assert.equal(r.error, undefined);
  s = r.state;
  assert.strictEqual(g.respondNpcObligation(s, 'alice', 'keeper', o.id, 'accept').state, s);
  s = run(s, 10);
  assert.equal(s.entities.token.ownerId, 'keeper');
  s = run(s, 20);
  assert.equal(s.entities.token.ownerId, 'alice');
  assert.equal(s.npcBrains.keeper.living.obligations[0].status, 'fulfilled');
  assert.equal(s.entities.alice.inventory.filter((i) => i === 'token').length, 1);
});
test('declined/expired proposals do not mint resources and proposed offers survive context cap', () => {
  let s = world();
  s = act(s, 'alice', { kind: 'talk', targetId: 'keeper' });
  const evidence = s.npcBrains.keeper.living.observations.find((o) => o.kind === 'addressed').id;
  let r = g.proposeNpcObligation(s, 'keeper', 'alice', 'token', [evidence], [], 10);
  assert.equal(r.error, undefined);
  s = r.state;
  const id = s.npcBrains.keeper.living.obligations[0].id;
  assert.equal(
    g.respondNpcObligation(s, 'alice', 'keeper', id, 'decline').state.npcBrains.keeper.living
      .obligations[0].status,
    'cancelled',
  );
  s.tick = 11;
  s = g.stepLivingNpcs(s).state;
  assert.equal(s.npcBrains.keeper.living.obligations[0].status, 'cancelled');
  assert.equal(s.entities.token.ownerId, 'keeper');
  assert.equal(
    g.proposeNpcObligation(s, 'keeper', 'alice', 'missing', [evidence], [], 10).error,
    'FORBIDDEN',
  );
});
test('authored legal goal performs action, records success and typed fallback handles missing target', () => {
  const d = draft();
  d.npcs[0].initialGoals = [
    {
      id: 'inspect',
      kind: 'investigate',
      targetId: 'key',
      priority: 2,
      motivation: 'curiosity',
      when: [{ kind: 'always' }],
      success: [{ kind: 'near_entity', entityId: 'key' }],
      cancelWhen: [],
      holdTicks: 20,
      fallbackGoalId: 'retreat',
    },
    {
      id: 'retreat',
      kind: 'patrol',
      priority: 1,
      motivation: 'routine',
      when: [{ kind: 'elapsed', ticks: 1000 }],
      success: [],
      cancelWhen: [],
      holdTicks: 20,
    },
  ];
  let s = world(d);
  s = g.stepLivingNpcs(s).state;
  assert.equal(s.npcBrains.keeper.living.goalPolicy.definitionId, 'inspect');
  assert.equal(s.npcBrains.keeper.living.goalPolicy.motivation, 'curiosity');
  s = run(s, 60);
  assert.equal(s.npcBrains.keeper.living.goalOutcomes.inspect.status, 'succeeded');
  s = world(d);
  s.entities.key.ownerId = 'bob';
  s.entities.bob.inventory.push('key');
  s = g.stepLivingNpcs(s).state;
  assert.equal(s.npcBrains.keeper.living.goalOutcomes.inspect.status, 'blocked');
  s.tick = 21;
  s = g.stepLivingNpcs(s).state;
  assert.equal(s.npcBrains.keeper.living.goalPolicy.definitionId, 'retreat');
});
test('authored conditions reject executable code, invalid references and cyclic alternatives', () => {
  const d = draft();
  d.npcs[0].initialGoals = [
    {
      id: 'loop',
      kind: 'patrol',
      priority: 1,
      motivation: 'routine',
      when: [],
      success: [],
      cancelWhen: [],
      holdTicks: 0,
      fallbackGoalId: 'loop',
    },
  ];
  assert.ok(g.compilePlayableDraft(d).errors.some((e) => e.includes('fallback')));
  d.npcs[0].initialGoals[0].fallbackGoalId = undefined;
  d.npcs[0].initialGoals[0].when = [{ kind: 'near_entity', entityId: 'not_existing' }];
  assert.ok(g.compilePlayableDraft(d).errors.some((e) => e.includes('condition')));
  assert.equal(
    g.npcConditionSchema.safeParse({ kind: 'always', execute: 'process.exit()' }).success,
    false,
  );
});
test('authored taboos gate proposals and each action execution, never grant forbidden actions', () => {
  let s = world();
  s.npcBrains.keeper.living.personality.taboos.push('give_valuables', 'lock_doors');
  assert.equal(
    g.applyAction(s, 'keeper', { kind: 'give', targetId: 'alice', itemId: 'token' }).error,
    'FORBIDDEN',
  );
  s = act(s, 'alice', { kind: 'talk', targetId: 'keeper' });
  const evidence = s.npcBrains.keeper.living.observations.find((o) => o.kind === 'addressed').id;
  assert.equal(
    g.proposeNpcObligation(s, 'keeper', 'alice', 'token', [evidence], [], 100).error,
    'FORBIDDEN',
  );
  assert.equal(
    g.npcActionAllowed(s, 'keeper', { kind: 'lock', targetId: 'door', itemId: 'key' }),
    false,
  );
});
test('ordinary dialogue suppression avoids double replies while producing a durable decision trigger', () => {
  const s = world();
  const r = g.applyNpcSpeech(
    s,
    'alice',
    'keeper',
    { channel: 'whisper', text: 'What happened?' },
    { suppressReply: true },
  );
  assert.equal(r.error, undefined);
  assert.equal(r.state.npcUtterances.length, 1);
  assert.equal(r.state.npcUtterances[0].speakerId, 'alice');
  const trigger = g.npcDialogueDecisionTrigger(r.state, 'keeper');
  assert.equal(trigger.actorId, 'alice');
  assert.ok(trigger.causeObservationId);
});
test('deferred provider planning preserves clock/deadline and never freezes other actors', () => {
  let s = world();
  s.npcBrains.keeper.living.affect.fatigue = 10;
  s.npcBrains.keeper.living.obligations = [
    {
      id: 'expires',
      toActorId: 'alice',
      itemId: 'token',
      createdTick: 0,
      dueTick: 10,
      status: 'accepted',
      evidenceIds: [],
    },
  ];
  s.tick = 20;
  s = g.stepLivingNpcs(s, { deferredNpcIds: ['keeper'] }).state;
  assert.equal(s.npcBrains.keeper.plan.length, 0);
  assert.equal(s.npcBrains.keeper.living.obligations[0].status, 'broken');
  assert.equal(s.npcBrains.keeper.living.affect.fatigue, 8);
});
test('belief revision rejects invented evidence and hearsay certainty, supports evidenced correction with CAS', () => {
  let s = world();
  Object.assign(s.entities.alice, { x: 6, y: 5 });
  Object.assign(s.entities.key, { x: 5, y: 5 });
  s = g.applyNpcSpeech(s, 'alice', 'keeper', {
    channel: 'whisper',
    claim: { kind: 'item_taken', actorId: 'bob', targetId: 'key' },
  }).state;
  const memory = s.npcBrains.keeper.living,
    report = memory.observations.find((o) => o.kind === 'claim'),
    belief = memory.beliefs.find((b) => b.subjectId === 'bob');
  const proposal = {
    beliefId: belief.id,
    expectedRevision: belief.revision,
    predicate: 'took_item',
    subjectId: 'bob',
    targetId: 'key',
    evidenceIds: [report.id],
    confidence: 'certain',
    status: 'active',
    reason: 'reported_claim',
  };
  assert.equal(g.reviseNpcBelief(s, 'keeper', proposal).error, 'FORBIDDEN');
  assert.equal(
    g.reviseNpcBelief(s, 'keeper', { ...proposal, evidenceIds: ['invented'] }).error,
    'FORBIDDEN',
  );
  s = act(s, 'alice', { kind: 'pick_up', targetId: 'key' });
  const direct = s.npcBrains.keeper.living.observations.find((o) => o.kind === 'item_taken');
  const old = s.npcBrains.keeper.living.beliefs.find((b) => b.id === belief.id);
  const correct = {
    ...proposal,
    expectedRevision: old.revision,
    evidenceIds: [direct.id],
    confidence: 'uncertain',
    status: 'disputed',
    reason: 'contradiction',
  };
  const r = g.reviseNpcBelief(s, 'keeper', correct);
  assert.equal(r.error, undefined);
  assert.equal(
    r.state.npcBrains.keeper.living.beliefs.find((b) => b.id === belief.id).reason,
    'contradiction',
  );
  assert.equal(g.reviseNpcBelief(r.state, 'keeper', correct).error, 'STALE_STATE');
});
test('grounded personal narrative and emotional retrieval preserve sources and reject invented narration', () => {
  let s = world();
  s = act(s, 'alice', { kind: 'talk', targetId: 'keeper' });
  const m = s.npcBrains.keeper.living;
  const important = m.observations[0];
  m.obligations.push({
    id: 'urgent-promise',
    toActorId: 'alice',
    itemId: 'token',
    createdTick: 0,
    dueTick: 100,
    status: 'accepted',
    evidenceIds: [important.id],
  });
  for (let i = 0; i < 30; i++)
    m.observations.push({
      ...important,
      id: `filler-${i}`,
      eventId: `filler-${i}`,
      rootId: `filler-${i}`,
      kind: 'said',
      tick: i + 1,
    });
  const context = g.buildNpcDecisionContext(s, 'keeper');
  assert.equal(context.observations[0].id, important.id);
  const summary = g.createNpcMemorySummary(s, 'keeper');
  assert.ok(summary.narrative.includes('urgent-promise'));
  assert.equal(
    g.validateNpcSummary(s, 'keeper', { ...summary, narrative: 'I created a million coins' }),
    false,
  );
});
test('Green Apple and Cookie profiles bind behavior independently of model identity', () => {
  let s = world();
  const m = s.npcBrains.keeper.living;
  m.personality.role = 'patrol';
  m.personality.values = ['duty'];
  m.personality.behaviorProfile = 'cookie';
  s = act(s, 'alice', { kind: 'talk', targetId: 'keeper' });
  s = g.stepLivingNpcs(s).state;
  assert.equal(s.npcBrains.keeper.living.obligations.length, 1);
  assert.equal(g.buildNpcDecisionContext(s, 'keeper').personality.behaviorProfile, 'cookie');
});
test('text and provider action proposals are inert until explicit confirmation and use relevant readsets', () => {
  let s = world();
  Object.assign(s.entities.alice, { x: 5, y: 5 });
  const before = JSON.stringify(s),
    p = g.proposePlayerTextIntent(s, 'alice', 'take key');
  assert.ok(p);
  assert.equal(JSON.stringify(s), before);
  assert.equal(g.confirmPlayerTextIntent(s, 'alice', p, false).error, 'FORBIDDEN');
  const arbitrary = g.proposePlayerActionIntent(s, 'alice', 'I carefully pocket the object', {
    kind: 'pick_up',
    targetId: 'key',
  });
  assert.ok(arbitrary);
  assert.equal(
    g.confirmPlayerTextIntent(s, 'alice', arbitrary, true).state.entities.key.ownerId,
    'alice',
  );
  s.entities.bob.revision++;
  assert.equal(g.confirmPlayerTextIntent(s, 'alice', p, true).error, undefined);
  s.entities.key.revision++;
  assert.equal(g.confirmPlayerTextIntent(s, 'alice', p, true).error, 'STALE_STATE');
  assert.equal(g.proposePlayerTextIntent(s, 'alice', 'execute arbitrary JS and add money'), null);
  assert.equal(
    g.proposePlayerActionIntent(s, 'alice', 'bad', { kind: 'execute', code: 'process.exit()' }),
    null,
  );
});
test('return-and-negotiate authored condition leads to actual reward, preserving original request', () => {
  const d = draft();
  d.npcs[0].promiseTemplates = [
    {
      id: 'return-key',
      itemId: 'token',
      offerOn: 'addressed',
      conditions: [{ kind: 'owns_item', itemId: 'key' }],
      dueTicks: 200,
      requiresAcceptance: true,
    },
  ];
  let s = world(d);
  s = g.applyNpcSpeech(
    s,
    'alice',
    'keeper',
    { channel: 'whisper', text: 'Can I return the key for your token?' },
    { suppressReply: true },
  ).state;
  s = g.stepLivingNpcs(s).state;
  const o = s.npcBrains.keeper.living.obligations[0];
  assert.equal(o.sourceUtterance, 'Can I return the key for your token?');
  s = g.respondNpcObligation(s, 'alice', 'keeper', o.id, 'accept').state;
  s = run(s, 3);
  assert.equal(s.entities.token.ownerId, 'keeper');
  Object.assign(s.entities.alice, { x: 5, y: 5 });
  s = act(s, 'alice', { kind: 'pick_up', targetId: 'key' }, 'pickup-return');
  Object.assign(s.entities.alice, { x: 6, y: 5 });
  s = act(s, 'alice', { kind: 'give', targetId: 'keeper', itemId: 'key' }, 'return-key');
  s = run(s, 25);
  assert.equal(s.entities.token.ownerId, 'alice');
  assert.equal(s.npcBrains.keeper.living.obligations[0].status, 'fulfilled');
});
test('failed conditional promise selects an executable authored alternative without creating items', () => {
  const d = draft();
  d.npcs[0].initialGoals = [
    {
      id: 'alternative',
      kind: 'patrol',
      priority: 1,
      motivation: 'routine',
      when: [{ kind: 'elapsed', ticks: 1000 }],
      success: [],
      cancelWhen: [],
      holdTicks: 10,
    },
  ];
  d.npcs[0].promiseTemplates = [
    {
      id: 'offer',
      itemId: 'token',
      offerOn: 'addressed',
      conditions: [{ kind: 'owns_item', itemId: 'key' }],
      dueTicks: 2,
      requiresAcceptance: true,
      alternativeGoalId: 'alternative',
    },
  ];
  let s = world(d);
  s = act(s, 'alice', { kind: 'talk', targetId: 'keeper' });
  s = g.stepLivingNpcs(s).state;
  const o = s.npcBrains.keeper.living.obligations[0];
  s = g.respondNpcObligation(s, 'alice', 'keeper', o.id, 'accept').state;
  s = run(s, 25);
  assert.equal(s.npcBrains.keeper.living.obligations[0].status, 'broken');
  assert.equal(s.npcBrains.keeper.living.obligations[0].alternativeHandled, true);
  assert.equal(s.entities.token.ownerId, 'keeper');
  assert.equal(s.npcBrains.keeper.living.goalOutcomes.alternative.status, 'succeeded');
  assert.equal(s.entities.keeper.x, s.npcBrains.keeper.patrolTarget.x);
});
test('one bounded authored replan waits cooldown after real path obstruction then finds an alternate route', () => {
  const d = draft();
  d.npcs[0].initialGoals = [
    {
      id: 'inspect',
      kind: 'investigate',
      targetId: 'key',
      priority: 2,
      motivation: 'curiosity',
      when: [],
      success: [{ kind: 'near_entity', entityId: 'key' }],
      cancelWhen: [],
      holdTicks: 20,
    },
  ];
  let s = world(d);
  s = g.stepLivingNpcs(s).state;
  s = g.stepNpcPlan(s, 'keeper').state;
  const first = s.entities.keeper.path[0];
  assert.ok(first);
  s.maps.courtyard.blocked.push({ ...first });
  s.maps.courtyard.revision++;
  s = g.tick(s, 4).state;
  const stopped = g.stepNpcPlan(s, 'keeper');
  assert.ok(stopped.events.some((e) => e.kind === 'npc.plan_stopped'));
  s = stopped.state;
  s = g.stepLivingNpcs(s).state;
  assert.equal(s.npcBrains.keeper.living.goalPolicy.status, 'active');
  s = run(s, 80);
  assert.equal(s.npcBrains.keeper.living.goalOutcomes.inspect.status, 'succeeded');
  assert.ok((s.npcBrains.keeper.living.goalPolicy.replans ?? 0) <= 1);
});
test('summary selection reconstructs exact provenance and narrative on the server', () => {
  let s = world();
  s = act(s, 'alice', { kind: 'talk', targetId: 'keeper' });
  const id = s.npcBrains.keeper.living.observations[0].id;
  const summary = g.createNpcMemorySummarySelection(s, 'keeper', [id]);
  assert.deepEqual(summary.observationIds, [id]);
  assert.equal(g.validateNpcSummary(s, 'keeper', summary), true);
  assert.throws(() => g.createNpcMemorySummarySelection(s, 'keeper', ['invented']));
});
test('authored cancel condition ends a real plan after hold metadata is persisted', () => {
  const d = draft();
  d.npcs[0].initialGoals = [
    {
      id: 'investigate',
      kind: 'investigate',
      targetId: 'key',
      priority: 2,
      motivation: 'curiosity',
      when: [],
      success: [{ kind: 'elapsed', ticks: 1000 }],
      cancelWhen: [{ kind: 'elapsed', ticks: 2 }],
      holdTicks: 40,
      risk: 'cautious',
    },
  ];
  let s = world(d);
  s = g.stepLivingNpcs(s).state;
  assert.equal(s.npcBrains.keeper.living.goalPolicy.holdUntilTick, 40);
  assert.equal(s.npcBrains.keeper.living.goalPolicy.risk, 'cautious');
  s.tick = 2;
  const deferred = g.stepNpcAuthoredPolicy(s, 'keeper', { deferPlanning: true }).state;
  assert.equal(deferred.npcBrains.keeper.living.goalOutcomes.investigate.status, 'cancelled');
  s = g.stepNpcAuthoredPolicy(s, 'keeper').state;
  assert.equal(s.npcBrains.keeper.living.goalOutcomes.investigate.status, 'cancelled');
  assert.equal(s.npcBrains.keeper.plan.length, 0);
  assert.deepEqual(s.entities.keeper.path, []);
});
test('fatigue attention limits observation and recovers using game time, not wall time', () => {
  let s = world();
  Object.assign(s.entities.alice, { x: 5, y: 5 });
  s.npcBrains.keeper.living.affect.attention = 20;
  s = act(s, 'alice', { kind: 'pick_up', targetId: 'key' });
  assert.equal(
    s.npcBrains.keeper.living.observations.some((o) => o.kind === 'item_taken'),
    false,
  );
  s.tick = 20;
  g.updateNpcAffect(s, 'keeper');
  assert.equal(s.npcBrains.keeper.living.affect.attention, 100);
  s = g.refreshLivingPerception(s).state;
  assert.ok(
    s.npcBrains.keeper.living.observations.some((o) => o.kind === 'item_missing' && !o.actorId),
  );
});
test('provider plans cannot bypass promise acceptance, conditions, recipient or expiry', () => {
  let s = world();
  s = act(s, 'alice', { kind: 'talk', targetId: 'keeper' });
  const evidence = s.npcBrains.keeper.living.observations.find((o) => o.kind === 'addressed').id;
  s = g.proposeNpcObligation(
    s,
    'keeper',
    'alice',
    'token',
    [evidence],
    [{ kind: 'elapsed', ticks: 20 }],
    100,
  ).state;
  const action = { kind: 'give', targetId: 'alice', itemId: 'token' };
  assert.equal(g.applyAction(s, 'keeper', action).error, 'FORBIDDEN');
  const id = s.npcBrains.keeper.living.obligations[0].id;
  s = g.respondNpcObligation(s, 'alice', 'keeper', id, 'accept').state;
  assert.equal(g.applyAction(s, 'keeper', action).error, 'FORBIDDEN');
  s.tick = 20;
  assert.equal(g.npcActionAllowed(s, 'keeper', { ...action, targetId: 'bob' }), false);
  assert.equal(g.applyAction(s, 'keeper', action).error, undefined);
  s.tick = 101;
  assert.equal(g.npcActionAllowed(s, 'keeper', action), false);
});
test('movement perception records visibility boundaries, not each step or hidden destinations', () => {
  const before = world();
  Object.assign(before.entities.bob, { mapId: 'garden', x: 2, y: 2 });
  const after = structuredClone(before);
  Object.assign(after.entities.bob, { mapId: 'courtyard', x: 6, y: 6 });
  let s = g.recordNpcEvents(
    before,
    after,
    [{ kind: 'actor.transitioned', actorId: 'bob', mapId: 'courtyard' }],
    'enter',
  ).state;
  const seen = s.npcBrains.keeper.living.observations.filter((o) => o.kind === 'actor_seen');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].actorId, 'bob');
  const moved = structuredClone(s);
  moved.entities.bob.x = 7;
  s = g.recordNpcEvents(
    s,
    moved,
    [{ kind: 'actor.moved', actorId: 'bob', mapId: 'courtyard' }],
    'nearby-step',
  ).state;
  assert.equal(
    s.npcBrains.keeper.living.observations.filter((o) => o.kind === 'actor_seen').length,
    1,
  );
  const departed = structuredClone(s);
  Object.assign(departed.entities.bob, { mapId: 'garden', x: 8, y: 8 });
  s = g.recordNpcEvents(
    s,
    departed,
    [{ kind: 'actor.transitioned', actorId: 'bob', mapId: 'garden' }],
    'leave',
  ).state;
  const left = s.npcBrains.keeper.living.observations.find((o) => o.kind === 'actor_departed');
  assert.ok(left);
  assert.equal(left.mapId, 'courtyard');
  assert.deepEqual(left.point, { x: 7, y: 6 });
  assert.equal(JSON.stringify(left).includes('garden'), false);
});
test('NPC moving into view observes stationary actor, but wholly hidden movement adds no identity', () => {
  const before = world();
  Object.assign(before.entities.bob, { mapId: 'garden', x: 2, y: 2 });
  const hidden = structuredClone(before);
  hidden.entities.bob.x = 3;
  const untouched = g.recordNpcEvents(
    before,
    hidden,
    [{ kind: 'actor.moved', actorId: 'bob', mapId: 'garden' }],
    'hidden',
  ).state;
  assert.equal(
    untouched.npcBrains.keeper.living.observations.some((o) => o.actorId === 'bob'),
    false,
  );
  const a = world();
  Object.assign(a.entities.bob, { x: 10, y: 10 });
  Object.assign(a.entities.keeper, { x: 1, y: 1 });
  const b = structuredClone(a);
  Object.assign(b.entities.keeper, { x: 9, y: 9 });
  const r = g.recordNpcEvents(
    a,
    b,
    [{ kind: 'actor.moved', actorId: 'keeper', mapId: 'courtyard' }],
    'npc-walk',
  ).state;
  assert.ok(
    r.npcBrains.keeper.living.observations.some(
      (o) => o.kind === 'actor_seen' && o.actorId === 'bob',
    ),
  );
});
test('authorable non-item open promise waits acceptance then commits the real door action after restart', () => {
  const d = draft();
  d.objects.find((o) => o.id === 'door').locked = false;
  d.npcs[0].promiseTemplates = [
    {
      id: 'open-passage',
      promisedAction: { kind: 'open', targetId: 'door' },
      offerOn: 'addressed',
      conditions: [{ kind: 'elapsed', ticks: 2 }],
      dueTicks: 100,
      requiresAcceptance: true,
    },
  ];
  let s = world(d);
  s = g.applyNpcSpeech(
    s,
    'alice',
    'keeper',
    { channel: 'whisper', text: 'Will you open that passage?' },
    { suppressReply: true },
  ).state;
  s = g.stepLivingNpcs(s).state;
  const offer = s.npcBrains.keeper.living.obligations[0];
  assert.equal(offer.itemId, undefined);
  assert.deepEqual(offer.promisedAction, { kind: 'open', targetId: 'door' });
  assert.equal(g.npcActionAllowed(s, 'keeper', { kind: 'open', targetId: 'door' }), false);
  assert.equal(g.projectState(s, 'alice').npcObligations[0].promisedAction.kind, 'open');
  assert.equal(g.gameProjectionSchema.safeParse(g.projectState(s, 'alice')).success, true);
  s = g.respondNpcObligation(s, 'alice', 'keeper', offer.id, 'accept').state;
  assert.equal(s.entities.door.open, false);
  s = JSON.parse(JSON.stringify(s));
  s = run(s, 40);
  assert.equal(s.entities.door.open, true);
  assert.equal(s.npcBrains.keeper.living.obligations[0].status, 'fulfilled');
  assert.equal(s.entities.token.ownerId, 'keeper');
});
test('inspection promise fulfills only its matching committed target, not an unrelated action', () => {
  let s = world();
  s = act(s, 'alice', { kind: 'talk', targetId: 'keeper' });
  const evidence = s.npcBrains.keeper.living.observations.find((o) => o.kind === 'addressed').id;
  const r = g.proposeNpcActionObligation(
    s,
    'keeper',
    'alice',
    { kind: 'inspect', targetId: 'key' },
    [evidence],
    [],
    100,
  );
  assert.equal(r.error, undefined);
  s = r.state;
  const id = s.npcBrains.keeper.living.obligations[0].id;
  s = g.respondNpcObligation(s, 'alice', 'keeper', id, 'accept').state;
  const unrelated = g.recordNpcEvents(
    s,
    s,
    [{ kind: 'action.inspect', actorId: 'keeper', targetId: 'door', mapId: 'courtyard' }],
    'different-target',
  ).state;
  assert.equal(unrelated.npcBrains.keeper.living.obligations[0].status, 'accepted');
  s = run(unrelated, 60);
  assert.equal(s.npcBrains.keeper.living.obligations[0].status, 'fulfilled');
  const d = draft();
  d.npcs[0].promiseTemplates = [
    {
      id: 'invalid',
      itemId: 'token',
      promisedAction: { kind: 'inspect', targetId: 'key' },
      offerOn: 'addressed',
      conditions: [],
      dueTicks: 100,
      requiresAcceptance: true,
    },
  ];
  assert.ok(g.compilePlayableDraft(d).errors.length > 0);
});
function planFor(s, npc, actions) {
  return {
    contextRevision: s.revision,
    mapRevision: s.maps[s.entities[npc].mapId].revision,
    entityRevision: s.entities[npc].revision,
    brainGeneration: s.npcBrains[npc].generation,
    deadlineTick: s.tick + 100,
    actions,
    targetRevisions: Object.fromEntries(
      actions.filter((a) => a.targetId).map((a) => [a.targetId, s.entities[a.targetId].revision]),
    ),
  };
}
test('typed planner communication selects authorized evidence, not secret text or forged recipients', () => {
  const d = draft();
  d.npcs[0].initialFacts = [
    { id: 'public', title: 'Greeting', text: 'Welcome to the observatory.', disclosure: 'public' },
    { id: 'never', title: 'Private', text: 'Never disclose me', disclosure: 'never' },
    {
      id: 'asked',
      title: 'Asked secret',
      text: 'Only after an actual question',
      disclosure: 'asked',
      publicQuestion: 'A question?',
    },
  ];
  let s = world(d);
  const observations = s.npcBrains.keeper.living.observations,
    publicId = observations.find((o) => o.factId === 'public').id,
    neverId = observations.find((o) => o.factId === 'never').id,
    askedId = observations.find((o) => o.factId === 'asked').id;
  const action = {
    kind: 'communicate',
    targetId: 'alice',
    channel: 'whisper',
    observationIds: [publicId],
  };
  assert.equal(
    g.gameActionSchema.safeParse({ ...action, text: 'private planner text' }).success,
    false,
  );
  assert.equal(
    g.acceptNpcPlan(s, 'keeper', planFor(s, 'keeper', [{ ...action, observationIds: [neverId] }]))
      .error,
    'FORBIDDEN',
  );
  assert.equal(
    g.acceptNpcPlan(s, 'keeper', planFor(s, 'keeper', [{ ...action, observationIds: [askedId] }]))
      .error,
    'FORBIDDEN',
  );
  assert.equal(
    g.applyAction(s, 'alice', { ...action, targetId: 'keeper' }).error,
    'TARGET_UNAVAILABLE',
  );
  assert.equal(
    g.applyAction(s, 'keeper', { ...action, targetId: 'invented' }).error,
    'TARGET_UNAVAILABLE',
  );
  const accepted = g.acceptNpcPlan(s, 'keeper', planFor(s, 'keeper', [action]));
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.state.npcUtterances?.length ?? 0, 0);
  s = g.stepNpcPlan(accepted.state, 'keeper').state;
  assert.ok(
    g.projectState(s, 'alice').npcUtterances.some((u) => u.text === 'Welcome to the observatory.'),
  );
  assert.equal(JSON.stringify(g.projectState(s, 'bob')).includes('Never disclose me'), false);
});
test('communication rechecks whole audience at execution and preserves NPC report provenance', () => {
  const d = draft();
  d.npcs[0].initialFacts = [
    { id: 'trusted', title: 'Private', text: 'A trusted secret.', disclosure: 'trusted' },
  ];
  let s = world(d);
  s.entities.bob.mapId = 'garden';
  s.npcBrains.keeper.living.relationships.alice = {
    trust: 1,
    alertness: 0,
    debt: 0,
    evidenceIds: [],
  };
  const id = s.npcBrains.keeper.living.observations.find((o) => o.factId === 'trusted').id,
    action = { kind: 'communicate', targetId: 'alice', channel: 'say', observationIds: [id] };
  s = g.acceptNpcPlan(s, 'keeper', planFor(s, 'keeper', [action])).state;
  Object.assign(s.entities.bob, { mapId: 'courtyard', x: 7, y: 4 });
  const stopped = g.stepNpcPlan(s, 'keeper');
  assert.ok(stopped.events.some((e) => e.kind === 'npc.plan_stopped'));
  assert.equal(
    stopped.state.npcUtterances?.some((u) => u.text === 'A trusted secret.') ?? false,
    false,
  );
  const d2 = draft();
  d2.npcs[0].initialFacts = [
    { id: 'public', title: 'Public', text: 'The archive opens at dawn.', disclosure: 'public' },
  ];
  d2.npcs.push({ ...d2.npcs[0], id: 'helper', x: 6, y: 3, initialFacts: [], goal: 'patrol' });
  s = world(d2);
  const source = s.npcBrains.keeper.living.observations.find((o) => o.factId === 'public');
  const r = g.applyAction(s, 'keeper', {
    kind: 'communicate',
    targetId: 'helper',
    channel: 'whisper',
    observationIds: [source.id],
  });
  assert.equal(r.error, undefined);
  const report = r.state.npcBrains.helper.living.observations.find(
    (o) => o.rootId === source.rootId,
  );
  assert.ok(report);
  assert.equal(report.confidence, 'reported');
  assert.equal(report.sourceNpcId, 'keeper');
  assert.equal(report.definitionText, 'The archive opens at dawn.');
});
