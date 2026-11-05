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
    mapImages: [image],
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
    spatialGrounding: {
      version: 1,
      imageRevisionId: image.revisionId,
      imageSha256: image.sha256,
      confidence: 0.2,
      rows: Array(24).fill('?'.repeat(24)),
      landmarks: [],
    },
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
    revisionId: source.mapImages[0].revisionId,
    sha256: source.mapImages[0].sha256,
  });
  for (const key of ['spawns', 'blocked', 'exits']) assert.deepEqual(map[key], []);
  assert.equal(map.spatialGrounding, undefined);
  assert.equal(map.composition, undefined);
  assert.equal(draft.npcs[0].sceneId, 'welcome');
  assert.equal(draft.npcs[0].x, undefined);
  assert.equal(draft.npcs[0].y, undefined);
  assert.equal(draft.npcs[0].sourceNpcId, npc);
  assert.equal(startMapGroundingCompatible(source, playable), true);
  assert.equal(
    startMapGroundingCompatible(
      { ...source, mapImages: [{ ...source.mapImages[0], sha256: hash('changed') }] },
      playable,
    ),
    false,
  );
});
test('old discarded uncertainty without semantic proposal is not retroactively recovered', () => {
  const { source, proposal, room } = fixture();
  delete room.scenePresence;
  assert.throws(() => compileStoryPlan(source, proposal), /MAP_IMAGE_UNCERTAIN/);
});
test('source and image identity remain mandatory for semantic fallback', () => {
  const { source, proposal, room } = fixture();
  room.spatialGrounding.imageSha256 = hash('other');
  assert.throws(() => compileStoryPlan(source, proposal), /MAP_IMAGE_SOURCE_MISMATCH/);
});
for (const [name, mutate] of [
  ['foreign member', (f) => f.room.scenePresence.scenes[0].participantIds.push(randomUUID())],
  ['duplicate member', (f) => f.room.scenePresence.scenes[0].participantIds.push(f.npc)],
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
  test(`rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => compileStoryPlan(f.source, f.proposal), /STORY_SCENE_PRESENCE_INVALID/);
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
  assert.equal(storyPlanDefinition.version, 'authored-story-plan-v8-location-presence');
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
    assert.throws(() => compileStoryPlan(f.source, f.proposal), /EVIDENCE_REQUIRED/);
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
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /STORY_SCENE_ENTRY_INVALID/);
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
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /EVIDENCE_REQUIRED/);
});
test('unanalysed omitted map still retains exact original image without invented geometry or image input', () => {
  const f = fixture();
  const [image] = f.source.mapImages;
  delete f.source.mapImages;
  f.source.omittedMapImages = [
    { locationId: image.locationId, revisionId: image.revisionId, sha256: image.sha256 },
  ];
  delete f.room.spatialGrounding;
  const result = compileStoryPlan(f.source, f.proposal);
  assert.equal(result.playable.maps.tower.spatialMode, 'location_only');
  assert.equal(result.playable.maps.tower.backgroundMode, undefined);
  assert.equal(result.playable.maps.tower.locationImage.revisionId, image.revisionId);
  assert.equal(startMapGroundingCompatible(f.source, result.playable), true);
  f.source.omittedMapImages[0].sha256 = 'f'.repeat(64);
  assert.equal(startMapGroundingCompatible(f.source, result.playable), false);
});
test('unspecified encounter eligibility requires explicit designation and never overrides authored membership', () => {
  const f = fixture();
  f.proposal.npcs[0].presenceUnspecified = true;
  assert.throws(() => compileStoryPlan(f.source, f.proposal), /STORY_UNRESOLVED_PRESENCE_INVALID/);
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
  assert.equal(marked.unresolvedScenePresence.sourceSceneId, 'unresolved');
  delete f.proposal.npcs[0].presenceUnspecified;
  assert.equal(
    compileStoryPlan(f.source, f.proposal).draft.npcs[0].unresolvedScenePresence,
    undefined,
  );
});
