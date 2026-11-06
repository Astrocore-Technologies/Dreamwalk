const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');

const target = { x: 5, y: 4 };
const drop = { kind: 'drop', targetId: 'key', target };
function fixture() {
  const state = g.createObservatoryState(['alice']);
  state.rulesetVersion = 'hybrid-v3';
  state.maps = {
    room: {
      id: 'room',
      width: 24,
      height: 24,
      spawns: [{ x: 2, y: 2 }],
      blocked: [],
      exits: [],
      revision: 0,
    },
  };
  state.entities = {
    alice: { ...state.entities.alice, mapId: 'room', x: 4, y: 4, inventory: ['key'] },
    key: {
      id: 'key',
      kind: 'item',
      mapId: 'old-map',
      x: 18,
      y: 18,
      ownerId: 'alice',
      revision: 7,
      label: 'Cup',
      labelTranslations: { uk: 'Чашка' },
      item: {
        definitionId: 'cup',
        quantity: 3,
        portable: true,
        edible: false,
        restoreVitality: 0,
        visual: 'cup',
        surfaceId: 'old-table',
        surfaceSlot: 3,
      },
    },
  };
  state.npcBrains = {};
  state.artBindings = [];
  return state;
}
function ground(state, cell = () => '.') {
  const map = state.maps.room;
  map.spatialGrounding = {
    version: 1,
    imageRevisionId: '75c0fdec-818c-49fb-a218-74ca3d91e592',
    imageSha256: 'a'.repeat(64),
    confidence: 0.9,
    rows: Array.from({ length: 24 }, (_, y) =>
      Array.from({ length: 24 }, (_, x) => cell(x, y)).join(''),
    ),
    landmarks: [],
  };
  state.artBindings.push({
    slot: 'map:room:background',
    revisionId: map.spatialGrounding.imageRevisionId,
    sha256: map.spatialGrounding.imageSha256,
    mime: 'image/png',
    width: 1024,
    height: 1024,
  });
}
function rejectUnchanged(state, error, action = drop) {
  const before = structuredClone(state);
  const result = g.applyAction(state, 'alice', action);
  assert.equal(result.error, error);
  assert.strictEqual(result.state, state);
  assert.deepEqual(result.events, []);
  assert.deepEqual(state, before);
  return result;
}
function at(state, id, kind, x, y, extra = {}) {
  state.entities[id] = { id, kind, mapId: 'room', x, y, revision: 0, ...extra };
}

test('drop contract requires one existing-item target and an explicit bounded point', () => {
  assert.equal(g.gameActionSchema.safeParse(drop).success, true);
  for (const action of [
    { kind: 'drop', targetId: 'key' },
    { kind: 'drop', target },
    { ...drop, itemId: 'key' },
    { ...drop, mapId: 'room' },
    { ...drop, entity: {} },
    { ...drop, target: { x: -1, y: 4 } },
    { ...drop, target: { x: 5.1, y: 4 } },
    { ...drop, target: { ...target, surfaceId: 'table' } },
  ])
    assert.equal(g.gameActionSchema.safeParse(action).success, false, JSON.stringify(action));
});

test('drop is atomic and preserves the exact item, quantity, metadata and art through pickup', () => {
  const state = fixture();
  ground(state);
  state.artBindings.push({
    slot: 'item:key:portrait',
    revisionId: 'item-art',
    sha256: 'b'.repeat(64),
    mime: 'image/png',
    width: 256,
    height: 256,
  });
  const before = structuredClone(state);
  assert.deepEqual(g.itemDropCandidates(state, 'alice', 'key'), [
    { x: 4, y: 3 },
    { x: 3, y: 4 },
    target,
    { x: 4, y: 5 },
  ]);
  const result = g.applyAction(state, 'alice', drop);
  assert.equal(result.error, undefined);
  assert.deepEqual(state, before);
  const next = result.state;
  assert.deepEqual(Object.keys(next.entities), Object.keys(state.entities));
  assert.deepEqual(next.entities.alice.inventory, []);
  assert.equal(next.entities.key.ownerId, undefined);
  assert.equal(next.entities.key.mapId, 'room');
  assert.deepEqual({ x: next.entities.key.x, y: next.entities.key.y }, target);
  assert.equal(next.entities.key.item.quantity, 3);
  assert.deepEqual(next.entities.key.labelTranslations, state.entities.key.labelTranslations);
  assert.equal(next.entities.key.item.surfaceId, undefined);
  assert.equal(next.entities.key.item.surfaceSlot, 0);
  assert.deepEqual(next.artBindings, state.artBindings);
  assert.equal(next.entities.key.revision, state.entities.key.revision + 1);
  assert.equal(next.entities.alice.revision, state.entities.alice.revision + 1);
  assert.equal(next.revision, state.revision + 1);
  assert.deepEqual(result.events, [
    { kind: 'item.placed', actorId: 'alice', targetId: 'key', mapId: 'room' },
  ]);
  rejectUnchanged(next, 'FORBIDDEN');
  assert.deepEqual(g.itemDropCandidates(next, 'alice', 'key'), []);
  const pickup = g.applyAction(JSON.parse(JSON.stringify(next)), 'alice', {
    kind: 'pick_up',
    targetId: 'key',
  });
  assert.equal(pickup.error, undefined);
  assert.deepEqual(pickup.state.entities.alice.inventory, ['key']);
  assert.equal(pickup.state.entities.key.ownerId, 'alice');
  assert.equal(pickup.state.entities.key.item.quantity, 3);
  assert.equal(pickup.state.entities.key.item.surfaceSlot, undefined);
  assert.deepEqual(Object.keys(pickup.state.entities), Object.keys(state.entities));
});

test('legacy portable items need no invented definition or metadata', () => {
  const state = fixture();
  delete state.entities.key.item;
  state.entities.key.visual = 'key';
  const result = g.dropOwnedItem(state, 'alice', 'key', target);
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.key.item, undefined);
  assert.equal(result.state.entities.key.visual, 'key');
  assert.equal(result.state.entities.key.ownerId, undefined);
});

for (const size of ['large', 'huge'])
  test(`${size} actor reaches its whole perimeter while placing only the item's footprint`, () => {
    const state = fixture();
    state.entities.alice.tokenSize = size;
    const edge = g.footprintCells(state.entities.alice);
    Object.assign(state.entities.alice, { x: 23 - edge, y: 20 });
    ground(state);
    const point = { x: 23, y: 20 + edge - 1 };
    const candidates = g.itemDropCandidates(state, 'alice', 'key');
    assert.equal(candidates.length, edge * 4);
    assert.ok(candidates.some((p) => p.x === point.x && p.y === point.y));
    const result = g.dropOwnedItem(state, 'alice', 'key', point);
    assert.equal(result.error, undefined);
    assert.equal(g.footprintOverlaps(result.state.entities.key, state.entities.alice), false);
    assert.equal(g.occupiedCells(result.state.entities.key).length, 1);
  });

test('drop follows current player map after real transition, including stale held location-only data', () => {
  const state = fixture();
  state.maps.other = { ...structuredClone(state.maps.room), id: 'other', spawns: [{ x: 8, y: 8 }] };
  state.maps.room.exits.push({
    id: 'other-exit',
    x: 4,
    y: 5,
    destinationMapId: 'other',
    destination: { x: 8, y: 8 },
  });
  const moved = g.applyAction(state, 'alice', { kind: 'transition', targetId: 'other-exit' });
  assert.equal(moved.error, undefined);
  assert.equal(moved.state.entities.key.mapId, 'old-map');
  const next = moved.state;
  delete next.entities.key.x;
  delete next.entities.key.y;
  Object.assign(next.entities.key, { spatialMode: 'location_only', sceneId: 'old-scene' });
  const result = g.applyAction(next, 'alice', { ...drop, target: { x: 9, y: 8 } });
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.key.mapId, 'other');
  assert.equal(result.state.entities.key.spatialMode, undefined);
  assert.equal(result.state.entities.key.sceneId, undefined);
  assert.equal(result.state.entities.key.x, 9);
});

for (const [name, mutate, error] of [
  ['missing item', (s) => delete s.entities.key, 'FORBIDDEN'],
  [
    'foreign owner',
    (s) => {
      s.entities.key.ownerId = 'bob';
    },
    'FORBIDDEN',
  ],
  ['unowned item', (s) => delete s.entities.key.ownerId, 'FORBIDDEN'],
  [
    'stale inventory membership',
    (s) => {
      s.entities.alice.inventory = [];
    },
    'FORBIDDEN',
  ],
  ['duplicate inventory membership', (s) => s.entities.alice.inventory.push('key'), 'FORBIDDEN'],
  [
    'wrong entity kind',
    (s) => {
      s.entities.key.kind = 'door';
    },
    'FORBIDDEN',
  ],
  [
    'nonportable item',
    (s) => {
      s.entities.key.item.portable = false;
    },
    'FORBIDDEN',
  ],
  [
    'unconscious player',
    (s) => {
      s.entities.alice.lifeState = 'unconscious';
    },
    'FORBIDDEN',
  ],
  [
    'NPC owner',
    (s) => {
      s.entities.alice.kind = 'npc';
    },
    'FORBIDDEN',
  ],
  [
    'unknown player position',
    (s) => {
      delete s.entities.alice.x;
    },
    'WRONG_MODE',
  ],
  [
    'location-only map',
    (s) => {
      s.maps.room.spatialMode = 'location_only';
    },
    'WRONG_MODE',
  ],
  [
    'active actor encounter',
    (s) => {
      s.entities.alice.encounterId = 'fight';
    },
    'WRONG_MODE',
  ],
  [
    'active encounter under actor',
    (s) => {
      s.encounters.fight = {
        id: 'fight',
        mapId: 'room',
        phase: 'planning',
        area: { x: 4, y: 4, width: 1, height: 1 },
      };
    },
    'WRONG_MODE',
  ],
])
  test(`${name} denies the drop without loss or mutation`, () => {
    const state = fixture();
    mutate(state);
    rejectUnchanged(state, error);
    assert.deepEqual(g.itemDropCandidates(state, 'alice', 'key'), []);
  });

for (const [name, mutate, error = 'PATH_BLOCKED'] of [
  ['blocked cell', (s) => s.maps.room.blocked.push(target)],
  ['closed door', (s) => at(s, 'door', 'door', 5, 4, { open: false })],
  ['player occupant', (s) => at(s, 'bob', 'player', 5, 4)],
  ['large NPC footprint', (s) => at(s, 'npc', 'npc', 5, 3, { tokenSize: 'large' })],
  ['huge NPC footprint', (s) => at(s, 'npc', 'npc', 5, 2, { tokenSize: 'huge' })],
  [
    'target encounter',
    (s) => {
      s.encounters.fight = {
        id: 'fight',
        mapId: 'room',
        phase: 'planning',
        area: { x: 5, y: 4, width: 1, height: 1 },
      };
    },
    'WRONG_MODE',
  ],
])
  test(`${name} excludes the exact placement without mutating either entity`, () => {
    const state = fixture();
    mutate(state);
    rejectUnchanged(state, error);
    assert.equal(
      g.itemDropCandidates(state, 'alice', 'key').some((p) => p.x === 5 && p.y === 4),
      false,
    );
  });

test('actor overlap, diagonal reach and points beyond map bounds are denied', () => {
  const state = fixture();
  for (const point of [
    { x: 4, y: 4 },
    { x: 5, y: 5 },
    { x: 9, y: 4 },
  ])
    rejectUnchanged(state, 'OUT_OF_RANGE', { ...drop, target: point });
  state.entities.alice.x = 23;
  rejectUnchanged(state, 'PATH_BLOCKED', { ...drop, target: { x: 24, y: 4 } });
  for (const point of [null, { x: -1, y: 4 }, { x: 4.5, y: 4 }, { x: Infinity, y: 4 }])
    assert.equal(g.dropOwnedItem(state, 'alice', 'key', point).error, 'INVALID_ACTION');
});

for (const [name, mutate, error = 'TARGET_UNAVAILABLE'] of [
  ['missing image geometry', (s) => delete s.maps.room.spatialGrounding],
  [
    'missing binding',
    (s) => {
      s.artBindings = [];
    },
  ],
  [
    'stale image revision',
    (s) => {
      s.artBindings[0].revisionId = 'new-revision';
    },
  ],
  [
    'mismatched image hash',
    (s) => {
      s.artBindings[0].sha256 = 'b'.repeat(64);
    },
  ],
  [
    'low confidence',
    (s) => {
      s.maps.room.spatialGrounding.confidence = 0.84;
    },
  ],
  [
    'unknown anchor',
    (s) => {
      s.maps.room.spawns = [{ x: 24, y: 24 }];
    },
  ],
])
  test(`${name} never falls back to authored movement geometry`, () => {
    const state = fixture();
    ground(state);
    mutate(state);
    rejectUnchanged(state, error);
    assert.deepEqual(g.itemDropCandidates(state, 'alice', 'key'), []);
  });

test('locationImage cannot silently lose image evidence or use another bound revision/hash', () => {
  for (const mutate of [
    (s) => {
      delete s.maps.room.spatialGrounding;
      s.artBindings = [];
    },
    (s) => {
      delete s.maps.room.spatialGrounding;
    },
    (s) => {
      s.artBindings = [];
    },
    (s) => {
      s.maps.room.locationImage.revisionId = 'different-image';
    },
    (s) => {
      s.maps.room.locationImage.sha256 = 'b'.repeat(64);
    },
  ]) {
    const state = fixture();
    ground(state);
    state.maps.room.locationImage = {
      revisionId: state.artBindings[0].revisionId,
      sha256: state.artBindings[0].sha256,
    };
    mutate(state);
    rejectUnchanged(state, 'TARGET_UNAVAILABLE');
    assert.deepEqual(g.itemDropCandidates(state, 'alice', 'key'), []);
  }
  const state = fixture();
  ground(state);
  state.maps.room.locationImage = {
    revisionId: state.artBindings[0].revisionId,
    sha256: state.artBindings[0].sha256,
  };
  assert.equal(g.dropOwnedItem(state, 'alice', 'key', target).error, undefined);
});

for (const cell of ['?', '#', 'X', '~', 'D'])
  test(`image ${cell} is not verified ground even when ordinary movement allows it`, () => {
    const state = fixture();
    ground(state, (x, y) => (x === 5 && y === 4 ? cell : '.'));
    assert.equal(g.walkable(state, 'room', target, 'alice'), true);
    rejectUnchanged(state, 'PATH_BLOCKED');
  });

test('disconnected ground and entirely blocked perimeter yield no placement candidates', () => {
  const state = fixture();
  ground(state, (x, y) => (x === 3 || y === 3 ? '#' : '.'));
  rejectUnchanged(state, 'PATH_BLOCKED');
  assert.deepEqual(g.itemDropCandidates(state, 'alice', 'key'), []);
  delete state.maps.room.spatialGrounding;
  state.artBindings = [];
  state.maps.room.blocked = [{ x: 4, y: 3 }, { x: 3, y: 4 }, target, { x: 4, y: 5 }];
  assert.deepEqual(g.itemDropCandidates(state, 'alice', 'key'), []);
  rejectUnchanged(state, 'PATH_BLOCKED');
});

test('ground stacks are bounded and legacy/duplicate slots reserve capacity without cloning', () => {
  const state = fixture();
  state.worldItemRules = { version: 1, inventoryCapacity: 8, maxWorldItems: 8, surfaceCapacity: 4 };
  at(state, 'a', 'item', 5, 4);
  at(state, 'b', 'item', 5, 4, { item: { ...state.entities.key.item, surfaceSlot: 2 } });
  at(state, 'c', 'item', 5, 4, { item: { ...state.entities.key.item, surfaceSlot: 2 } });
  const placed = g.dropOwnedItem(state, 'alice', 'key', target);
  assert.equal(placed.error, undefined);
  assert.equal(placed.state.entities.key.item.surfaceSlot, 3);
  assert.deepEqual(placed.state.entities.a, state.entities.a);
  assert.deepEqual(placed.state.entities.b, state.entities.b);
  assert.deepEqual(placed.state.entities.c, state.entities.c);
  at(state, 'd', 'item', 5, 4);
  rejectUnchanged(state, 'PATH_BLOCKED');
  assert.equal(
    g.itemDropCandidates(state, 'alice', 'key').some((p) => p.x === 5 && p.y === 4),
    false,
  );
});

test('drop preserves legacy resources and respects current turn/fence', () => {
  let state = g.initializeTurnController(fixture(), ['alice']).state;
  const fence = g.turnFence(state);
  const blocked = structuredClone(state);
  blocked.maps.room.blocked.push(target);
  rejectUnchanged(blocked, 'PATH_BLOCKED');
  const result = g.applyTurnAction(state, 'alice', drop, fence);
  assert.equal(result.error, undefined);
  assert.equal(
    result.state.turnController.resources.alice.additional,
    state.turnController.resources.alice.additional,
  );
  assert.equal(
    result.state.turnController.resources.alice.main,
    state.turnController.resources.alice.main,
  );
  assert.equal(result.state.tick, state.tick + 1);
  assert.equal(
    g.applyTurnAction(state, 'alice', drop, { ...fence, phaseEpoch: fence.phaseEpoch + 1 }).error,
    'STALE_STATE',
  );
  for (const mutate of [
    (s) => {
      s.turnController.phase = 'world';
    },
    (s) => {
      s.turnController.activeActorId = 'bob';
    },
    (s) => {
      s.turnController.actorOrder = [];
    },
    (s) => {
      s.turnController.pendingResolution = {};
    },
    (s) => {
      s.turnController.reaction = {};
    },
  ]) {
    const invalid = structuredClone(state);
    mutate(invalid);
    const before = structuredClone(invalid);
    assert.ok(g.dropOwnedItem(invalid, 'alice', 'key', target).error);
    assert.deepEqual(g.itemDropCandidates(invalid, 'alice', 'key'), []);
    assert.deepEqual(invalid, before);
  }
});

function witness(state) {
  const draft = g.createCompleteObservatoryDraft();
  const compiled = g.compilePlayableDraft(draft);
  assert.deepEqual(compiled.errors, []);
  const template = g.createStateFromPlayable(compiled.playable, ['alice']);
  state.entities.keeper = { ...template.entities.keeper, mapId: 'room', x: 7, y: 4 };
  state.npcBrains.keeper = template.npcBrains.keeper;
}

test('item.placed witness records committed after-map/point rather than the held item or actor anchor', () => {
  const state = fixture();
  ground(state);
  witness(state);
  const result = g.applyAction(state, 'alice', drop);
  assert.equal(result.error, undefined);
  const recorded = g.recordNpcEvents(state, result.state, result.events, 'drop-on-floor').state;
  const observation = recorded.npcBrains.keeper.living.observations.find(
    (o) => o.kind === 'item_placed',
  );
  assert.ok(observation);
  assert.equal(observation.targetId, 'key');
  assert.equal(observation.actorId, 'alice');
  assert.equal(observation.mapId, 'room');
  assert.deepEqual(observation.point, target);
  assert.equal(observation.confidence, 'witnessed');
  const replay = g.recordNpcEvents(state, recorded, result.events, 'drop-on-floor').state;
  assert.equal(
    replay.npcBrains.keeper.living.observations.filter((o) => o.kind === 'item_placed').length,
    1,
  );
});

test('seeing only the actor cannot reveal a hidden placement behind a wall', () => {
  const state = fixture();
  witness(state);
  Object.assign(state.entities.keeper, { x: 4, y: 6 });
  state.maps.room.blocked.push({ x: 5, y: 5 });
  assert.equal(g.visible(state, state.entities.keeper, state.entities.alice), true);
  const result = g.applyAction(state, 'alice', drop);
  assert.equal(result.error, undefined);
  assert.equal(
    g.visible(result.state, result.state.entities.keeper, result.state.entities.key),
    false,
  );
  const recorded = g.recordNpcEvents(state, result.state, result.events, 'hidden-drop').state;
  assert.equal(
    recorded.npcBrains.keeper.living.observations.some((o) => o.kind === 'item_placed'),
    false,
  );
});
