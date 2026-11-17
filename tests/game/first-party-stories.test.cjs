const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');

const stories = [
  ['forest', g.createForestStoryDraft],
  ['lighthouse', g.createLighthouseStoryDraft],
];
const key = (p) => `${p.x},${p.y}`;
function reachable(map, from) {
  const blocked = new Set(map.blocked.map(key));
  const seen = new Set([key(from)]);
  const queue = [from];
  while (queue.length) {
    const p = queue.shift();
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const n = { x: p.x + dx, y: p.y + dy };
      if (n.x < 0 || n.y < 0 || n.x >= map.width || n.y >= map.height) continue;
      if (blocked.has(key(n)) || seen.has(key(n))) continue;
      seen.add(key(n));
      queue.push(n);
    }
  }
  return seen;
}

for (const [name, make] of stories) {
  test(`${name}: compiles, localizes every player-facing label and keeps a lawful start`, () => {
    const draft = make();
    const compiled = g.compilePlayableDraft(draft);
    assert.deepEqual(compiled.errors, []);
    for (const e of [...draft.objects, ...draft.npcs])
      for (const l of ['ru', 'uk', 'en']) assert.ok(e.labelTranslations?.[l], `${e.id} ${l}`);
    for (const m of draft.maps)
      for (const l of ['ru', 'uk', 'en']) assert.ok(m.labelTranslations?.[l], `${m.id} ${l}`);
    const objective = draft.objectives[0];
    for (const l of ['ru', 'uk', 'en'])
      for (const f of ['title', 'description', 'epilogue'])
        assert.ok(objective.translations[l][f].length > (f === 'title' ? 5 : 20), `${l} ${f}`);
    const state = g.createStateFromPlayable(compiled.playable, ['alice']);
    assert.ok(state.entities.alice);
    assert.equal(draft.npcs.length, 2);
  });

  test(`${name}: both routes to the goal are physically reachable and nothing is walled in`, () => {
    const draft = make();
    const [startMap, farMap] = draft.maps;
    const reach = reachable(startMap, startMap.spawns[0]);
    const at = (id) =>
      draft.objects.find((o) => o.id === id) ?? draft.npcs.find((n) => n.id === id);
    const near = (reachSet, p) =>
      [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dy]) => reachSet.has(`${p.x + dx},${p.y + dy}`));
    for (const id of ['key', 'door', 'side-door', 'token'])
      assert.ok(near(reach, at(id)), `${id} reachable from the start`);
    for (const npc of draft.npcs) assert.ok(near(reach, npc), `${npc.id} reachable`);
    for (const exit of startMap.exits) assert.ok(near(reach, exit), `${exit.id} reachable`);
    // The key and the token each unlock exactly one door; the goal lies behind both.
    assert.equal(at('door').keyId, 'key');
    assert.equal(at('side-door').keyId, 'token');
    assert.equal(at('token').ownerNpcId, draft.npcs[0].id);
    const arrivals = startMap.exits.map((e) => e.destination);
    for (const arrive of arrivals) {
      const farReach = reachable(farMap, arrive);
      assert.ok(
        near(farReach, at(draft.objectives[0].completion.conditions[0].itemId)),
        'goal reachable',
      );
      for (const exit of farMap.exits) assert.ok(near(farReach, exit), 'way back reachable');
    }
    // No entity shares a cell with another or sits inside an obstacle.
    const cells = new Map();
    for (const e of [...draft.objects, ...draft.npcs]) {
      if (e.id === 'token') continue; // carried by its owner at the same cell
      const map = draft.maps.find((m) => m.id === e.mapId);
      assert.ok(!map.blocked.some((b) => b.x === e.x && b.y === e.y), `${e.id} not in a wall`);
      const k = `${e.mapId}:${e.x},${e.y}`;
      assert.ok(!cells.has(k), `${e.id} overlaps ${cells.get(k)}`);
      cells.set(k, e.id);
    }
  });
}

for (const [name, make] of stories) {
  test(`${name}: owning the goal item achieves the objective exactly once`, () => {
    const draft = make();
    const compiled = g.compilePlayableDraft(draft);
    const state = g.createStateFromPlayable(compiled.playable, ['alice']);
    const goal = draft.objectives[0].completion.conditions[0].itemId;
    assert.equal(g.advanceObjectives(state, ['alice']).events.length, 0);
    state.entities[goal].ownerId = 'alice';
    state.entities.alice.inventory = [goal];
    const won = g.advanceObjectives(state, ['alice']);
    assert.equal(won.events.length, 1);
    assert.equal(g.advanceObjectives(won.state, ['alice']).events.length, 0);
  });
}
