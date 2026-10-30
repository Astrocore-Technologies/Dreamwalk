const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
const c = require('../../packages/contracts/dist');
const binding = (slot, sha = 'a') => ({
  slot,
  revisionId: '10000000-0000-4000-8000-000000000001',
  sha256: sha.repeat(64),
  mime: 'image/png',
  width: 128,
  height: 128,
});
function fixture() {
  const draft = g.createAuthoredDraft('courtyard');
  const { playable, errors } = g.compilePlayableDraft(draft);
  assert.deepEqual(errors, []);
  playable.artBindings = g.enumerateArtSlots(playable).map((s) => binding(s.slot));
  return { draft, playable, state: g.createStateFromPlayable(playable, ['alice', 'bob']) };
}
test('art slots strictly bind existing entity kind and supported camera, never arbitrary resource names', () => {
  const { draft, playable } = fixture();
  assert.deepEqual(g.enumerateArtSlots(draft), g.enumerateArtSlots(playable));
  const npc = draft.npcs[0].id;
  assert.equal(
    g.validateArtBindingSlot(draft, `entity:${npc}:sprite`, {
      kind: 'sprite',
      style: 'drawn2D',
      camera: 'top-down',
    }),
    true,
  );
  for (const metadata of [
    { kind: 'portrait', style: 'drawn2D', camera: 'top-down' },
    { kind: 'sprite', style: 'pixel', camera: 'top-down' },
    { kind: 'sprite', style: 'drawn2D', camera: 'isometric' },
  ])
    assert.equal(g.validateArtBindingSlot(draft, `entity:${npc}:sprite`, metadata), false);
  assert.equal(
    g.validateArtBindingSlot(draft, 'entity:missing:sprite', {
      kind: 'sprite',
      style: 'drawn2D',
      camera: 'top-down',
    }),
    false,
  );
  for (const slot of [
    'entity:__proto__:sprite',
    'map:../secret:background',
    'https://evil/file',
    'entity:x:object:open:extra',
    'entity:x:sprite/secret',
  ])
    assert.equal(g.parseArtSlot(slot), null);
  assert.equal(
    c.frozenArtBindingsSchema.safeParse([
      binding('map:courtyard:background'),
      binding('map:courtyard:background'),
    ]).success,
    false,
  );
  assert.equal(
    c.frozenArtBindingsSchema.safeParse([
      { ...binding('map:courtyard:background'), url: 'https://evil' },
    ]).success,
    false,
  );
});
test('art projection reveals only current map, visible NPCs and objects, and own inventory', () => {
  const { state } = fixture();
  const npc = Object.values(state.entities).find((e) => e.kind === 'npc');
  const item = Object.values(state.entities).find((e) => e.kind === 'item');
  Object.assign(npc, { mapId: 'garden', x: 2, y: 2 });
  Object.assign(item, { ownerId: 'bob' });
  state.entities.bob.inventory = [item.id];
  let view = g.projectState(state, 'alice');
  assert.ok(view.artBindings.some((b) => b.slot === 'map:courtyard:background'));
  assert.ok(
    !view.artBindings.some(
      (b) =>
        b.slot === 'map:garden:background' ||
        b.slot.includes(`:${npc.id}:`) ||
        b.slot.includes(`:${item.id}:`),
    ),
  );
  assert.deepEqual(g.projectVisibleArtBindings(state, 'missing'), []);
  item.ownerId = 'alice';
  state.entities.alice.inventory = [item.id];
  view = g.projectState(state, 'alice');
  assert.ok(view.artBindings.some((b) => b.slot === `entity:${item.id}:object:default`));
  assert.ok(c.gameProjectionSchema.safeParse(view).success);
  assert.deepEqual(Object.keys(view.artBindings[0]).sort(), [
    'height',
    'mime',
    'revisionId',
    'sha256',
    'slot',
    'width',
  ]);
});
test('door art exposes only active state and cannot reveal future variant', () => {
  const { state } = fixture();
  const door = Object.values(state.entities).find((e) => e.kind === 'door');
  Object.assign(state.entities.alice, { mapId: door.mapId, x: door.x - 1, y: door.y });
  for (const open of [false, true]) {
    door.open = open;
    const slots = g.projectVisibleArtBindings(state, 'alice').map((b) => b.slot);
    assert.ok(slots.includes(`entity:${door.id}:object:${open ? 'open' : 'closed'}`));
    assert.ok(!slots.includes(`entity:${door.id}:object:${open ? 'closed' : 'open'}`));
    assert.ok(!slots.includes(`entity:${door.id}:object:default`));
    assert.equal(slots.filter((slot) => slot.startsWith(`entity:${door.id}:object:`)).length, 1);
    const withoutActive = state.artBindings.filter(
      (b) => b.slot !== `entity:${door.id}:object:${open ? 'open' : 'closed'}`,
    );
    const fallback = g
      .projectVisibleArtBindings(state, 'alice', withoutActive)
      .filter((b) => b.slot.startsWith(`entity:${door.id}:object:`));
    assert.deepEqual(
      fallback.map((b) => b.slot),
      [`entity:${door.id}:object:default`],
    );
  }
});
test('two campaigns reuse immutable raster identity but never mutable world or binding state', () => {
  const { playable, state: a } = fixture();
  const b = g.createStateFromPlayable(playable, ['alice']);
  assert.deepEqual(a.artBindings, b.artBindings);
  a.entities.alice.x = 9;
  a.artBindings[0].sha256 = 'b'.repeat(64);
  assert.notEqual(a.entities.alice.x, b.entities.alice.x);
  assert.equal(b.artBindings[0].sha256, 'a'.repeat(64));
  assert.equal(playable.artBindings[0].sha256, 'a'.repeat(64));
  const next = structuredClone(playable);
  next.artBindings[0].sha256 = 'c'.repeat(64);
  assert.equal(g.createStateFromPlayable(next, ['alice']).artBindings[0].sha256, 'c'.repeat(64));
  assert.equal(b.artBindings[0].sha256, 'a'.repeat(64));
  delete next.artBindings;
  assert.equal(
    g.projectState(g.createStateFromPlayable(next, ['alice']), 'alice').artBindings,
    undefined,
  );
});
