const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
function world() {
  const r = g.compilePlayableDraft(g.createCompleteObservatoryDraft());
  assert.deepEqual(r.errors, []);
  return g.createStateFromPlayable(r.playable, ['alice', 'bob']);
}
function proposal(s) {
  return g.createMockSupportingNpcProposal(s, 'alice', randomUUID());
}
test('fresh supporting identity is bounded authored role + perceived knowledge, not a cloned canon NPC', () => {
  const s = world();
  s.npcBrains.keeper.living.personality.biography = 'SECRET_CANON_BIO';
  const p = proposal(s);
  assert.ok(p);
  p.name = 'Nadia';
  const before = JSON.stringify(s);
  const r = g.admitSupportingNpcProposal(s, 'alice', p);
  assert.equal(r.error, undefined);
  assert.equal(JSON.stringify(s), before);
  assert.equal(r.events.filter((e) => e.kind === 'npc.supporting_created').length, 1);
  const id = `support-${p.proposalId}`,
    npc = r.state.entities[id];
  assert.equal(npc.label, 'Nadia');
  assert.deepEqual(npc.inventory, []);
  assert.equal(npc.supportingNpc.roleId, 'maintenance-assistant');
  assert.equal(JSON.stringify(r.state.npcBrains[id]).includes('SECRET_CANON_BIO'), false);
  assert.deepEqual(r.state.npcBrains[id].living.obligations, []);
  assert.equal(g.gameProjectionSchema.safeParse(g.projectState(r.state, 'alice')).success, true);
  assert.equal(JSON.stringify(g.projectState(r.state, 'alice')).includes('allowedRoles'), false);
});
test('exact replay survives serialization; altered proposal or actor never creates a second identity', () => {
  const s = world(),
    p = proposal(s),
    r = g.admitSupportingNpcProposal(s, 'alice', p);
  assert.equal(r.error, undefined);
  const restored = JSON.parse(JSON.stringify(r.state));
  assert.deepEqual(g.admitSupportingNpcProposal(restored, 'alice', p).events, []);
  assert.equal(g.admitSupportingNpcProposal(restored, 'bob', p).error, 'INVALID_ACTION');
  assert.equal(
    g.admitSupportingNpcProposal(restored, 'alice', { ...p, name: 'Changed' }).error,
    'INVALID_ACTION',
  );
  assert.equal(Object.keys(restored.supportingNpcAdmissions).length, 1);
});
test('no policy means no generation; protected names/roles, foreign memory and arbitrary fields denied', () => {
  const legacy = g.createStateFromPlayable(
    g.compilePlayableDraft(g.createAuthoredDraft()).playable,
    ['alice'],
  );
  assert.equal(g.createMockSupportingNpcProposal(legacy, 'alice', randomUUID()), null);
  const s = world(),
    p = proposal(s);
  for (const bad of [
    { ...p, name: '  KEEPER  ' },
    { ...p, roleId: 'supreme-astronomer' },
    { ...p, knownEntityIds: ['token'] },
    { ...p, inventory: ['key'] },
    { ...p, values: ['honesty'] },
    { ...p, personalitySummary: 'Hi', biography: s.npcBrains.keeper.living },
  ])
    assert.ok(g.admitSupportingNpcProposal(s, 'alice', bad).error);
  assert.equal(JSON.stringify(g.buildSupportingNpcContext(s, 'alice')).includes('token'), false);
});
test('semantic race, geometry, encounter and campaign cap remain authoritative', () => {
  let s = world();
  const p = proposal(s);
  const elapsed = structuredClone(s);
  elapsed.tick += 120;
  assert.equal(g.admitSupportingNpcProposal(elapsed, 'alice', p).error, undefined);
  const moved = structuredClone(s);
  moved.entities.alice.y--;
  assert.equal(g.admitSupportingNpcProposal(moved, 'alice', p).error, 'STALE_STATE');
  assert.equal(
    g.admitSupportingNpcProposal(s, 'alice', { ...p, spawn: { mapId: 'roof', x: 1, y: 1 } }).error,
    'PATH_BLOCKED',
  );
  const conflict = g.beginEncounter(s, 'alice', 1000);
  assert.equal(conflict.error, undefined);
  assert.equal(
    g.admitSupportingNpcProposal(conflict.state, 'alice', proposal(s)).error,
    'WRONG_MODE',
  );
  for (let i = 0; i < 4; i++) {
    const next = proposal(s);
    assert.ok(next);
    const r = g.admitSupportingNpcProposal(s, 'alice', next);
    assert.equal(r.error, undefined);
    s = r.state;
  }
  assert.equal(g.buildSupportingNpcContext(s, 'alice').remainingSlots, 0);
  assert.equal(g.createMockSupportingNpcProposal(s, 'alice', randomUUID()), null);
  assert.equal(
    g.admitSupportingNpcProposal(s, 'alice', { ...p, proposalId: randomUUID() }).error,
    'RATE_LIMITED',
  );
});
test('story need uses pinned objective progress; admission never edits authored package', () => {
  const draft = g.createCompleteObservatoryDraft();
  const compiled = g.compilePlayableDraft(draft).playable;
  let s = g.createStateFromPlayable(compiled, ['alice']);
  assert.equal(g.buildSupportingNpcContext(s, 'alice').allowedRoles.length, 1);
  s.objectiveProgress = { 'recover-journal': { achievedTick: 10 } };
  assert.equal(g.buildSupportingNpcContext(s, 'alice').allowedRoles.length, 0);
  assert.equal(g.createMockSupportingNpcProposal(s, 'alice', randomUUID()), null);
  assert.equal(compiled.supportingNpcPolicy.roles[0].needObjectiveId, 'recover-journal');
  draft.supportingNpcPolicy.roles[0].mapIds = ['missing'];
  assert.ok(g.compilePlayableDraft(draft).errors.length);
  const wrong = g.createCompleteObservatoryDraft();
  wrong.supportingNpcPolicy.roles[0].needObjectiveId = 'secret-impossible';
  assert.ok(g.compilePlayableDraft(wrong).errors.length);
});
