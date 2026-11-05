// Source-backed, synthetic rasters only; no provider, paid request or image rewrite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { contentSchema, frozenArtBindingsSchema } = require('../../packages/contracts/dist');
const { compileStoryPlan } = require('../../apps/api/src/game/story-plan.ts');
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
  room.localSpatialGrounding = structuredClone(room.spatialGrounding);
  room.localSpatialGrounding.landmarks = [
    { label: 'Visible hall', kind: 'path', x: 4, y: 4, width: 9, height: 9 },
  ];
  room.spatialGrounding.confidence = 0.78;
  room.spatialGrounding.rows = Array(24).fill('?'.repeat(24));
  return { source, proposal, room };
}
function cell(room, x, y, value) {
  const rows = room.localSpatialGrounding.rows;
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
test('local observed hall recovers low-confidence all-unknown primary without changing its evidence', () => {
  const f = fixture(),
    before = structuredClone(f);
  f.room.spawns = [{ x: 5, y: 5 }];
  const result = compileStoryPlan(f.source, f.proposal);
  assert.equal(result.playable.maps.opening.spatialMode, undefined);
  assert.equal(result.draft.maps[0].spawns.length, 4);
  assert.deepEqual(result.proposal.rooms[0].spatialGrounding, before.room.spatialGrounding);
  assert.deepEqual(result.playable.maps.opening.spatialGrounding, f.room.localSpatialGrounding);
  assert.equal(result.playable.maps.opening.blocked.length, 0);
  assert.equal(result.playable.maps.opening.spatialGrounding.rows[0], '?'.repeat(24));
  assert.deepEqual(compileStoryPlan(f.source, f.proposal), result);
});
test('omitted or absent actual image cannot acquire local evidence', () => {
  for (const omitted of [false, true]) {
    const f = fixture();
    if (omitted)
      f.source.omittedMapImages = [
        {
          locationId: 'opening',
          revisionId: f.source.mapImages[0].revisionId,
          sha256: f.source.mapImages[0].sha256,
        },
      ];
    delete f.source.mapImages;
    delete f.room.spatialGrounding;
    assert.throws(() => compileStoryPlan(f.source, f.proposal), /MAP_IMAGE_SOURCE_MISMATCH/);
  }
});
for (const [name, mutate, error] of [
  [
    'wrong hash',
    (f) => {
      f.room.localSpatialGrounding.imageSha256 = hash('other');
    },
    'SOURCE_MISMATCH',
  ],
  [
    'wrong revision',
    (f) => {
      f.room.localSpatialGrounding.imageRevisionId = randomUUID();
    },
    'SOURCE_MISMATCH',
  ],
  [
    'low local confidence',
    (f) => {
      f.room.localSpatialGrounding.confidence = 0.849;
    },
    'LOCAL_EVIDENCE_REQUIRED',
  ],
  [
    'no landmark',
    (f) => {
      f.room.localSpatialGrounding.landmarks = [];
    },
    'LOCAL_EVIDENCE_REQUIRED',
  ],
  [
    'unrelated landmark',
    (f) => {
      f.room.localSpatialGrounding.landmarks[0].x = 20;
      f.room.localSpatialGrounding.landmarks[0].width = 2;
    },
    'LOCAL_EVIDENCE_REQUIRED',
  ],
  [
    'oversized local region',
    (f) => {
      f.room.localSpatialGrounding.rows = Array(24).fill('.'.repeat(24));
    },
    'LOCAL_EVIDENCE_REQUIRED',
  ],
  [
    'transparent water',
    (f) => {
      cell(f.room, 3, 3, '~');
    },
    'LOCAL_EVIDENCE_CONFLICT',
  ],
  [
    'known wall contradiction',
    (f) => {
      f.room.spatialGrounding.rows[5] = '?????#' + '?'.repeat(18);
    },
    'LOCAL_EVIDENCE_CONFLICT',
  ],
  [
    'all unknown local floor',
    (f) => {
      f.room.localSpatialGrounding.rows = Array(24).fill('?'.repeat(24));
    },
    'UNSAFE_SPAWN',
  ],
  [
    'no valid opening anchor',
    (f) => {
      f.room.spawns = [];
    },
    'UNSAFE_SPAWN',
  ],
  [
    'disconnected original spawns',
    (f) => {
      cell(f.room, 20, 20, '.');
      f.room.spawns[0] = { x: 20, y: 20 };
    },
    'DISCONNECTED_SPAWN',
  ],
])
  test(`fails closed for ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => compileStoryPlan(f.source, f.proposal), new RegExp('MAP_IMAGE_' + error));
  });
test('source NPC identity, actual position, and authored opening membership survive local recovery', () => {
  const f = fixture();
  npc(f, 'small');
  const id = f.proposal.npcs[0].sourceNpcId;
  f.source.content.scenes = [
    {
      id: 'entry',
      locationId: 'opening',
      name: 'Entry',
      description: 'Entry',
      participantNpcIds: [id],
    },
  ];
  f.source.content.startSceneId = 'entry';
  const result = compileStoryPlan(f.source, f.proposal);
  assert.equal(result.draft.npcs[0].id, id);
  assert.equal(result.draft.npcs[0].sourceNpcId, id);
  assert.equal(result.draft.npcs[0].mapId, 'opening');
  assert.equal(result.draft.npcs[0].x, 4);
  assert.equal(result.draft.npcs[0].y, 4);
});
test('unauthored NPC cannot be teleported into opening; observed isolated position remains unchanged', () => {
  const f = fixture();
  npc(f, 'small');
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /MAP_IMAGE_PRESENCE_UNSUPPORTED/);
  cell(f.room, 20, 20, '.');
  f.proposal.npcs[0].x = 20;
  f.proposal.npcs[0].y = 20;
  const result = compileStoryPlan(f.source, f.proposal);
  assert.equal(result.draft.npcs[0].x, 20);
  assert.equal(result.draft.npcs[0].y, 20);
  assert.deepEqual(result.proposal.npcs, f.proposal.npcs);
});
test('authored opening NPC cannot be moved offstage and missing NPC coordinates are not repaired', () => {
  const f = fixture();
  npc(f, 'small');
  f.source.content.scenes = [
    {
      id: 'entry',
      locationId: 'opening',
      name: 'Entry',
      description: 'Entry',
      participantNpcIds: [f.proposal.npcs[0].sourceNpcId],
    },
  ];
  f.source.content.startSceneId = 'entry';
  cell(f.room, 20, 20, '.');
  f.proposal.npcs[0].x = 20;
  f.proposal.npcs[0].y = 20;
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /MAP_IMAGE_PRESENCE_UNSUPPORTED/);
  delete f.proposal.npcs[0].x;
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /MAP_IMAGE_UNSAFE_NPC/);
});
test('large NPC footprint is not inferred from an observed anchor alone', () => {
  const f = fixture();
  npc(f);
  f.proposal.npcs[0].x = 12;
  f.proposal.npcs[0].y = 12;
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /MAP_IMAGE_UNSAFE_NPC/);
});
test('recovery cannot smuggle a foreign scene participant', () => {
  const f = fixture();
  f.room.scenePresence = {
    version: 1,
    entrySceneId: 'entry',
    scenes: [
      {
        id: 'entry',
        participantIds: [randomUUID()],
        evidence: { kind: 'accepted_story_plan', reference: 'opening' },
      },
    ],
  };
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /STORY_SCENE_PRESENCE_INVALID/);
});
test('two unrelated offstage NPCs cannot share a recovered component', () => {
  const f = fixture();
  npc(f, 'small');
  npc(f, 'small');
  cell(f.room, 20, 20, '.');
  cell(f.room, 21, 20, '.');
  f.proposal.npcs[0].x = 20;
  f.proposal.npcs[0].y = 20;
  f.proposal.npcs[1].x = 21;
  f.proposal.npcs[1].y = 20;
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /MAP_IMAGE_PRESENCE_UNSUPPORTED/);
});
test('nearby offstage component remains opaque to actual runtime perception', () => {
  const f = fixture();
  npc(f, 'small');
  cell(f.room, 14, 5, '.');
  f.proposal.npcs[0].x = 14;
  f.proposal.npcs[0].y = 5;
  const {
    createStateFromPlayable,
    projectState,
    applyAction,
    walkable,
    canNpcHear,
  } = require('../../packages/game-core/dist');
  const { observedVisible } = require('../../packages/game-core/dist/observation-visibility');
  const result = compileStoryPlan(f.source, f.proposal);
  const state = createStateFromPlayable(result.playable, ['player']);
  const player = state.entities.player,
    offstage = state.entities[f.proposal.npcs[0].sourceNpcId];
  assert.equal(observedVisible(state, player, offstage), false);
  assert.equal(observedVisible(state, offstage, player), false);
  state.artBindings = frozenArtBindingsSchema.parse([
    {
      slot: `entity:${offstage.id}:portrait`,
      revisionId: randomUUID(),
      sha256: 'a'.repeat(64),
      mime: 'image/png',
      width: 512,
      height: 512,
    },
  ]);
  const projected = projectState(state, 'player');
  assert.equal(
    projected.entities.some((e) => e.id === offstage.id),
    false,
  );
  assert.equal(
    projected.npcFactTopics.some((t) => t.npcId === offstage.id),
    false,
  );
  assert.equal(projected.artBindings.length, 0);
  assert.equal(canNpcHear(state, offstage, player, 20), false);
  assert.equal(
    applyAction(state, 'player', { kind: 'talk', targetId: offstage.id }).error,
    'TARGET_UNAVAILABLE',
  );
  assert.equal(
    walkable(state, 'opening', { x: 13, y: 5 }),
    true,
    'observation does not invent collision',
  );
  offstage.x = 8;
  const visibleControl = projectState(state, 'player');
  assert.ok(visibleControl.entities.some((e) => e.id === offstage.id));
  assert.equal(
    visibleControl.artBindings.length,
    1,
    'valid portrait is admitted when its subject is actually visible',
  );
});

test('offstage speech across a nearby unknown separator never reaches opening participants', () => {
  const f = fixture();
  npc(f, 'small');
  for (let y = 0; y < 24; y++) cell(f.room, 7, y, '?');
  f.proposal.npcs[0].x = 8;
  f.proposal.npcs[0].y = 5;
  const {
    createStateFromPlayable,
    canNpcHear,
    projectState,
  } = require('../../packages/game-core/dist');
  const state = createStateFromPlayable(compileStoryPlan(f.source, f.proposal).playable, [
    'player',
  ]);
  const other = state.entities[f.proposal.npcs[0].sourceNpcId];
  assert.equal(canNpcHear(state, other, state.entities.player), false);
  assert.equal(canNpcHear(state, state.entities.player, other), false);
  assert.equal(
    projectState(state, 'player').entities.some((e) => e.id === other.id),
    false,
  );
});
