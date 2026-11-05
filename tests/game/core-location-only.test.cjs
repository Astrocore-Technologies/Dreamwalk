const test = require('node:test');
const assert = require('node:assert/strict');
const core = require(process.env.DREAMWALK_CORE_SOURCE ?? '../../packages/game-core/dist');
const { runtimeMapView, travelToLocation } = core;
const {
  gameProjectionSchema,
  authoredGameDraftSchema,
  hasPosition,
  occupiedCells,
} = require('@dreamwalk/contracts');
function draft() {
  const d = core.createAuthoredDraft();
  d.maps = [
    {
      id: 'observatory',
      label: 'The real map',
      width: 24,
      height: 24,
      spatialMode: 'location_only',
      blocked: [],
      spawns: [],
      exits: [],
      scenePresence: {
        version: 1,
        entrySceneId: 'opening',
        scenes: [
          {
            id: 'opening',
            participantIds: ['keeper'],
            evidence: { kind: 'authored_scene', reference: 'source-opening' },
          },
          {
            id: 'private-room',
            participantIds: ['hidden'],
            evidence: { kind: 'authored_scene', reference: 'source-private' },
          },
        ],
      },
    },
    {
      id: 'garden',
      label: 'Garden',
      width: 24,
      height: 24,
      spatialMode: 'location_only',
      blocked: [],
      spawns: [],
      exits: [],
      scenePresence: {
        version: 1,
        entrySceneId: 'garden-entry',
        scenes: [
          {
            id: 'garden-entry',
            participantIds: [],
            evidence: { kind: 'authored_scene', reference: 'source-garden' },
          },
        ],
      },
    },
  ];
  d.objects = [];
  d.npcs = [
    {
      id: 'keeper',
      label: 'Keeper',
      mapId: 'observatory',
      spatialMode: 'location_only',
      sceneId: 'opening',
      visual: 'keeper',
      goal: 'help',
    },
    {
      id: 'hidden',
      label: 'Hidden identity',
      mapId: 'observatory',
      spatialMode: 'location_only',
      sceneId: 'private-room',
      visual: 'keeper',
      goal: 'help',
    },
  ];
  return d;
}
function state() {
  const checked = core.compilePlayableDraft(draft());
  assert.deepEqual(checked.errors, []);
  return core.createStateFromPlayable(checked.playable, ['player-one']);
}
test('location-only authored compilation and reload contain no invented positions or spawns', () => {
  const s = state();
  assert.deepEqual(core.validateMapState(s), []);
  for (const e of Object.values(s.entities)) {
    assert.equal(hasPosition(e), false);
    assert.equal('x' in e, false);
    assert.equal('y' in e, false);
    assert.deepEqual(occupiedCells(e), []);
  }
  assert.deepEqual(s.maps.observatory.spawns, []);
  assert.deepEqual(core.validateMapState(JSON.parse(JSON.stringify(s))), []);
  assert.equal(s.npcBrains.keeper.patrolTarget, undefined);
});
test('canonical scene encounter, not same map, determines identity projection and visibility', () => {
  const s = state(),
    p = core.projectState(s, 'player-one');
  assert.deepEqual(p.entities.map((e) => e.id).sort(), ['keeper', 'player-one']);
  assert.equal(core.visible(s, s.entities['player-one'], s.entities.hidden), false);
  assert.equal(core.visible(s, s.entities['player-one'], s.entities.keeper), true);
  assert.equal(JSON.stringify(p).includes('Hidden identity'), false);
  assert.equal(JSON.stringify(p).includes('source-private'), false);
  assert.equal(p.map.scenePresence.scenes.length, 1);
  assert.equal(gameProjectionSchema.safeParse(p).success, true);
});
test('numeric operations cannot create invisible location-only coordinates', () => {
  const s = state();
  assert.ok(
    core.moveInput(s, 'player-one', { inputSeq: 1, movementGeneration: 0, target: { x: 2, y: 2 } })
      .error,
  );
  assert.ok(core.applyAction(s, 'player-one', { kind: 'move_to', target: { x: 2, y: 2 } }).error);
  assert.ok(core.beginEncounter(s, 'player-one').error);
  assert.equal(core.findPath(s, 'observatory', s.entities['player-one'], { x: 2, y: 2 }), null);
  assert.equal(core.walkable(s, 'observatory', { x: 2, y: 2 }), false);
  assert.equal('x' in s.entities['player-one'], false);
});
test('public inspection and normal conversation targets work without imaginary proximity', () => {
  const s = state();
  assert.equal(
    core.applyAction(s, 'player-one', { kind: 'inspect', targetId: 'keeper' }).error,
    undefined,
  );
  assert.equal(
    core.applyAction(s, 'player-one', { kind: 'talk', targetId: 'keeper' }).error,
    undefined,
  );
  assert.ok(core.applyAction(s, 'player-one', { kind: 'talk', targetId: 'hidden' }).error);
});
test('ordinary semantic travel updates presence atomically and survives return/reload', () => {
  let s = state();
  const moved = travelToLocation(s, 'player-one', 'garden');
  assert.equal(moved.error, undefined);
  s = moved.state;
  assert.equal(s.entities['player-one'].sceneId, 'garden-entry');
  assert.equal(
    s.maps.observatory.scenePresence.scenes[0].participantIds.includes('player-one'),
    false,
  );
  assert.equal(s.maps.garden.scenePresence.scenes[0].participantIds.includes('player-one'), true);
  assert.deepEqual(core.validateMapState(s), []);
  const back = travelToLocation(JSON.parse(JSON.stringify(s)), 'player-one', 'observatory');
  assert.equal(back.error, undefined);
  assert.equal(
    core.visible(back.state, back.state.entities['player-one'], back.state.entities.keeper),
    true,
  );
});
test('runtime observation has no image-derived cells or positioned markers', () => {
  const s = state(),
    v = runtimeMapView(s, ['player-one', 'keeper']);
  assert.equal(v.spatialMode, 'location_only');
  assert.deepEqual(v.markers, []);
  assert.deepEqual(v.visibleCells, []);
  assert.throws(() => runtimeMapView(s, ['player-one', 'hidden']));
});
test('schema rejects hybrid false coordinates, empty positioned spawns and duplicate memberships', () => {
  const d = draft();
  d.npcs[0].x = 0;
  d.npcs[0].y = 0;
  assert.equal(authoredGameDraftSchema.safeParse(d).success, false);
  const bad = draft();
  bad.maps[0].scenePresence.scenes[1].participantIds.push('keeper');
  assert.equal(authoredGameDraftSchema.safeParse(bad).success, false);
  const positioned = core.createAuthoredDraft();
  positioned.maps[0].spawns = [];
  assert.equal(authoredGameDraftSchema.safeParse(positioned).success, false);
});
test('positioned fixtures preserve original collision and numeric admission', () => {
  const checked = core.compilePlayableDraft(core.createAuthoredDraft());
  assert.deepEqual(checked.errors, []);
  const s = core.createStateFromPlayable(checked.playable, ['player-one']);
  assert.equal(hasPosition(s.entities['player-one']), true);
  assert.equal(s.entities['player-one'].spatialMode, undefined);
  assert.deepEqual(core.validateMapState(s), []);
});
test('canonical objects support pickup and unlocked door state without implied collision geometry', () => {
  const d = draft();
  d.objects = [
    {
      id: 'key',
      kind: 'item',
      label: 'Key',
      visual: 'key',
      mapId: 'observatory',
      spatialMode: 'location_only',
      sceneId: 'opening',
    },
    {
      id: 'door',
      kind: 'door',
      label: 'Door',
      visual: 'door',
      mapId: 'observatory',
      spatialMode: 'location_only',
      sceneId: 'opening',
      locked: true,
      keyId: 'key',
    },
  ];
  d.maps[0].scenePresence.scenes[0].participantIds.push('key', 'door');
  const checked = core.compilePlayableDraft(d);
  assert.deepEqual(checked.errors, []);
  let s = core.createStateFromPlayable(checked.playable, ['player-one']);
  for (const action of [
    { kind: 'pick_up', targetId: 'key' },
    { kind: 'unlock', targetId: 'door' },
    { kind: 'open', targetId: 'door' },
  ]) {
    const r = core.applyAction(s, 'player-one', action);
    assert.equal(r.error, undefined);
    s = r.state;
  }
  assert.equal(s.entities.door.open, true);
  assert.equal(s.entities.key.ownerId, 'player-one');
  assert.deepEqual(core.validateMapState(s), []);
  assert.equal('x' in s.entities.key, false);
});
test('mixed-mode travel uses validated destination spawn and never leaves stale location-only tags', () => {
  const d = draft(),
    regular = core.createAuthoredDraft().maps[0];
  regular.id = 'grid';
  regular.exits = [];
  regular.blocked = [];
  d.maps.push(regular);
  const checked = core.compilePlayableDraft(d);
  assert.deepEqual(checked.errors, []);
  let s = core.createStateFromPlayable(checked.playable, ['player-one']);
  const r = travelToLocation(s, 'player-one', 'grid');
  assert.equal(r.error, undefined);
  s = r.state;
  assert.equal(hasPosition(s.entities['player-one']), true);
  assert.equal(s.entities['player-one'].sceneId, undefined);
  assert.deepEqual(core.validateMapState(s), []);
  const back = travelToLocation(s, 'player-one', 'observatory');
  assert.equal(back.error, undefined);
  assert.equal('x' in back.state.entities['player-one'], false);
});
test('authored scene membership is validated and removed from public source reader output', () => {
  const { contentSchema, readerStoryContent } = require('@dreamwalk/contracts');
  const id = '11111111-1111-4111-8111-111111111111';
  const content = contentSchema.parse({
    npcIds: [id],
    locations: [{ id: 'place', name: 'Place' }],
    scenes: [{ id: 'opening', name: 'Opening', locationId: 'place', participantNpcIds: [id] }],
  });
  assert.deepEqual(content.scenes[0].participantNpcIds, [id]);
  const publicContent = readerStoryContent(content);
  assert.equal('participantNpcIds' in publicContent.scenes[0], false);
  assert.deepEqual(content.scenes[0].participantNpcIds, [id]);
  assert.equal(contentSchema.safeParse({ ...content, npcIds: [] }).success, false);
});

test('location-only projection never imports legacy unscoped campaign narration', () => {
  const s = state();
  const turn = {
    id: '11111111-1111-4111-8111-111111111111',
    actorId: 'other-player',
    requestHash: 'old',
    tick: 0,
    narration: 'Unseen legacy account',
    evidenceIds: [],
  };
  s.narrativeCanon = {
    revision: 2,
    turns: [
      turn,
      {
        ...turn,
        id: '22222222-2222-4222-8222-222222222222',
        narration: 'Known original encounter',
        channel: 'public',
        audienceIds: ['player-one', 'keeper'],
      },
    ],
  };
  const projection = core.projectState(s, 'player-one');
  assert.deepEqual(
    projection.narrative.turns.map((t) => t.narration),
    ['Known original encounter'],
  );
});
test('unresolved opening provenance is private and only valid on a source NPC singleton', () => {
  const d = draft(),
    id = '33333333-3333-4333-8333-333333333333';
  d.npcs[1] = {
    ...d.npcs[1],
    id,
    sourceNpcId: id,
    unresolvedScenePresence: {
      kind: 'unspecified_opening',
      sourceMapId: 'observatory',
      sourceSceneId: 'private-room',
      sourceChecksum: 'a'.repeat(64),
    },
  };
  d.maps[0].scenePresence.scenes[1].participantIds = [id];
  const checked = core.compilePlayableDraft(d);
  assert.deepEqual(checked.errors, []);
  const s = core.createStateFromPlayable(checked.playable, ['player-one']);
  assert.equal(s.entities[id].unresolvedScenePresence.sourceChecksum, 'a'.repeat(64));
  s.entities.keeper.unresolvedScenePresence = structuredClone(
    s.entities[id].unresolvedScenePresence,
  );
  const projection = core.projectState(s, 'player-one');
  assert.equal(JSON.stringify(projection).includes('unresolvedScenePresence'), false);
  assert.equal(JSON.stringify(projection).includes('sourceChecksum'), false);
  assert.equal(gameProjectionSchema.safeParse(projection).success, true);
  d.npcs[1].sceneId = 'opening';
  d.npcs[1].unresolvedScenePresence.sourceSceneId = 'opening';
  d.maps[0].scenePresence.scenes[1].participantIds = [];
  d.maps[0].scenePresence.scenes[0].participantIds.push(id);
  assert.ok(core.compilePlayableDraft(d).errors.includes(`npc:${id}:unresolved-source-presence`));
});
