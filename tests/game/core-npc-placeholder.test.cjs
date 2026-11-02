const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
const c = require('../../packages/contracts/dist');
test('explicit NPC placeholder survives authored compile, snapshot and public projection', () => {
  for (const category of ['neutral', 'male', 'female', 'crowd']) {
    const d = g.createAuthoredDraft('courtyard');
    d.npcs.push({
      id: 'silhouette',
      label: 'Named NPC',
      mapId: d.startMapId,
      x: 3,
      y: 3,
      visual: 'keeper',
      goal: 'help',
      npcPlaceholder: category,
    });
    const result = g.compilePlayableDraft(d);
    assert.deepEqual(result.errors, []);
    const state = g.createStateFromPlayable(result.playable, ['alice']);
    state.entities.alice.x = 3;
    state.entities.alice.y = 4;
    const npc = c.gameProjectionSchema
      .parse(g.projectState(state, 'alice'))
      .entities.find((e) => e.id === 'silhouette');
    assert.equal(npc.npcPlaceholder, category);
    assert.equal(npc.label, 'Named NPC');
    assert.equal(npc.x, 3);
    assert.equal(npc.y, 3);
    assert.equal(JSON.parse(JSON.stringify(state)).entities.silhouette.npcPlaceholder, category);
  }
});
test('legacy entities remain valid; invalid placeholder input is rejected', () => {
  const d = g.createAuthoredDraft('courtyard');
  assert.equal(c.authoredGameDraftSchema.safeParse(d).success, true);
  assert.equal(c.npcPlaceholderSchema.safeParse('inferred-from-name').success, false);
  const s = g.createObservatoryState(['alice'], 1);
  assert.equal(c.gameProjectionSchema.safeParse(g.projectState(s, 'alice')).success, true);
});
