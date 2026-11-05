// Source-backed, synthetic rasters only; no provider, paid request or image rewrite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { contentSchema } = require('../../packages/contracts/dist');
const { compileStoryPlan, storyPlanSchema } = require('../../apps/api/src/game/story-plan.ts');
const hash = (v) => createHash('sha256').update(v).digest('hex');
function fixture() {
  const bytes = Buffer.from('synthetic raster');
  const image = {
    locationId: 'opening',
    revisionId: randomUUID(),
    sha256: hash('original'),
    inputSha256: hash(bytes),
    width: 768,
    height: 768,
    framing: 'contain-24x24',
    dataUrl: 'data:image/jpeg;base64,' + bytes.toString('base64'),
  };
  const source = {
    title: 'Opening',
    npcs: [],
    mapImages: [image],
    content: contentSchema.parse({
      locations: [{ id: 'opening', name: 'Opening', description: 'Inside the room.' }],
    }),
  };
  const room = {
    locationId: 'opening',
    width: 24,
    height: 24,
    blocked: [],
    surfaces: [],
    spawns: [
      { x: 5, y: 5 },
      { x: 6, y: 5 },
      { x: 5, y: 6 },
      { x: 6, y: 6 },
    ],
    spatialGrounding: {
      version: 1,
      imageRevisionId: image.revisionId,
      imageSha256: image.sha256,
      confidence: 0.85,
      landmarks: [],
      rows: Array.from({ length: 24 }, (_, y) =>
        Array.from({ length: 24 }, (_, x) =>
          x >= 4 && x <= 12 && y >= 4 && y <= 12 ? '.' : '?',
        ).join(''),
      ),
    },
  };
  const proposal = { version: 1, rooms: [room], npcs: [], connections: [], items: [] };
  return { source, proposal, room };
}
function cell(room, x, y, value) {
  const rows = room.spatialGrounding.rows;
  rows[y] = rows[y].slice(0, x) + value + rows[y].slice(x + 1);
}
function npc(f, size = 'huge') {
  const id = randomUUID();
  f.source.npcs.push({
    id,
    name: 'Keeper',
    role: 'Keeper',
    description: 'A keeper.',
    appearance: 'Huge.',
  });
  f.source.content.npcIds.push(id);
  f.proposal.npcs.push({
    sourceNpcId: id,
    locationId: 'opening',
    tokenSize: size,
    x: 4,
    y: 4,
    stock: [],
  });
}
test('valid distinct slots and verified image/source metadata remain unchanged', () => {
  const f = fixture(),
    before = structuredClone(f);
  const result = compileStoryPlan(f.source, f.proposal);
  assert.deepEqual(result.proposal, f.proposal);
  assert.deepEqual(f, before);
  assert.equal(result.draft.maps[0].id, 'opening');
  assert.equal(result.draft.maps[0].sourceLocationId, 'opening');
  assert.deepEqual(result.draft.maps[0].spatialGrounding, f.room.spatialGrounding);
});
test('unsafe and duplicate slots repair deterministically without moving retained later slots', () => {
  const f = fixture();
  f.room.spawns = [
    { x: 1, y: 1 },
    { x: 4, y: 4 },
    { x: 4, y: 4 },
    { x: 1, y: 1 },
  ];
  const before = structuredClone(f);
  const a = compileStoryPlan(f.source, f.proposal),
    b = compileStoryPlan(f.source, f.proposal);
  assert.deepEqual(a.proposal, b.proposal);
  assert.deepEqual(a.proposal.rooms[0].spawns, [
    { x: 5, y: 4 },
    { x: 4, y: 4 },
    { x: 6, y: 4 },
    { x: 7, y: 4 },
  ]);
  assert.deepEqual(f, before);
  assert.deepEqual(storyPlanSchema.parse(f.proposal), f.proposal);
});
test('all huge NPC footprint cells are excluded, including overlapping player slots', () => {
  const f = fixture();
  npc(f);
  f.room.spawns = [
    { x: 5, y: 5 },
    { x: 8, y: 8 },
    { x: 5, y: 5 },
    { x: 5, y: 5 },
  ];
  const result = compileStoryPlan(f.source, f.proposal);
  assert.deepEqual(result.proposal.rooms[0].spawns, [
    { x: 7, y: 4 },
    { x: 8, y: 8 },
    { x: 8, y: 4 },
    { x: 9, y: 4 },
  ]);
  assert.deepEqual(result.proposal.npcs, f.proposal.npcs);
});
test('low confidence stays unpositioned while stale revision/hash still fail closed', () => {
  const uncertain = fixture();
  uncertain.room.spatialGrounding.confidence = 0.849999;
  uncertain.room.spawns[0] = { x: 1, y: 1 };
  const before = structuredClone(uncertain);
  const compiled = compileStoryPlan(uncertain.source, uncertain.proposal).playable.maps.opening;
  assert.equal(compiled.spatialMode, 'location_only');
  assert.deepEqual(compiled.spawns, []);
  assert.deepEqual(compiled.blocked, []);
  assert.equal(compiled.spatialGrounding, undefined);
  assert.deepEqual(compiled.scenePresence.scenes[0].participantIds, []);
  assert.deepEqual(compiled.locationImage, {
    revisionId: uncertain.source.mapImages[0].revisionId,
    sha256: uncertain.source.mapImages[0].sha256,
  });
  assert.deepEqual(uncertain, before);
  for (const mutate of [
    (f) => {
      f.room.spatialGrounding.imageRevisionId = randomUUID();
    },
    (f) => {
      f.room.spatialGrounding.imageSha256 = hash('different');
    },
  ]) {
    const f = fixture();
    f.room.spawns[0] = { x: 1, y: 1 };
    mutate(f);
    assert.throws(() => compileStoryPlan(f.source, f.proposal), /MAP_IMAGE_SOURCE_MISMATCH/);
  }
});
test('no valid anchor, even with a large safe room, cannot select a new opening', () => {
  for (const spawns of [Array(4).fill({ x: 1, y: 1 }), Array(4).fill({ x: 2, y: 2 })]) {
    const f = fixture();
    f.room.spawns = spawns;
    assert.throws(() => compileStoryPlan(f.source, f.proposal), /MAP_IMAGE_UNSAFE_SPAWN/);
  }
});
test('valid original spawns in disconnected components cannot be relocated', () => {
  const f = fixture();
  cell(f.room, 20, 20, '.');
  f.room.spawns = [
    { x: 5, y: 5 },
    { x: 20, y: 20 },
    { x: 1, y: 1 },
    { x: 1, y: 1 },
  ];
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /MAP_IMAGE_UNSAFE_SPAWN/);
  f.room.spawns.splice(2, 2, { x: 6, y: 5 }, { x: 5, y: 6 });
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /MAP_IMAGE_DISCONNECTED_SPAWN/);
});
test('insufficient clear floor never uses unknown cells or door thresholds as spawns', () => {
  const f = fixture();
  f.room.spatialGrounding.rows = Array(24).fill('?'.repeat(24));
  for (let x = 5; x <= 7; x++) cell(f.room, x, 5, '.');
  cell(f.room, 8, 5, 'D');
  f.room.spawns = Array(4).fill({ x: 5, y: 5 });
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /MAP_IMAGE_UNSAFE_SPAWN/);
});
test('unsafe NPC terrain and passage annotations remain fatal after spawn admission', () => {
  const f = fixture();
  npc(f);
  f.proposal.npcs[0].x = 11;
  f.proposal.npcs[0].y = 11;
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /MAP_IMAGE_UNSAFE_NPC/);
  const p = fixture();
  p.room.spawns[0] = { x: 1, y: 1 };
  p.proposal.connections.push({
    a: 'opening',
    b: 'other',
    atA: { x: 1, y: 1 },
    atB: { x: 5, y: 5 },
  });
  assert.throws(() => compileStoryPlan(p.source, p.proposal), /MAP_IMAGE_UNSAFE_PASSAGE/);
  p.proposal.connections = [];
  p.room.spatialGrounding.doors = [{ x: 1, y: 1, label: 'Door', open: false }];
  assert.throws(() => compileStoryPlan(p.source, p.proposal), /MAP_IMAGE_UNSAFE_PASSAGE/);
});
test('text-only plans and other image validators retain their strict requirements', () => {
  const f = fixture();
  delete f.source.mapImages;
  delete f.room.spatialGrounding;
  f.room.spawns.length = 1;
  assert.throws(() => compileStoryPlan(f.source, f.proposal));
  const p = fixture();
  p.room.spawns[0] = { x: 1, y: 1 };
  p.room.blocked.push({ x: 2, y: 2 });
  assert.throws(() => compileStoryPlan(p.source, p.proposal), /MAP_IMAGE_DUPLICATE_GEOMETRY/);
});
