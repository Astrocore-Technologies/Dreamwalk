const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
const state = () => g.createObservatoryState(['alice', 'bob'], 42);
function place(s, id, x, y, mapId = 'observatory') {
  s.entities[id].x = x;
  s.entities[id].y = y;
  s.entities[id].mapId = mapId;
  return s;
}
test('fixture validates, immutable deterministic movement follows bounded server ticks', () => {
  const s = state();
  assert.deepEqual(g.validateMapState(s), []);
  const input = { inputSeq: 1, movementGeneration: 0, target: { x: 5, y: 6 } };
  const r = g.moveInput(s, 'alice', input);
  assert.equal(s.entities.alice.path, undefined);
  assert.deepEqual(g.tick(r.state, 12), g.tick(r.state, 12));
  assert.equal(g.tick(r.state, 12).state.entities.alice.x, 5);
  assert.equal(g.moveInput(r.state, 'alice', input).error, 'STALE_STATE');
  assert.equal(
    g.moveInput(s, 'alice', { ...input, target: { x: 10, y: 3 } }).error,
    'PATH_BLOCKED',
  );
});
test('only existing adjacent unique key transfers; inventory and FOV are private', () => {
  const s = place(state(), 'alice', 4, 6);
  place(s, 'bob', 4, 6);
  const r = g.applyAction(s, 'alice', { kind: 'pick_up', targetId: 'key' });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.state.entities.alice.inventory, ['key']);
  assert.equal(
    g.applyAction(r.state, 'bob', { kind: 'pick_up', targetId: 'key' }).error,
    'TARGET_UNAVAILABLE',
  );
  const view = g.projectState(r.state, 'bob');
  assert.equal(
    view.entities.some((e) => e.id === 'key'),
    false,
  );
  assert.equal(view.entities.find((e) => e.id === 'alice').inventory, undefined);
  assert.equal(
    view.entities.some((e) => e.id === 'token'),
    false,
  );
});
test('range, locked door and transition rules', () => {
  let s = state();
  assert.equal(
    g.applyAction(s, 'alice', { kind: 'pick_up', targetId: 'key' }).error,
    'OUT_OF_RANGE',
  );
  s = place(s, 'alice', 4, 6);
  s = g.applyAction(s, 'alice', { kind: 'pick_up', targetId: 'key' }).state;
  s = place(s, 'alice', 9, 5);
  assert.equal(g.applyAction(s, 'alice', { kind: 'open', targetId: 'door' }).error, 'FORBIDDEN');
  s = g.applyAction(s, 'alice', { kind: 'unlock', targetId: 'door' }).state;
  s = g.applyAction(s, 'alice', { kind: 'open', targetId: 'door' }).state;
  assert.ok(g.findPath(s, 'observatory', s.entities.alice, { x: 13, y: 5 }, 'alice'));
  s = place(s, 'alice', 13, 5);
  s = g.applyAction(s, 'alice', { kind: 'transition', targetId: 'roof-exit' }).state;
  assert.equal(s.entities.alice.mapId, 'roof');
  assert.equal(
    g.projectState(s, 'alice').entities.some((e) => e.id === 'bob'),
    false,
  );
});
test('encounter freezes only local actors and rejects stale movement', () => {
  const s = place(state(), 'bob', 2, 3, 'roof');
  const r = g.beginEncounter(s, 'alice', 1000);
  assert.equal(r.error, undefined);
  assert.ok(r.state.entities.alice.encounterId);
  assert.equal(r.state.entities.bob.encounterId, undefined);
  assert.equal(
    g.moveInput(r.state, 'alice', { inputSeq: 1, movementGeneration: 0, target: { x: 3, y: 6 } })
      .error,
    'WRONG_MODE',
  );
  assert.equal(
    g.moveInput(r.state, 'bob', { inputSeq: 1, movementGeneration: 0, target: { x: 4, y: 3 } })
      .error,
    undefined,
  );
  assert.equal(Object.values(r.state.encounters)[0].deadlineMs, 31000);
});
test('simultaneous key pickup produces one owner; readiness locks and timeout keeps deadline', () => {
  let s = place(state(), 'alice', 4, 6);
  place(s, 'bob', 5, 7);
  s = g.beginEncounter(s, 'alice', 100).state;
  const e = Object.values(s.encounters)[0];
  for (const id of ['alice', 'bob'])
    s = g.submitIntent(s, id, {
      encounterId: e.id,
      generation: 1,
      round: 1,
      intentRevision: 1,
      action: { kind: 'pick_up', targetId: 'key' },
      ready: true,
    }).state;
  assert.equal(
    g.submitIntent(s, 'alice', {
      encounterId: e.id,
      generation: 1,
      round: 1,
      intentRevision: 2,
      action: { kind: 'wait' },
      ready: true,
    }).error,
    'ROUND_LOCKED',
  );
  const r = g.resolveRound(s, e.id, 101);
  assert.equal(r.error, undefined);
  assert.equal(
    Object.values(r.state.entities).filter((a) => a.inventory?.includes('key')).length,
    1,
  );
  assert.equal(r.events.filter((e) => e.code === 'TARGET_UNAVAILABLE').length, 1);
  assert.equal(r.state.encounters[e.id].phase, 'completed');
});
test('overlapping allies separated; two intents cannot occupy same cell', () => {
  let s = place(state(), 'alice', 4, 6);
  place(s, 'bob', 4, 6);
  s = g.beginEncounter(s, 'alice', 0).state;
  assert.notDeepEqual(
    { x: s.entities.alice.x, y: s.entities.alice.y },
    { x: s.entities.bob.x, y: s.entities.bob.y },
  );
  const e = Object.values(s.encounters)[0];
  assert.equal(g.resolveRound(s, e.id, 1).error, 'ROUND_LOCKED');
  const r = g.resolveRound(s, e.id, 30000);
  assert.equal(r.error, undefined);
  assert.equal(r.state.encounters[e.id].deadlineMs, 30000);
});
test('mock NPC moves and gives an owned item but cannot steal or use arbitrary code', () => {
  let s = state();
  let p = g.mockNpcDecision(s);
  const moved = g.validateNpcProposal(s, 'keeper', p);
  assert.equal(moved.error, undefined);
  assert.ok(moved.state.entities.keeper.path.length);
  s = place(s, 'alice', 6, 5);
  p = g.mockNpcDecision(s);
  const r = g.validateNpcProposal(s, 'keeper', p);
  assert.equal(r.state.entities.token.ownerId, 'alice');
  assert.equal(
    g.validateNpcProposal(s, 'keeper', {
      ...p,
      action: { kind: 'give', targetId: 'alice', itemId: 'key' },
    }).error,
    'FORBIDDEN',
  );
  assert.equal(
    g.validateNpcProposal(s, 'keeper', { ...p, action: { kind: 'execute', code: 'grant credits' } })
      .error,
    'INVALID_ACTION',
  );
  assert.equal(
    g.validateNpcProposal(s, 'keeper', { ...p, deadlineTick: -1 }).error,
    'INVALID_ACTION',
  );
  s.tick = 200;
  assert.equal(g.validateNpcProposal(s, 'keeper', p).error, 'STALE_STATE');
});
test('external actor cannot manipulate encounter objects, round cannot escape freely', () => {
  let s = place(state(), 'alice', 4, 6);
  place(s, 'bob', 7, 6);
  s = g.beginEncounter(s, 'alice', 0).state;
  const e = Object.values(s.encounters)[0];
  assert.equal(g.applyAction(s, 'bob', { kind: 'inspect', targetId: 'key' }).error, 'OUT_OF_RANGE');
  place(s, 'bob', 6, 6);
  assert.equal(g.applyAction(s, 'bob', { kind: 'pick_up', targetId: 'key' }).error, 'WRONG_MODE');
  s = g.submitIntent(s, 'alice', {
    encounterId: e.id,
    generation: 1,
    round: 1,
    intentRevision: 1,
    action: { kind: 'flee' },
    ready: true,
  }).state;
  const r = g.resolveRound(s, e.id, 30000);
  assert.ok(r.events.some((e) => e.code === 'PATH_BLOCKED'));
});
test('simultaneous movement never shares destination; earlier occupation blocks edge swap', () => {
  let s = place(state(), 'alice', 4, 6);
  place(s, 'bob', 6, 6);
  s = g.beginEncounter(s, 'alice', 0).state;
  const e = Object.values(s.encounters)[0];
  for (const id of ['alice', 'bob'])
    s = g.submitIntent(s, id, {
      encounterId: e.id,
      generation: 1,
      round: 1,
      intentRevision: 1,
      action: { kind: 'move_to', target: { x: 5, y: 6 } },
      ready: true,
    }).state;
  const r = g.resolveRound(s, e.id, 30000);
  assert.equal(
    [r.state.entities.alice, r.state.entities.bob].filter((a) => a.x === 5 && a.y === 6).length,
    1,
  );
  assert.ok(r.events.some((e) => e.code === 'PATH_BLOCKED'));
});
test('NPC cannot see through wall or accept changed referenced entities', () => {
  let s = place(state(), 'alice', 6, 5);
  let p = g.mockNpcDecision(s);
  s.entities.alice.revision++;
  assert.equal(g.validateNpcProposal(s, 'keeper', p).error, 'STALE_STATE');
  s = place(state(), 'alice', 13, 5);
  p = {
    contextRevision: s.revision,
    mapRevision: 0,
    entityRevision: 0,
    deadlineTick: 160,
    targetRevision: 0,
    action: { kind: 'give', targetId: 'alice', itemId: 'token' },
  };
  assert.equal(g.validateNpcProposal(s, 'keeper', p).error, 'TARGET_UNAVAILABLE');
});
test('map validator rejects invalid coordinates, duplicate inventories and key behind own lock', () => {
  const s = state();
  s.entities.key.x = 12;
  s.entities.key.y = 5;
  assert.ok(g.validateMapState(s).some((e) => e.includes('unreachable-key')));
  s.entities.key.x = 99;
  assert.ok(g.validateMapState(s).some((e) => e.includes('position')));
  s.entities.bob.inventory = ['token'];
  assert.ok(g.validateMapState(s).some((e) => e.includes('duplicate')));
});
test('strict movement rejects client speed/time and disconnect invalidates old inputs', () => {
  let s = state();
  assert.equal(
    g.moveInput(s, 'alice', {
      inputSeq: 1,
      movementGeneration: 0,
      target: { x: 3, y: 6 },
      speed: 999,
    }).error,
    'INVALID_ACTION',
  );
  s = g.moveInput(s, 'alice', { inputSeq: 1, movementGeneration: 0, target: { x: 5, y: 6 } }).state;
  s = g.stopMovement(s, 'alice').state;
  assert.equal(g.tick(s, 20).state.entities.alice.x, 2);
  assert.equal(
    g.moveInput(s, 'alice', { inputSeq: 2, movementGeneration: 0, target: { x: 5, y: 6 } }).error,
    'STALE_STATE',
  );
});
test('NPC context excludes hidden inventory and far objects', () => {
  const s = place(state(), 'alice', 13, 5);
  const ctx = g.buildNpcContext(s, 'keeper');
  assert.equal(
    ctx.visible.some((e) => e.id === 'alice'),
    false,
  );
  assert.deepEqual(ctx.ownInventory, ['token']);
  assert.ok(ctx.visible.every((e) => !('inventory' in e) && !('knownIds' in e)));
});
test('door closure invalidates queued navigation at solid tile', () => {
  let s = place(state(), 'alice', 9, 5);
  place(s, 'bob', 9, 4);
  s.entities.door.locked = false;
  s.entities.door.open = true;
  s = g.moveInput(s, 'alice', {
    inputSeq: 1,
    movementGeneration: 0,
    target: { x: 12, y: 5 },
  }).state;
  place(s, 'bob', 11, 5);
  s = g.applyAction(s, 'bob', { kind: 'close', targetId: 'door' }).state;
  assert.equal(s.maps.observatory.revision, 1);
  const r = g.tick(s, 4);
  assert.equal(r.state.entities.alice.x, 9);
  assert.deepEqual(r.state.entities.alice.path, []);
});
test('constrained relocation path never routes outside encounter area', () => {
  const s = state();
  s.maps.roof.blocked = [
    { x: 2, y: 1 },
    { x: 2, y: 2 },
    { x: 2, y: 3 },
  ];
  const from = { x: 1, y: 2 },
    to = { x: 3, y: 2 };
  assert.ok(g.findPath(s, 'roof', from, to));
  assert.equal(
    g.findPath(s, 'roof', from, to, undefined, false, { x: 1, y: 1, width: 3, height: 3 }),
    null,
  );
});
test('stale NPC proposal rejected after encounter has started and completed', () => {
  let s = state();
  const proposal = g.mockNpcDecision(s);
  s = g.beginEncounter(s, 'keeper', 0).state;
  const encounter = s.entities.keeper.encounterId;
  s = g.resolveRound(s, encounter, 30000).state;
  assert.equal(g.validateNpcProposal(s, 'keeper', proposal).error, 'STALE_STATE');
});
test('hidden and nonexistent targets have indistinguishable failures', () => {
  const s = place(state(), 'alice', 13, 5);
  const proposal = {
    contextRevision: s.revision,
    mapRevision: 0,
    entityRevision: 0,
    deadlineTick: 160,
    targetRevision: 0,
    action: { kind: 'give', targetId: 'alice', itemId: 'token' },
  };
  assert.equal(
    g.validateNpcProposal(s, 'keeper', proposal).error,
    g.validateNpcProposal(s, 'keeper', {
      ...proposal,
      action: { ...proposal.action, targetId: 'nonexistent' },
    }).error,
  );
});
test('validator rejects duplicate identifiers and invalid seeds', () => {
  const s = state();
  s.seed = -1;
  s.maps.roof.id = 'observatory';
  s.entities.bob.id = 'alice';
  const errors = g.validateMapState(s);
  assert.ok(errors.includes('seed:bounds'));
  assert.ok(errors.includes('map:duplicate-id'));
  assert.ok(errors.includes('entity:duplicate-id'));
});
test('seeded command traces preserve ownership and collision invariants', () => {
  for (let seed = 1; seed <= 20; seed++) {
    let s = g.createObservatoryState(['alice', 'bob'], seed),
      n = seed;
    for (let i = 0; i < 100; i++) {
      n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
      const id = n % 2 ? 'alice' : 'bob',
        a = s.entities[id];
      let r;
      if (i % 7 === 0) r = g.applyAction(s, id, { kind: 'pick_up', targetId: 'key' });
      else if (i % 11 === 0) r = g.applyAction(s, id, { kind: 'unlock', targetId: 'door' });
      else
        r = g.moveInput(s, id, {
          inputSeq: (a.lastInputSeq ?? 0) + 1,
          movementGeneration: a.movementGeneration,
          target: { x: 1 + (n % 14), y: 1 + ((n >>> 8) % 10) },
        });
      s = g.tick(r.state, 4).state;
      for (const actor of Object.values(s.entities).filter((e) => e.kind === 'player')) {
        assert.ok(g.walkable(s, actor.mapId, actor, actor.id));
        for (const item of actor.inventory) assert.equal(s.entities[item].ownerId, actor.id);
      }
      assert.equal(
        Object.values(s.entities).filter((e) => e.inventory?.includes('key')).length,
        s.entities.key.ownerId ? 1 : 0,
      );
    }
  }
});
test('action schema rejects contradictory fields before reducer', () => {
  assert.equal(g.gameActionSchema.safeParse({ kind: 'wait', targetId: 'key' }).success, false);
  assert.equal(g.gameActionSchema.safeParse({ kind: 'unlock' }).success, false);
  assert.equal(g.gameActionSchema.safeParse({ kind: 'give', targetId: 'alice' }).success, false);
  assert.equal(
    g.gameActionSchema.safeParse({ kind: 'move_to', target: { x: 2, y: 3 }, itemId: 'key' })
      .success,
    false,
  );
});
test('NPC gives existing item once then follows legal patrol path', () => {
  let s = place(state(), 'alice', 6, 5);
  s = g.validateNpcProposal(s, 'keeper', g.mockNpcDecision(s)).state;
  assert.equal(s.entities.token.ownerId, 'alice');
  const next = g.validateNpcProposal(s, 'keeper', g.mockNpcDecision(s));
  assert.equal(next.error, undefined);
  assert.ok(next.state.entities.keeper.path.length);
  s = g.tick(next.state, 4).state;
  assert.equal(s.entities.keeper.x, 7);
  assert.equal(s.entities.token.ownerId, 'alice');
});
test('strict public projection accepts fixtures and own inventory, rejects private fields', () => {
  let s = place(state(), 'alice', 4, 6);
  s = g.applyAction(s, 'alice', { kind: 'pick_up', targetId: 'key' }).state;
  const p = g.projectState(s, 'alice');
  assert.equal(g.gameProjectionSchema.safeParse(p).success, true);
  for (const field of ['inventory', 'knownIds', 'path', 'lastMoveTick']) {
    const bad = structuredClone(p);
    bad.entities.find((e) => e.id === 'bob')[field] = field === 'lastMoveTick' ? 1 : [];
    assert.equal(g.gameProjectionSchema.safeParse(bad).success, false);
  }
  const other = structuredClone(p);
  other.inventory[0].ownerId = 'bob';
  assert.equal(g.gameProjectionSchema.safeParse(other).success, false);
});
test('public encounter schema rejects hidden future intentions and validates envelope revision', () => {
  let s = place(state(), 'alice', 4, 6);
  place(s, 'bob', 5, 7);
  s = g.beginEncounter(s, 'alice', 1000).state;
  const e = Object.values(s.encounters)[0];
  s = g.submitIntent(s, 'bob', {
    encounterId: e.id,
    generation: 1,
    round: 1,
    intentRevision: 1,
    action: { kind: 'pick_up', targetId: 'key' },
    ready: true,
  }).state;
  const p = g.projectState(s, 'alice');
  assert.equal(g.gameProjectionSchema.safeParse(p).success, true);
  const envelope = {
    type: 'snapshot',
    streamId: 'campaign:alice:1',
    projectionRevision: p.revision,
    connectionEpoch: 1,
    projection: p,
  };
  assert.equal(g.gameEnvelopeSchema.safeParse(envelope).success, true);
  for (const paused of [true, false])
    assert.equal(g.gameEnvelopeSchema.safeParse({ ...envelope, paused }).success, true);
  assert.equal(g.gameEnvelopeSchema.safeParse({ ...envelope, paused: 'false' }).success, false);
  assert.equal(g.gameEnvelopeSchema.safeParse({ ...envelope, hiddenState: {} }).success, false);
  assert.equal(g.gameEnvelopeSchema.safeParse({ ...envelope, type: 'delta' }).success, false);
  assert.equal(
    g.gameEnvelopeSchema.safeParse({ ...envelope, type: 'delta', baseProjectionRevision: 0 })
      .success,
    true,
  );
  assert.equal(
    g.gameEnvelopeSchema.safeParse({ ...envelope, projectionRevision: p.revision + 1 }).success,
    false,
  );
  p.encounter.intents.bob.action = { kind: 'pick_up', targetId: 'key' };
  assert.equal(g.gameProjectionSchema.safeParse(p).success, false);
});
test('public schema rejects unknown protocol version, extra wire data, out of bounds and duplicate entities', () => {
  const p = g.projectState(state(), 'alice');
  for (const bad of [
    { ...p, schemaVersion: 2 },
    { ...p, secrets: 'private' },
    { ...p, entities: [...p.entities, p.entities[0]] },
  ])
    assert.equal(g.gameProjectionSchema.safeParse(bad).success, false);
  const bad = structuredClone(p);
  bad.entities[0].x = p.map.width;
  assert.equal(g.gameProjectionSchema.safeParse(bad).success, false);
});
test('authored template compiler creates real editable maps, objects, NPCs and chosen spawn', () => {
  for (const template of ['observatory', 'courtyard']) {
    const draft = g.createAuthoredDraft(template);
    draft.title = 'An authored adventure';
    draft.objects.find((o) => o.id === 'key').label = 'My unique key';
    draft.objects.find((o) => o.id === 'key').x = 4;
    draft.maps[0].spawns[0] = { x: 2, y: 4 };
    const compiled = g.compilePlayableDraft(draft);
    assert.deepEqual(compiled.errors, []);
    const s = g.createStateFromPlayable(compiled.playable, ['alice', 'bob'], 3);
    assert.equal(s.entities.alice.mapId, draft.startMapId);
    assert.equal(s.entities.alice.y, 4);
    assert.equal(s.entities.key.x, 4);
    assert.equal(s.entities.key.label, 'My unique key');
    assert.equal(s.rulesetVersion, 'hybrid-v3');
    assert.equal(g.gameProjectionSchema.safeParse(g.projectState(s, 'alice')).success, true);
    draft.objects[0].x = 9;
    assert.equal(s.entities.key.x, 4);
  }
});
test('authored compiler rejects raw secrets, invalid ownership, broken exits and inaccessible maps', () => {
  const d = g.createAuthoredDraft('courtyard');
  assert.ok(g.compilePlayableDraft({ ...d, secrets: 'hidden' }).errors.length);
  d.objects[0].ownerNpcId = 'not-an-npc';
  assert.ok(g.compilePlayableDraft(d).errors.some((e) => e.includes('owner')));
  delete d.objects[0].ownerNpcId;
  d.maps[0].exits[0].destinationMapId = 'missing';
  assert.ok(g.compilePlayableDraft(d).errors.length);
});
test('authored NPC source IDs do not enter compiled public state', () => {
  const d = g.createAuthoredDraft();
  d.npcs[0].sourceNpcId = '00000000-0000-4000-8000-000000000001';
  const compiled = g.compilePlayableDraft(d);
  assert.deepEqual(compiled.errors, []);
  assert.equal(JSON.stringify(compiled.playable).includes('sourceNpcId'), false);
  assert.equal(JSON.stringify(compiled.playable).includes(d.npcs[0].sourceNpcId), false);
});
test('author schemas reject prototype pollution keys, player prefixes and impossible cross-map key dependencies', () => {
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty'])
    assert.equal(g.gameIdSchema.safeParse(id).success, false);
  const d = g.createAuthoredDraft();
  d.objects[0].id = 'player-reserved';
  assert.ok(g.compilePlayableDraft(d).errors.length);
  const broken = g.createAuthoredDraft();
  delete broken.objects.find((o) => o.id === 'door').keyId;
  assert.ok(g.compilePlayableDraft(broken).errors.length);
  const cross = g.createAuthoredDraft();
  const key = cross.objects.find((o) => o.id === 'key');
  key.mapId = 'roof';
  key.x = 4;
  key.y = 3;
  assert.ok(g.compilePlayableDraft(cross).errors.some((e) => e.includes('unreachable')));
});
function authoredState() {
  // Preserve the earlier v2 mock-plan contract rather than changing legacy saves.
  const legacy = g.createAuthoredDraft();
  delete legacy.npcBehavior;
  const c = g.compilePlayableDraft(legacy);
  assert.deepEqual(c.errors, []);
  return g.createStateFromPlayable(c.playable, ['alice', 'bob'], 1);
}
function readyWait(s, id) {
  const e = s.encounters[s.entities[id].encounterId];
  return g.submitIntent(s, id, {
    encounterId: e.id,
    generation: e.generation,
    round: e.round,
    intentRevision: 1,
    action: { kind: 'wait' },
    ready: true,
  }).state;
}
test('authored encounter runs actual rounds with preserved generation and new deadlines until unanimous end', () => {
  let s = authoredState();
  s = g.beginEncounter(s, 'alice', 1000).state;
  const eid = s.entities.alice.encounterId;
  s = readyWait(readyWait(s, 'alice'), 'bob');
  s = g.resolveRound(s, eid, 2000).state;
  assert.equal(s.encounters[eid].round, 2);
  assert.equal(s.encounters[eid].phase, 'planning');
  assert.equal(s.encounters[eid].deadlineMs, 32000);
  assert.equal(s.entities.alice.encounterId, eid);
  assert.deepEqual(s.encounters[eid].intents, {});
  assert.equal(g.gameProjectionSchema.safeParse(g.projectState(s, 'alice')).success, true);
  s = g.requestEncounterEnd(s, 'alice').state;
  s = g.requestEncounterEnd(s, 'bob').state;
  s = g.resolveRound(s, eid, 3000).state;
  assert.equal(s.encounters[eid].phase, 'completed');
  assert.equal(s.entities.alice.encounterId, undefined);
});
test('queued join enters only at round boundary, stale round rejected, max round ends', () => {
  let s = authoredState();
  place(s, 'bob', 5, 6);
  s.roundPolicy.maxRounds = 2;
  s = g.beginEncounter(s, 'alice', 0).state;
  const eid = s.entities.alice.encounterId;
  assert.equal(s.entities.bob.encounterId, undefined);
  s = g.requestEncounterJoin(s, 'bob', eid).state;
  assert.equal(s.entities.bob.encounterId, undefined);
  s = readyWait(s, 'alice');
  s = g.resolveRound(s, eid, 1).state;
  assert.equal(s.entities.bob.encounterId, eid);
  assert.equal(s.encounters[eid].round, 2);
  assert.equal(
    g.submitIntent(s, 'bob', {
      encounterId: eid,
      generation: 1,
      round: 1,
      intentRevision: 1,
      action: { kind: 'wait' },
      ready: true,
    }).error,
    'STALE_STATE',
  );
  s = g.resolveRound(s, eid, 30001).state;
  assert.equal(s.encounters[eid].phase, 'completed');
});
test('disconnected actor uses wait on same deadline and uninvolved map continues', () => {
  let s = authoredState();
  place(s, 'bob', 2, 3, 'roof');
  s = g.beginEncounter(s, 'alice', 0).state;
  const eid = s.entities.alice.encounterId;
  s = g.stopMovement(s, 'alice').state;
  assert.equal(s.encounters[eid].deadlineMs, 30000);
  s = g.moveInput(s, 'bob', { inputSeq: 1, movementGeneration: 0, target: { x: 4, y: 3 } }).state;
  s = g.tick(s, 8).state;
  assert.equal(s.entities.bob.x, 4);
  s = g.resolveRound(s, eid, 30000).state;
  assert.equal(s.encounters[eid].round, 2);
  assert.equal(s.encounters[eid].deadlineMs, 60000);
});
test('authored mock plan persists cursor, gives existing item, then walks and records only accepted memory once', () => {
  let s = authoredState();
  place(s, 'alice', 6, 5);
  const proposal = g.createMockNpcPlan(s, 'keeper');
  let r = g.acceptNpcPlan(s, 'keeper', proposal);
  assert.equal(r.error, undefined);
  s = r.state;
  assert.equal(g.acceptNpcPlan(s, 'keeper', proposal).error, 'WRONG_MODE');
  const before = s;
  r = g.stepNpcPlan(s, 'keeper');
  assert.equal(r.state.entities.token.ownerId, 'alice');
  s = g.recordNpcEvents(before, r.state, r.events, 'operation-one').state;
  const facts = structuredClone(s.npcBrains.keeper.facts);
  assert.ok(facts.some((f) => f.kind === 'helped'));
  s = g.recordNpcEvents(before, s, r.events, 'operation-one').state;
  assert.deepEqual(s.npcBrains.keeper.facts, facts);
  const restored = JSON.parse(JSON.stringify(s));
  assert.equal(restored.npcBrains.keeper.cursor, 1);
  s = g.stepNpcPlan(restored, 'keeper').state;
  assert.ok(s.entities.keeper.path.length);
  s = g.tick(s, 4).state;
  s = g.stepNpcPlan(s, 'keeper').state;
  assert.equal(s.entities.keeper.x, 7);
  assert.equal(s.npcBrains.keeper.cursor, s.npcBrains.keeper.plan.length);
  assert.equal(g.acceptNpcPlan(s, 'keeper', g.createMockNpcPlan(s, 'keeper')).error, 'WRONG_MODE');
  assert.equal(JSON.stringify(g.projectState(s, 'alice')).includes('npcBrains'), false);
  assert.equal(JSON.stringify(g.projectState(s, 'alice')).includes('operation-one'), false);
});
test('mock sequences reject code, oversized plans, stolen items and late revisions', () => {
  let s = authoredState();
  place(s, 'alice', 6, 5);
  const p = g.createMockNpcPlan(s, 'keeper');
  assert.equal(
    g.acceptNpcPlan(s, 'keeper', { ...p, actions: [{ kind: 'execute', code: 'grant credits' }] })
      .error,
    'INVALID_ACTION',
  );
  assert.equal(
    g.acceptNpcPlan(s, 'keeper', { ...p, actions: Array(4).fill({ kind: 'wait' }) }).error,
    'INVALID_ACTION',
  );
  assert.equal(
    g.acceptNpcPlan(s, 'keeper', {
      ...p,
      actions: [{ kind: 'give', targetId: 'alice', itemId: 'key' }],
    }).error,
    'FORBIDDEN',
  );
  s.entities.alice.revision++;
  assert.equal(g.acceptNpcPlan(s, 'keeper', p).error, 'STALE_STATE');
});
test('NPC memory excludes unseen events and remains bounded', () => {
  let s = authoredState();
  place(s, 'alice', 3, 3, 'roof');
  let r = g.recordNpcEvents(
    s,
    s,
    [{ kind: 'actor.moved', actorId: 'alice', mapId: 'roof' }],
    'hidden',
  );
  assert.deepEqual(r.state.npcBrains.keeper.facts, []);
  place(s, 'alice', 6, 5);
  for (let i = 0; i < 40; i++)
    s = g.recordNpcEvents(
      s,
      s,
      [{ kind: 'actor.moved', actorId: 'alice', mapId: 'observatory' }],
      `seen-${i}`,
    ).state;
  assert.equal(s.npcBrains.keeper.facts.length, 16);
  assert.equal(g.buildNpcContext(s, 'keeper').memory.length, 16);
});
test('pending NPC path safely aborts when a door closes or encounter starts', () => {
  let s = authoredState();
  place(s, 'keeper', 9, 5);
  s.entities.door.locked = false;
  s.entities.door.open = true;
  s.npcBrains.keeper.goal = 'patrol';
  s.npcBrains.keeper.patrolTarget = { x: 12, y: 5 };
  s = g.acceptNpcPlan(s, 'keeper', g.createMockNpcPlan(s, 'keeper')).state;
  s = g.stepNpcPlan(s, 'keeper').state;
  s.entities.door.open = false;
  s.maps.observatory.revision++;
  s = g.tick(s, 4).state;
  const stopped = g.stepNpcPlan(s, 'keeper');
  assert.ok(stopped.events.some((e) => e.kind === 'npc.plan_stopped'));
  assert.equal(stopped.state.npcBrains.keeper.plan.length, 0);
});
test('authored manifest is pinned and schema rejects arbitrary asset paths', () => {
  const c = g.compilePlayableDraft(g.createAuthoredDraft());
  assert.deepEqual(c.playable.assetManifest, g.bundledGameAssetManifest);
  const p = g.projectState(g.createStateFromPlayable(c.playable, ['alice']), 'alice');
  assert.deepEqual(p.assetManifest, g.bundledGameAssetManifest);
  assert.equal(
    g.gameProjectionSchema.safeParse({
      ...p,
      assetManifest: { ...p.assetManifest, url: 'https://external.invalid' },
    }).success,
    false,
  );
});
test('flee cannot cross into adjacent encounter and leaves no stale coordinator vote', () => {
  let s = authoredState();
  place(s, 'alice', 4, 5);
  place(s, 'bob', 7, 5);
  s.maps.observatory.blocked.push({ x: 4, y: 4 }, { x: 4, y: 6 });
  s.encounters.first = {
    id: 'first',
    mapId: 'observatory',
    generation: 1,
    round: 1,
    phase: 'planning',
    participants: ['alice'],
    area: { x: 2, y: 4, width: 3, height: 3 },
    deadlineMs: 1000,
    intents: { alice: { revision: 1, action: { kind: 'flee' }, ready: true } },
    policy: { maxRounds: 5, planningMs: 30000 },
    coordinatorId: 'alice',
    endVotes: ['alice'],
  };
  s.encounters.second = {
    id: 'second',
    mapId: 'observatory',
    generation: 1,
    round: 1,
    phase: 'planning',
    participants: ['bob'],
    area: { x: 5, y: 4, width: 3, height: 3 },
    deadlineMs: 1000,
    intents: {},
    policy: { maxRounds: 5, planningMs: 30000 },
  };
  s.entities.alice.encounterId = 'first';
  s.entities.bob.encounterId = 'second';
  const blocked = g.resolveRound(s, 'first', 1000);
  assert.ok(blocked.events.some((e) => e.code === 'PATH_BLOCKED'));
  assert.equal(blocked.state.entities.alice.x, 4);
  s.encounters.second.phase = 'completed';
  const fled = g.resolveRound(s, 'first', 1000);
  assert.equal(fled.state.entities.alice.x, 5);
  assert.equal(fled.state.encounters.first.coordinatorId, undefined);
  assert.deepEqual(fled.state.encounters.first.endVotes, []);
});
test('transition cannot spawn actor into active conflict', () => {
  let s = authoredState();
  place(s, 'alice', 13, 5);
  place(s, 'bob', 2, 3, 'roof');
  s = g.beginEncounter(s, 'bob', 0).state;
  assert.equal(
    g.applyAction(s, 'alice', { kind: 'transition', targetId: 'roof-exit' }).error,
    'WRONG_MODE',
  );
});
