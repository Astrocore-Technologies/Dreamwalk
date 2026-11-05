const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
const thought = {
  motive: 'Keep watch without intruding.',
  belief: 'The visitor may want privacy.',
  intent: 'Wait here and reconsider next round.',
  innerThought: 'I can give them a moment while I watch the doorway.',
  reconsiderAfterRounds: 1,
};
function world() {
  const d = g.createAuthoredDraft('courtyard');
  d.npcBehavior = 'reactive-v1';
  d.turnRules = g.turnRulesSchema.parse({});
  const compiled = g.compilePlayableDraft(d);
  assert.deepEqual(compiled.errors, []);
  const s = g.createStateFromPlayable(compiled.playable, ['alice']);
  return g.endPlayerTurn(s, 'alice', g.turnFence(s)).state;
}
function proposal(s) {
  return {
    ...g.createMockNpcPlan(s, 'keeper'),
    actions: [{ kind: 'wait' }],
    targetRevisions: {},
    cognition: thought,
    knowledgeRevision: s.npcBrains.keeper.living.knowledgeRevision,
  };
}
test('fictional cognition is bounded, optional for old plans, and cannot carry reader ACLs', () => {
  assert.equal(g.npcCognitionSchema.safeParse(thought).success, true);
  for (const bad of [
    { ...thought, innerThought: 'x'.repeat(1401) },
    { ...thought, reconsiderAfterRounds: 4 },
    { ...thought, audienceIds: ['alice'] },
    { ...thought, hiddenReasoning: 'not character fiction' },
  ])
    assert.equal(g.npcCognitionSchema.safeParse(bad).success, false);
  const s = world();
  assert.equal(g.npcPlanProposalSchema.safeParse(g.createMockNpcPlan(s, 'keeper')).success, true);
});
test('a developed fictional paragraph survives admission and persistence without entering public state', () => {
  const innerThought = (
    'The visitor sounds calmer now, though I am still unsettled by the argument. ' +
    'I want to hear the warning without answering for anyone else. ' +
    'There may be a real concern here, but I cannot tell yet. ' +
    'For now I can listen and leave them room to explain. '
  )
    .repeat(3)
    .trim();
  assert.ok(innerThought.length > 480 && innerThought.length <= 1400);
  const state = world();
  const result = g.acceptNpcPlan(state, 'keeper', {
    ...proposal(state),
    cognition: { ...thought, innerThought },
  });
  assert.equal(result.error, undefined);
  const restored = JSON.parse(JSON.stringify(result.state));
  assert.equal(restored.npcBrains.keeper.living.cognition.innerThought, innerThought);
  assert.equal(JSON.stringify(g.projectState(restored, 'alice')).includes(innerThought), false);
  assert.equal(JSON.stringify(result.events).includes(innerThought), false);
});
test('world-fenced fresh decision replaces a plan despite tick cooldown and persists private RP', () => {
  const s = world();
  s.npcBrains.keeper.plan = [{ kind: 'wait' }];
  s.npcBrains.keeper.nextDecisionTick = s.tick + 100;
  const r = g.acceptNpcPlan(s, 'keeper', proposal(s));
  assert.equal(r.error, undefined);
  assert.equal(r.state.npcBrains.keeper.living.cognition.innerThought, thought.innerThought);
  assert.equal(r.state.npcBrains.keeper.living.cognition.roundId, s.turnController.roundId);
  assert.equal(r.state.npcBrains.keeper.living.cognition.audienceIds, undefined);
  assert.equal(
    JSON.stringify(g.projectState(r.state, 'alice')).includes(thought.innerThought),
    false,
  );
  assert.equal(JSON.stringify(r.events).includes(thought.innerThought), false);
  const old = proposal(s);
  delete old.turnFence;
  assert.equal(g.acceptNpcPlan(s, 'keeper', old).error, 'WRONG_MODE');
});
test('stale round, source and knowledge fences reject cognition without mutation', () => {
  const s = world();
  const p = proposal(s);
  p.turnFence.roundId = 'older-round';
  assert.equal(g.acceptNpcPlan(s, 'keeper', p).error, 'STALE_STATE');
  const bad = proposal(s);
  bad.knowledgeRevision++;
  assert.equal(g.acceptNpcPlan(s, 'keeper', bad).error, 'STALE_STATE');
  const r = g.recordNpcCognition(s, 'keeper', thought, {
    knowledgeRevision: s.npcBrains.keeper.living.knowledgeRevision,
    sourceObservationId: 'another-npc-private-observation',
  });
  assert.equal(r.error, 'STALE_STATE');
  assert.strictEqual(r.state, s);
  assert.equal(s.npcBrains.keeper.living.cognition, undefined);
});
test('only the selected NPC decision context sees previous thought; public speech and projections do not', () => {
  const s = world();
  const r = g.acceptNpcPlan(s, 'keeper', proposal(s));
  const context = g.buildNpcDecisionContext(r.state, 'keeper');
  assert.equal(context.previousCognition.innerThought, thought.innerThought);
  assert.deepEqual(context.actionContext.position, {
    x: s.entities.keeper.x,
    y: s.entities.keeper.y,
  });
  const speech = g.buildNpcPublicSpeechContext(r.state, 'keeper', ['keeper', 'alice'], []);
  assert.equal(JSON.stringify(speech).includes(thought.innerThought), false);
  const clone = JSON.parse(JSON.stringify(r.state));
  assert.equal(clone.npcBrains.keeper.living.cognition.innerThought, thought.innerThought);
});
test('authored cognition cannot create possessions or bypass existing action policy', () => {
  const s = world();
  const p = proposal(s);
  p.actions = [{ kind: 'give', targetId: 'alice', itemId: 'imaginary-treasure' }];
  p.targetRevisions = { alice: s.entities.alice.revision };
  assert.ok(g.acceptNpcPlan(s, 'keeper', p).error);
  assert.equal(s.npcBrains.keeper.living.cognition, undefined);
});
test('frozen round cognition retains provenance when a peer produces a newer observation', () => {
  const s = world();
  const p = proposal(s);
  s.npcBrains.keeper.living.knowledgeRevision++;
  const r = g.acceptNpcPlan(s, 'keeper', p);
  assert.equal(r.error, undefined);
  assert.equal(r.state.npcBrains.keeper.living.cognition.knowledgeRevision, p.knowledgeRevision);
  assert.equal(r.state.npcBrains.keeper.living.knowledgeRevision, p.knowledgeRevision + 1);
});
test('executed wait outcome is private grounded state for the next decision', () => {
  const s = g.acceptNpcPlan(world(), 'keeper', proposal(world())).state;
  const r = g.stepWorldNpcPlan(s, 'keeper');
  assert.equal(r.error, undefined);
  assert.equal(r.state.npcBrains.keeper.living.lastActionOutcome.status, 'completed');
  assert.equal(r.state.npcBrains.keeper.living.lastActionOutcome.actionKind, 'wait');
  assert.equal(
    JSON.stringify(g.projectState(r.state, 'alice')).includes('lastActionOutcome'),
    false,
  );
});
test('speech cognition is persisted atomically, not spoken or remembered by listeners', () => {
  const draft = g.createCompleteObservatoryDraft();
  const s = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
  Object.assign(s.entities.alice, { x: 5, y: 4 });
  const audience = Object.values(s.entities)
    .filter((e) => ['npc', 'player'].includes(e.kind) && g.canNpcHear(s, e, s.entities.keeper))
    .map((e) => e.id);
  const context = g.buildNpcPublicSpeechContext(
    s,
    'keeper',
    audience,
    [],
    [],
    undefined,
    'en',
    'alice',
  );
  const input = {
    text: 'Take your time.',
    cognition: thought,
    channel: 'say',
    recipientId: 'alice',
    observationIds: [],
    contextHash: g.npcContextFingerprint(context),
  };
  const r = g.commitNpcPublicUtterance(s, 'keeper', input);
  assert.equal(r.error, undefined);
  assert.equal(r.state.npcBrains.keeper.living.cognition.innerThought, thought.innerThought);
  assert.equal(JSON.stringify(r.state.npcUtterances).includes(thought.innerThought), false);
  assert.equal(
    JSON.stringify(r.state.npcBrains.keeper.living.observations).includes(thought.innerThought),
    false,
  );
  const invalid = g.commitNpcPublicUtterance(s, 'keeper', {
    ...input,
    cognition: { ...thought, innerThought: 'x'.repeat(1401) },
  });
  assert.equal(invalid.error, 'INVALID_ACTION');
  assert.strictEqual(invalid.state, s);
});
