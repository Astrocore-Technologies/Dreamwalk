import test from 'node:test';
import assert from 'node:assert/strict';
import { entityLayout, containsScenePoint } from '../../apps/web/components/game/scene-geometry.ts';
const item = (id, slot) => ({
  id,
  kind: 'item',
  mapId: 'room',
  x: 4,
  y: 3,
  revision: 0,
  item: {
    definitionId: id,
    quantity: 1,
    portable: true,
    edible: false,
    restoreVitality: 0,
    visual: 'cup',
    surfaceId: 'table',
    surfaceSlot: slot,
  },
});
test('table item hit boxes are separate and stable after another item disappears', () => {
  const a = item('a', 0),
    b = item('b', 1),
    first = entityLayout(a, [a, b]),
    second = entityLayout(b, [a, b]);
  assert.deepEqual(entityLayout(b, [b]), second);
  assert.equal(containsScenePoint(second, { x: first.x + 2, y: first.y + 2 }), false);
  assert.equal(containsScenePoint(second, { x: second.x + 2, y: second.y + 2 }), true);
});
test('static actor rendering preserves aspect and feet anchor for map hit testing', () => {
  const e = { id: 'hero', kind: 'player', mapId: 'room', x: 2, y: 3, revision: 0 };
  const r = entityLayout(e, [e], 48, 0.4, true);
  assert.equal(r.width, 28.8);
  assert.equal(r.height, 72);
  assert.equal(r.y + r.height, (e.y + 1) * 48);
  assert.equal(r.x + r.width / 2, (e.x + 0.5) * 48);
  assert.ok(containsScenePoint(r, { x: (e.x + 0.5) * 48, y: 2.7 * 48 }));
});
