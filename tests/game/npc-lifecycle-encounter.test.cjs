const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
const { transitionNpcLifeState } = require('../../packages/game-core/dist/lifecycle');

function world() {
  const s = g.createObservatoryState(['alice']);
  const map = s.maps[s.entities.alice.mapId];
  map.blocked = [];
  Object.assign(s.entities.alice, { x: 3, y: 3 });
  Object.assign(s.entities.keeper, { x: 4, y: 3, mapId: s.entities.alice.mapId });
  return s;
}

test('legacy encounters retain bodies in place without enrolling or normalizing them', () => {
  for (const lifeState of ['unconscious', 'dead']) {
    const s = world();
    Object.assign(s.entities.keeper, { lifeState, x: 3, y: 3 });
    const body = structuredClone(s.entities.keeper);
    const begun = g.beginEncounter(s, 'alice', 0);
    assert.equal(begun.error, undefined);
    const encounter = Object.values(begun.state.encounters).find((e) => e.phase === 'planning');
    assert.ok(!encounter.participants.includes('keeper'));
    assert.deepEqual(begun.state.entities.keeper, body);
    assert.ok(!g.footprintOverlaps(begun.state.entities.alice, begun.state.entities.keeper));
    assert.equal(
      g.projectState(begun.state, 'alice').entities.find((e) => e.id === 'keeper').lifeState,
      lifeState,
    );
    assert.equal(g.beginEncounter(s, 'keeper').error, 'WRONG_MODE');
  }
});

test('incapacity clears active encounter membership and stale intent without removing the body', () => {
  const s = g.beginEncounter(world(), 'alice', 0).state;
  const e = Object.values(s.encounters).find((entry) => entry.phase === 'planning');
  assert.ok(e.participants.includes('keeper'));
  e.intents.keeper = {
    revision: 1,
    ready: true,
    action: { kind: 'move_to', target: { x: 4, y: 4 } },
  };
  const position = { x: s.entities.keeper.x, y: s.entities.keeper.y };
  assert.equal(transitionNpcLifeState(s, 'keeper', 'dead'), true);
  assert.ok(!e.participants.includes('keeper'));
  assert.equal(e.intents.keeper, undefined);
  assert.equal(s.entities.keeper.encounterId, undefined);
  assert.equal(
    g.submitIntent(s, 'keeper', {
      encounterId: e.id,
      generation: e.generation,
      round: e.round,
      intentRevision: 2,
      ready: true,
      action: { kind: 'wait' },
    }).error,
    'FORBIDDEN',
  );
  const resolved = g.resolveRound(s, e.id, e.deadlineMs);
  assert.equal(resolved.error, undefined);
  assert.deepEqual(
    { x: resolved.state.entities.keeper.x, y: resolved.state.entities.keeper.y },
    position,
  );
  assert.ok(!resolved.events.some((event) => event.actorId === 'keeper'));
});

test('typed talk and distract cannot report success on an unavailable NPC; body inspection remains valid', () => {
  for (const lifecycle of [{ lifeState: 'dead' }, { lifeState: 'unconscious' }, { vitality: 0 }]) {
    const s = world();
    Object.assign(s.entities.keeper, lifecycle);
    for (const kind of ['talk', 'distract']) {
      const result = g.applyAction(s, 'alice', { kind, targetId: 'keeper' });
      assert.equal(result.error, 'TARGET_UNAVAILABLE');
      assert.equal(result.state, s);
      assert.deepEqual(result.events, []);
    }
    assert.equal(
      g.applyAction(s, 'alice', { kind: 'inspect', targetId: 'keeper' }).error,
      undefined,
    );
  }
});
