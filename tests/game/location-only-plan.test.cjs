// Source-backed semantic planning coverage. No network/provider or paid retries.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { contentSchema } = require('../../packages/contracts/dist');
const { compileStoryPlan, storyPlanDefinition } = require('../../apps/api/src/game/story-plan.ts');
const { startMapGroundingCompatible } = require('../../apps/api/src/game/story-map-mode.ts');
const hash = (s) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const npc = randomUUID(),
    bytes = Buffer.from('synthetic image');
  const image = {
    locationId: 'tower',
    revisionId: randomUUID(),
    sha256: hash('original'),
    inputSha256: hash(bytes),
    width: 768,
    height: 768,
    framing: 'contain-24x24',
    dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
  };
  const source = {
    title: 'Tower',
    // A location whose image was deliberately not analyzed is the only location-only case:
    // low model confidence no longer demotes an analyzed image.
    omittedMapImages: [
      { locationId: image.locationId, revisionId: image.revisionId, sha256: image.sha256 },
    ],
    npcs: [
      {
        id: npc,
        name: 'Keeper',
        role: 'host',
        description: 'A welcoming keeper.',
        appearance: 'A wool coat.',
      },
    ],
    content: contentSchema.parse({
      locations: [{ id: 'tower', name: 'Tower', description: 'The keeper greets visitors.' }],
      npcIds: [npc],
      scenes: [
        {
          id: 'welcome',
          participantNpcIds: [npc],
          name: 'Welcome',
          locationId: 'tower',
          description: 'Keeper greets visitors here.',
        },
      ],
      startSceneId: 'welcome',
    }),
  };
  const room = {
    locationId: 'tower',
    width: 24,
    height: 24,
    spawns: [],
    blocked: [],
    surfaces: [],
    scenePresence: {
      version: 1,
      entrySceneId: 'welcome',
      scenes: [
        {
          id: 'welcome',
          participantIds: [npc],
          evidence: { kind: 'authored_scene', reference: 'welcome' },
        },
      ],
    },
  };
  const proposal = {
    version: 1,
    rooms: [room],
    connections: [],
    npcs: [
      {
        sourceNpcId: npc,
        locationId: 'tower',
        sceneId: 'welcome',
        stock: [],
      },
    ],
    items: [],
  };
  return { source, proposal, room, npc };
}
test('uncertain exact image creates semantic scene, no numeric entities or invented geometry', () => {
  const { source, proposal, npc } = fixture();
  const { draft, playable } = compileStoryPlan(source, proposal);
  const map = playable.maps.tower;
  assert.equal(map.spatialMode, 'location_only');
  assert.deepEqual(map.locationImage, {
    revisionId: source.omittedMapImages[0].revisionId,
    sha256: source.omittedMapImages[0].sha256,
  });
  for (const key of ['spawns', 'blocked', 'exits']) assert.deepEqual(map[key], []);
  assert.equal(map.spatialGrounding, undefined);
  assert.equal(map.composition, undefined);
  assert.equal(draft.npcs[0].sceneId, 'welcome');
  assert.equal(draft.npcs[0].x, undefined);
  assert.equal(draft.npcs[0].y, undefined);
  assert.equal(draft.npcs[0].sourceNpcId, npc);
  assert.equal(startMapGroundingCompatible(source, playable), false);
  assert.equal(
    startMapGroundingCompatible(
      { ...source, mapImages: [{ ...source.omittedMapImages[0], sha256: hash('changed') }] },
      playable,
    ),
    false,
  );
});
test('new uncertain plan derives authored scene presence without model technical metadata', () => {
  const { source, proposal, room } = fixture();
  delete room.scenePresence;
  delete proposal.npcs[0].sceneId;
  const before = structuredClone({ source, proposal });
  const { playable } = compileStoryPlan(source, proposal);
  assert.equal(playable.entities[proposal.npcs[0].sourceNpcId].sceneId, 'welcome');
  assert.deepEqual(
    playable.maps.tower.scenePresence.scenes[0].participantIds,
    source.content.npcIds,
  );
  assert.deepEqual({ source, proposal }, before);
});
test('source and image identity remain mandatory for semantic fallback', () => {
  const { source, proposal, room } = fixture();
  // An omitted image cannot also carry a model-supplied observation.
  room.spatialGrounding = {
    version: 1,
    imageRevisionId: source.omittedMapImages[0].revisionId,
    imageSha256: hash('other'),
    confidence: 0.9,
    rows: Array(24).fill('.'.repeat(24)),
    landmarks: [],
  };
  assert.throws(() => compileStoryPlan(source, proposal), /MAP_IMAGE_SOURCE_MISMATCH/);
});
for (const [name, mutate] of [
  ['foreign member', (f) => f.room.scenePresence.scenes[0].participantIds.push(randomUUID())],
  ['duplicate member', (f) => f.room.scenePresence.scenes[0].participantIds.push(f.npc)],
])
  test(`rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => compileStoryPlan(f.source, f.proposal), /STORY_SCENE_PRESENCE_INVALID/);
  });
for (const [name, mutate] of [
  ['wrong scene assignment', (f) => (f.proposal.npcs[0].sceneId = 'hidden')],
  ['wrong author evidence', (f) => (f.room.scenePresence.scenes[0].evidence.reference = 'hidden')],
  ['missing entry scene', (f) => (f.room.scenePresence.entrySceneId = 'hidden')],
  [
    'unbound semantic evidence',
    (f) =>
      (f.room.scenePresence.scenes[0].evidence = {
        kind: 'accepted_story_plan',
        reference: 'other',
      }),
  ],
])
  test(`reconstructs ${name} from source canon without extra contacts`, () => {
    const f = fixture();
    const expected = compileStoryPlan(f.source, f.proposal).playable;
    mutate(f);
    const repaired = compileStoryPlan(f.source, f.proposal).playable;
    assert.deepEqual(repaired.maps.tower.scenePresence, expected.maps.tower.scenePresence);
    assert.equal(repaired.entities[f.npc].sceneId, 'welcome');
  });
test('no authored encounter still permits a player-only entry and isolated offstage NPC', () => {
  const f = fixture();
  f.source.content.scenes = [];
  f.source.content.startSceneId = '';
  f.room.scenePresence.scenes[0].participantIds = [];
  f.room.scenePresence.scenes[0].evidence = { kind: 'accepted_story_plan', reference: 'tower' };
  f.room.scenePresence.scenes.push({
    id: 'offstage',
    participantIds: [f.npc],
    evidence: { kind: 'accepted_story_plan', reference: 'tower' },
  });
  f.proposal.npcs[0].sceneId = 'offstage';
  assert.equal(
    compileStoryPlan(f.source, f.proposal).playable.maps.tower.spatialMode,
    'location_only',
  );
});
test('malformed scene IDs and extra private payload are rejected', () => {
  const f = fixture();
  f.room.scenePresence.scenes[0].privateFacts = ['secret'];
  assert.throws(() => compileStoryPlan(f.source, f.proposal));
  delete f.room.scenePresence.scenes[0].privateFacts;
  f.room.scenePresence.scenes[0].id = '__proto__';
  assert.throws(() => compileStoryPlan(f.source, f.proposal));
  assert.equal(storyPlanDefinition.version, 'authored-story-plan-v12-server-placement');
});
for (const text of [
  'Keeper is absent.',
  'Ask about Keeper.',
  'Keeper lives upstairs, visitors wait downstairs.',
])
  test(`prose is never encounter authority: ${text}`, () => {
    const f = fixture();
    delete f.source.content.scenes[0].participantNpcIds;
    f.source.content.scenes[0].description = text;
    const result = compileStoryPlan(f.source, f.proposal).playable;
    const entry = result.maps.tower.scenePresence.scenes.find((s) => s.id === 'welcome');
    assert.deepEqual(entry.participantIds, []);
    assert.notEqual(result.entities[f.npc].sceneId, entry.id);
    assert.equal(result.entities[f.npc].unresolvedScenePresence, undefined);
  });
test('planner cannot redirect the opening to another same-location authored encounter', () => {
  const f = fixture();
  f.source.content.scenes.push({
    id: 'other',
    name: 'Other',
    locationId: 'tower',
    description: '',
    participantNpcIds: [f.npc],
  });
  f.room.scenePresence.scenes[0].id = 'other';
  f.room.scenePresence.scenes[0].evidence.reference = 'other';
  f.room.scenePresence.entrySceneId = 'other';
  f.proposal.npcs[0].sceneId = 'other';
  const result = compileStoryPlan(f.source, f.proposal).playable;
  assert.equal(result.maps.tower.scenePresence.entrySceneId, 'welcome');
  assert.equal(result.entities[f.npc].sceneId, 'welcome');
});
test('unsubstantiated same-location NPC remains isolated offstage and absent from entry scene', () => {
  const f = fixture(),
    hidden = randomUUID();
  f.source.npcs.push({
    id: hidden,
    name: 'Hidden archivist',
    role: 'archivist',
    description: 'Offstage.',
    appearance: 'Coat.',
  });
  f.source.content.npcIds.push(hidden);
  f.room.scenePresence.scenes.push({
    id: 'offstage',
    participantIds: [hidden],
    evidence: { kind: 'accepted_story_plan', reference: 'tower' },
  });
  f.proposal.npcs.push({
    sourceNpcId: hidden,
    locationId: 'tower',
    sceneId: 'offstage',
    stock: [],
  });
  const result = compileStoryPlan(f.source, f.proposal);
  assert.deepEqual(
    result.playable.maps.tower.scenePresence.scenes.find((s) => s.id === 'welcome').participantIds,
    [f.npc],
  );
  f.room.scenePresence.scenes[0].participantIds.push(hidden);
  f.room.scenePresence.scenes.pop();
  f.proposal.npcs[1].sceneId = 'welcome';
  const repaired = compileStoryPlan(f.source, f.proposal).playable;
  assert.deepEqual(repaired.maps.tower.scenePresence.scenes[0].participantIds, [f.npc]);
  assert.notEqual(repaired.entities[hidden].sceneId, repaired.entities[f.npc].sceneId);
  assert.equal(repaired.entities[hidden].unresolvedScenePresence, undefined);
});
test('unanalysed omitted map still retains exact original image without invented geometry or image input', () => {
  const f = fixture();
  const [image] = f.source.omittedMapImages;
  const result = compileStoryPlan(f.source, f.proposal);
  assert.equal(result.playable.maps.tower.spatialMode, 'location_only');
  assert.equal(result.playable.maps.tower.backgroundMode, undefined);
  assert.equal(result.playable.maps.tower.locationImage.revisionId, image.revisionId);
  assert.equal(startMapGroundingCompatible(f.source, result.playable), false);
  f.source.omittedMapImages[0].sha256 = 'f'.repeat(64);
  assert.equal(startMapGroundingCompatible(f.source, result.playable), false);
});
test('unspecified encounter eligibility requires explicit designation and never overrides authored membership', () => {
  const f = fixture();
  f.proposal.npcs[0].presenceUnspecified = true;
  const authored = compileStoryPlan(f.source, f.proposal).draft.npcs[0];
  assert.equal(authored.sceneId, 'welcome');
  assert.equal(authored.unresolvedScenePresence, undefined);
  assert.equal(f.proposal.npcs[0].presenceUnspecified, true, 'input proposal remains unchanged');
  delete f.source.content.scenes[0].participantNpcIds;
  f.room.scenePresence.scenes[0].participantIds = [];
  f.room.scenePresence.scenes.push({
    id: 'unresolved',
    participantIds: [f.npc],
    evidence: { kind: 'accepted_story_plan', reference: 'tower' },
  });
  f.proposal.npcs[0].sceneId = 'unresolved';
  const marked = compileStoryPlan(f.source, f.proposal).draft.npcs[0];
  assert.equal(marked.unresolvedScenePresence.kind, 'unspecified_opening');
  assert.equal(marked.unresolvedScenePresence.sourceSceneId, marked.sceneId);
  assert.match(marked.sceneId, /^offstage_/);
  delete f.proposal.npcs[0].presenceUnspecified;
  assert.equal(
    compileStoryPlan(f.source, f.proposal).draft.npcs[0].unresolvedScenePresence,
    undefined,
  );
});

function threeMapFixture() {
  const f = fixture();
  const locations = ['tower', 'archive', 'garden'];
  const ids = [f.npc, randomUUID(), randomUUID()];
  f.source.content = contentSchema.parse({
    locations: locations.map((id) => ({ id, name: id, description: 'Synthetic location.' })),
    npcIds: ids,
    scenes: [
      {
        id: 'welcome',
        name: 'Opening',
        locationId: 'tower',
        description: 'Unspecified encounter.',
      },
    ],
    startSceneId: 'welcome',
  });
  f.source.npcs = ids.map((id) => ({ ...f.source.npcs[0], id }));
  f.source.omittedMapImages = locations.map((locationId) => ({
    locationId,
    revisionId: randomUUID(),
    sha256: hash(locationId).slice(0, 64),
  }));
  f.proposal.rooms = f.source.omittedMapImages.map((image) => ({
    ...structuredClone(f.room),
    locationId: image.locationId,
    scenePresence: undefined,
  }));
  f.proposal.npcs = ids.map((sourceNpcId, index) => ({
    sourceNpcId,
    locationId: locations[index],
    stock: [],
  }));
  f.proposal.connections = [
    { a: 'tower', b: 'archive' },
    { a: 'archive', b: 'garden' },
  ];
  return { ...f, ids };
}
test('three imaged locations with one untyped opening require no model-built scenes or coordinates', () => {
  const f = threeMapFixture();
  const before = structuredClone(f);
  const { playable } = compileStoryPlan(f.source, f.proposal);
  for (const [id, map] of Object.entries(playable.maps)) {
    assert.equal(map.spatialMode, 'location_only');
    assert.deepEqual(map.spawns, []);
    assert.deepEqual(
      map.scenePresence.scenes.find((s) => s.id === map.scenePresence.entrySceneId).participantIds,
      [],
    );
    const npc = playable.entities[f.proposal.npcs.find((n) => n.locationId === id).sourceNpcId];
    assert.notEqual(npc.sceneId, map.scenePresence.entrySceneId);
    assert.deepEqual(map.scenePresence.scenes.find((s) => s.id === npc.sceneId).participantIds, [
      npc.id,
    ]);
    assert.equal(npc.x, undefined);
    assert.equal(npc.y, undefined);
    assert.equal(npc.unresolvedScenePresence, undefined);
    assert.equal(
      map.locationImage.revisionId,
      f.source.omittedMapImages.find((image) => image.locationId === id).revisionId,
    );
  }
  assert.deepEqual(f, before);
  const first = structuredClone(playable.maps);
  f.proposal.npcs.reverse();
  assert.deepEqual(compileStoryPlan(f.source, f.proposal).playable.maps, first);
});
test('untyped model grouping and bad entry identifiers cannot grant entry contact', () => {
  const f = threeMapFixture();
  for (const room of f.proposal.rooms) {
    const npc = f.proposal.npcs.find((n) => n.locationId === room.locationId);
    room.scenePresence = {
      version: 1,
      entrySceneId: 'missing',
      scenes: [
        {
          id: 'model_group',
          participantIds: [npc.sourceNpcId],
          evidence: { kind: 'accepted_story_plan', reference: room.locationId },
        },
      ],
    };
    npc.sceneId = 'model_group';
  }
  const result = compileStoryPlan(f.source, f.proposal).playable;
  assert.equal(result.maps.tower.scenePresence.entrySceneId, 'welcome');
  for (const npc of f.proposal.npcs) {
    const map = result.maps[npc.locationId];
    assert.notEqual(result.entities[npc.sourceNpcId].sceneId, map.scenePresence.entrySceneId);
    assert.equal(result.entities[npc.sourceNpcId].unresolvedScenePresence, undefined);
  }
});
test('only typed members share their authored non-entry encounter; other same-map NPCs stay isolated', () => {
  const f = threeMapFixture();
  f.source.content.scenes.push({
    id: 'private_archive',
    name: 'Archive',
    locationId: 'archive',
    description: 'PRIVATE_SOURCE_CANARY',
    participantNpcIds: f.ids.slice(1),
  });
  f.proposal.npcs[2].locationId = 'archive';
  const result = compileStoryPlan(f.source, f.proposal).playable;
  const map = result.maps.archive;
  assert.notEqual(map.scenePresence.entrySceneId, 'private_archive');
  assert.deepEqual(
    map.scenePresence.scenes.find((s) => s.id === 'private_archive').participantIds,
    f.ids.slice(1),
  );
  assert.equal(JSON.stringify(map.scenePresence).includes('PRIVATE_SOURCE_CANARY'), false);
  assert.equal(result.entities[f.ids[0]].unresolvedScenePresence, undefined);
});
test('normalization never relocates an authored participant or repairs invalid source identities', () => {
  const f = threeMapFixture();
  f.source.content.scenes[0].participantNpcIds = [f.ids[0]];
  f.proposal.npcs[0].locationId = 'archive';
  const before = structuredClone(f.proposal);
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /STORY_SCENE_PRESENCE_INVALID/);
  assert.deepEqual(f.proposal, before);
  f.proposal.npcs[0].locationId = 'unknown';
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /STORY_SOURCE_MISMATCH/);
  f.proposal.npcs[0].locationId = 'tower';
  f.proposal.npcs[0].sourceNpcId = randomUUID();
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /STORY_SOURCE_MISMATCH/);
});

test('authored opening placement cannot bypass membership by switching to a positioned map', () => {
  const f = threeMapFixture();
  f.source.content.scenes[0].participantNpcIds = [f.ids[0]];
  f.source.omittedMapImages = f.source.omittedMapImages.filter(
    (image) => image.locationId !== 'archive',
  );
  const room = f.proposal.rooms.find((entry) => entry.locationId === 'archive');
  delete room.spatialGrounding;
  room.spawns = [
    { x: 2, y: 2 },
    { x: 3, y: 2 },
    { x: 2, y: 3 },
    { x: 3, y: 3 },
  ];
  for (const npc of f.proposal.npcs.filter((n) => n.locationId === 'archive')) {
    npc.x = 6;
    npc.y = 6;
  }
  f.proposal.npcs[0].locationId = 'archive';
  f.proposal.npcs[0].x = 8;
  f.proposal.npcs[0].y = 8;
  const before = structuredClone(f.proposal);
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /STORY_SCENE_PRESENCE_INVALID/);
  assert.deepEqual(f.proposal, before);
});
