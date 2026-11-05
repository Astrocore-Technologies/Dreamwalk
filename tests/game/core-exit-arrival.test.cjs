const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');

const action = { kind: 'transition', targetId: 'courtyard-exit' };
const point = (entity) => ({ x: entity.x, y: entity.y });
function fixture() {
  const s = g.createObservatoryState(['player']);
  s.rulesetVersion = 'hybrid-v3';
  s.maps = Object.fromEntries(
    ['workshop', 'courtyard'].map((id) => [
      id,
      {
        id,
        width: 24,
        height: 24,
        blocked: [],
        spawns: [{ x: 20, y: 12 }],
        exits: [],
        revision: 0,
      },
    ]),
  );
  s.maps.workshop.exits = [
    {
      id: action.targetId,
      x: 4,
      y: 12,
      destinationMapId: 'courtyard',
      destination: { x: 20, y: 12 },
    },
  ];
  s.entities = {
    player: { ...s.entities.player, mapId: 'workshop', x: 4, y: 11 },
    daro: { id: 'daro', kind: 'npc', mapId: 'courtyard', x: 20, y: 12, revision: 0 },
  };
  s.npcBrains = {};
  return s;
}
function rejectUnchanged(s, error = 'PATH_BLOCKED') {
  const before = structuredClone(s);
  const result = g.applyAction(s, 'player', action);
  assert.equal(result.error, error);
  assert.equal(result.state, s);
  assert.deepEqual(result.events, []);
  assert.deepEqual(s, before);
}
function grounding(s, cell = () => '.') {
  const map = s.maps.courtyard;
  map.spatialGrounding = {
    version: 1,
    imageRevisionId: 'image-revision',
    imageSha256: 'a'.repeat(64),
    confidence: 0.9,
    rows: Array.from({ length: 24 }, (_, y) =>
      Array.from({ length: 24 }, (_, x) => cell(x, y)).join(''),
    ),
    landmarks: [],
  };
  s.artBindings = [
    {
      slot: 'map:courtyard:background',
      revisionId: map.spatialGrounding.imageRevisionId,
      sha256: map.spatialGrounding.imageSha256,
      mime: 'image/png',
      width: 768,
      height: 768,
    },
  ];
}
function companions(s) {
  const draft = g.createCompleteObservatoryDraft();
  const template = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['player']);
  for (const [id, x, y] of [
    ['friend', 7, 11],
    ['guide', 6, 12],
  ]) {
    s.entities[id] = { ...structuredClone(template.entities.keeper), id, mapId: 'workshop', x, y };
    s.npcBrains[id] = structuredClone(template.npcBrains.keeper);
    s.npcBrains[id].living.companionship = { actorId: 'player', crossings: [] };
  }
}

test('Daro occupying courtyard 20,12 admits a deterministic free nearby arrival without moving him', () => {
  const s = fixture();
  s.entities.player.path = [{ x: 4, y: 12 }];
  const before = structuredClone(s);
  const result = g.applyAction(s, 'player', action);
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.player.mapId, 'courtyard');
  assert.deepEqual(point(result.state.entities.player), { x: 20, y: 11 });
  assert.deepEqual(result.state.entities.daro, s.entities.daro);
  assert.deepEqual(result.state.entities.player.path, []);
  assert.equal(
    result.state.entities.player.movementGeneration,
    (s.entities.player.movementGeneration ?? 0) + 1,
  );
  assert.equal(result.state.entities.player.revision, s.entities.player.revision + 1);
  assert.equal(result.state.revision, s.revision + 1);
  assert.equal(result.state.tick, s.tick);
  assert.deepEqual(result.events, [
    { kind: 'actor.transitioned', actorId: 'player', mapId: 'courtyard' },
  ]);
  assert.deepEqual(s, before);
  assert.deepEqual(g.applyAction(JSON.parse(JSON.stringify(s)), 'player', action), result);
  const repeated = g.applyAction(JSON.parse(JSON.stringify(result.state)), 'player', action);
  assert.equal(repeated.error, 'TARGET_UNAVAILABLE');
  assert.deepEqual(repeated.state, result.state);
});

test('unoccupied exact arrivals and ordinary movement collision are unchanged', () => {
  const s = fixture();
  assert.equal(g.walkable(s, 'courtyard', { x: 20, y: 12 }, 'player', true), false);
  delete s.entities.daro;
  assert.deepEqual(point(g.applyAction(s, 'player', action).state.entities.player), {
    x: 20,
    y: 12,
  });
});

for (const size of ['large', 'huge'])
  test(`${size} arrival and resident footprints do not overlap at the selected landing`, () => {
    const s = fixture();
    s.entities.player.tokenSize = size;
    s.entities.daro.tokenSize = size;
    const result = g.applyAction(s, 'player', action);
    assert.equal(result.error, undefined);
    assert.deepEqual(point(result.state.entities.player), {
      x: 20,
      y: 12 - g.footprintCells(s.entities.player),
    });
    assert.equal(
      g.footprintOverlaps(result.state.entities.player, result.state.entities.daro),
      false,
    );
    assert.deepEqual(result.state.entities.daro, s.entities.daro);
  });

test('same-map large arrival retains its footprint even when the original landing overlaps itself', () => {
  const s = fixture();
  s.entities.player.tokenSize = 'large';
  Object.assign(s.entities.player, { mapId: 'courtyard', x: 19, y: 13 });
  s.entities.daro.x = 21;
  s.maps.courtyard.exits = [{ ...s.maps.workshop.exits[0], x: 19, y: 12 }];
  const result = g.applyAction(s, 'player', action);
  assert.equal(result.error, undefined);
  assert.deepEqual(point(result.state.entities.player), { x: 19, y: 12 });
  assert.equal(
    g.footprintOverlaps(result.state.entities.player, result.state.entities.daro),
    false,
  );
});

for (const [name, mutate] of [
  ['wall at intended landing', (s) => s.maps.courtyard.blocked.push({ x: 20, y: 12 })],
  [
    'closed door at intended landing',
    (s) => {
      s.entities.door = {
        id: 'door',
        kind: 'door',
        mapId: 'courtyard',
        x: 20,
        y: 12,
        open: false,
        revision: 0,
      };
    },
  ],
  [
    'invalid full footprint',
    (s) => {
      s.entities.player.tokenSize = 'huge';
      s.maps.workshop.exits[0].destination.x = 23;
    },
  ],
  [
    'closed source door',
    (s) => {
      s.entities.door = {
        id: 'door',
        kind: 'door',
        mapId: 'workshop',
        x: 4,
        y: 12,
        open: false,
        revision: 0,
      };
      s.maps.workshop.exits[0].doorId = 'door';
    },
  ],
])
  test(`occupancy fallback does not rescue ${name}`, () => {
    const s = fixture();
    mutate(s);
    rejectUnchanged(s);
  });

test('a disconnected room is not a fallback when the occupied landing is enclosed by walls', () => {
  const s = fixture();
  s.maps.courtyard.blocked = [
    { x: 20, y: 11 },
    { x: 19, y: 12 },
    { x: 21, y: 12 },
    { x: 20, y: 13 },
  ];
  companions(s);
  rejectUnchanged(s);
});

for (const kind of ['door', 'npc'])
  test(`search cannot cross a ${kind} outside the original occupied landing`, () => {
    const s = fixture();
    s.maps.courtyard.blocked = [
      { x: 20, y: 11 },
      { x: 19, y: 12 },
      { x: 20, y: 13 },
    ];
    s.entities.barrier = {
      id: 'barrier',
      kind,
      mapId: 'courtyard',
      x: 21,
      y: 12,
      open: false,
      revision: 0,
    };
    rejectUnchanged(s);
  });

test('nearby means at most four cardinal steps, never an arbitrary free cell on the map', () => {
  const s = fixture();
  s.entities.player.tokenSize = 'huge';
  s.maps.workshop.exits[0].destination = { x: 10, y: 10 };
  delete s.entities.daro;
  for (const x of [8, 12])
    for (const y of [8, 12]) {
      const id = `resident-${x}-${y}`;
      s.entities[id] = {
        id,
        kind: 'npc',
        mapId: 'courtyard',
        x,
        y,
        tokenSize: 'huge',
        revision: 0,
      };
    }
  assert.equal(g.walkable(s, 'courtyard', { x: 10, y: 5 }, 'player', true), true);
  rejectUnchanged(s);
});

test('planning encounters block fallback footprints and preserve exact-landing WRONG_MODE', () => {
  const s = fixture();
  s.encounters.conflict = {
    id: 'conflict',
    mapId: 'courtyard',
    phase: 'planning',
    area: { x: 19, y: 10, width: 3, height: 2 },
  };
  const result = g.applyAction(s, 'player', action);
  assert.equal(result.error, undefined);
  assert.deepEqual(point(result.state.entities.player), { x: 19, y: 12 });
  s.encounters.conflict.area = { x: 20, y: 12, width: 1, height: 1 };
  rejectUnchanged(s, 'WRONG_MODE');
});

test('large fallback cannot clip a wall or active encounter beyond its anchor', () => {
  const s = fixture();
  s.entities.player.tokenSize = 'large';
  s.entities.daro.tokenSize = 'large';
  s.maps.courtyard.blocked = [{ x: 21, y: 10 }];
  s.encounters.conflict = {
    id: 'conflict',
    mapId: 'courtyard',
    phase: 'planning',
    area: { x: 19, y: 13, width: 1, height: 1 },
  };
  const result = g.applyAction(s, 'player', action);
  assert.equal(result.error, undefined);
  assert.deepEqual(point(result.state.entities.player), { x: 22, y: 12 });
});

test('occupied grounded arrival selects connected observed floor and preserves raster evidence', () => {
  const s = fixture();
  grounding(s);
  const result = g.applyAction(s, 'player', action);
  assert.equal(result.error, undefined);
  assert.deepEqual(point(result.state.entities.player), { x: 20, y: 11 });
  assert.deepEqual(result.state.maps.courtyard, s.maps.courtyard);
  assert.deepEqual(result.state.artBindings, s.artBindings);
});

for (const unsafe of ['?', '#', '~', 'X', 'D'])
  test(`fallback never traverses image ${unsafe} cells to reach disconnected floor`, () => {
    const s = fixture();
    grounding(s, (x, y) => (Math.abs(x - 20) + Math.abs(y - 12) === 1 ? unsafe : '.'));
    rejectUnchanged(s);
  });

test('unknown destination footprint is not rescued by nearby image floor', () => {
  const s = fixture();
  s.entities.player.tokenSize = 'large';
  grounding(s, (x, y) => (x === 21 && y === 13 ? '?' : '.'));
  rejectUnchanged(s);
});

test('observed but spawn-disconnected exact landing remains unavailable', () => {
  const s = fixture();
  s.maps.courtyard.spawns = [{ x: 1, y: 1 }];
  grounding(s, (x, y) => ((x === 1 && y === 1) || (x >= 18 && y >= 10) ? '.' : '?'));
  rejectUnchanged(s);
});

for (const [name, mutate] of [
  [
    'stale revision',
    (s) => {
      s.artBindings[0].revisionId = 'other';
    },
  ],
  [
    'wrong image hash',
    (s) => {
      s.artBindings[0].sha256 = 'b'.repeat(64);
    },
  ],
  [
    'missing image binding',
    (s) => {
      s.artBindings = [];
    },
  ],
  [
    'low confidence',
    (s) => {
      s.maps.courtyard.spatialGrounding.confidence = 0.849;
    },
  ],
])
  test(`occupied arrival still rejects ${name}`, () => {
    const s = fixture();
    grounding(s);
    mutate(s);
    rejectUnchanged(s, 'TARGET_UNAVAILABLE');
  });

test('two accepted companions keep witnessed routes and follow later with normal world-action budgets', () => {
  let s = fixture();
  companions(s);
  s = g.initializeTurnController(s, ['player']).state;
  const before = structuredClone(s);
  const crossed = g.applyTurnAction(s, 'player', action, g.turnFence(s));
  assert.equal(crossed.error, undefined);
  assert.equal(
    crossed.state.turnController.resources.player.additional,
    s.turnController.resources.player.additional - 1,
  );
  assert.equal(
    crossed.state.turnController.resources.player.movement,
    s.turnController.resources.player.movement,
  );
  assert.equal(crossed.state.tick, s.tick + 1);
  const crossing = { mapId: 'workshop', exitId: action.targetId, destinationMapId: 'courtyard' };
  for (const id of ['friend', 'guide']) {
    assert.deepEqual(crossed.state.entities[id], s.entities[id]);
    assert.deepEqual(crossed.state.npcBrains[id].living.companionship.crossings, [crossing]);
    assert.equal(
      g.applyWorldTurnAction(
        crossed.state,
        id,
        g.companionAction(crossed.state, id),
        g.turnFence(crossed.state),
      ).error,
      'WRONG_MODE',
    );
  }
  assert.deepEqual(s, before);
  const ended = g.endPlayerTurn(crossed.state, 'player', g.turnFence(crossed.state));
  assert.equal(ended.error, undefined);
  s = ended.state;
  for (const id of ['friend', 'guide']) {
    const movement = g.companionAction(s, id);
    assert.equal(movement.kind, 'move_to');
    const moved = g.applyWorldTurnAction(s, id, movement, g.turnFence(s));
    assert.equal(moved.error, undefined);
    s = moved.state;
    const follow = g.companionAction(s, id);
    assert.deepEqual(follow, action);
    assert.equal(g.applyWorldTurnAction(s, id, follow, g.turnFence(s)).error, 'ROUND_LOCKED');
    assert.equal(s.entities[id].mapId, 'workshop');
    assert.deepEqual(s.npcBrains[id].living.companionship.crossings, [crossing]);
  }
  const nextRound = g.finishWorldPhase(s, g.turnFence(s));
  assert.equal(nextRound.error, undefined);
  const nextWorld = g.endPlayerTurn(nextRound.state, 'player', g.turnFence(nextRound.state));
  assert.equal(nextWorld.error, undefined);
  s = nextWorld.state;
  for (const id of ['friend', 'guide']) {
    const follow = g.companionAction(s, id);
    assert.deepEqual(follow, action);
    const restored = JSON.parse(JSON.stringify(s));
    const followed = g.applyWorldTurnAction(s, id, follow, g.turnFence(s));
    assert.equal(followed.error, undefined);
    assert.deepEqual(
      g.applyWorldTurnAction(restored, id, follow, g.turnFence(restored)),
      JSON.parse(JSON.stringify(followed)),
    );
    s = followed.state;
    assert.equal(s.entities[id].mapId, 'courtyard');
    assert.deepEqual(point(s.entities[id]), { x: id === 'friend' ? 19 : 21, y: 12 });
    assert.deepEqual(s.npcBrains[id].living.companionship.crossings, []);
    assert.equal(s.turnController.worldNpcActions[id], 1);
    for (const other of Object.values(s.entities).filter(
      (e) => e.mapId === 'courtyard' && e.id !== id,
    ))
      assert.equal(g.footprintOverlaps(s.entities[id], other), false);
  }
  assert.deepEqual(s.entities.daro, before.entities.daro);
});

test('no valid space spends no turn budget and preserves companions and their routes', () => {
  let s = fixture();
  companions(s);
  s.maps.courtyard.blocked = [
    { x: 20, y: 11 },
    { x: 19, y: 12 },
    { x: 21, y: 12 },
    { x: 20, y: 13 },
  ];
  s = g.initializeTurnController(s, ['player']).state;
  rejectUnchanged(s);
});
