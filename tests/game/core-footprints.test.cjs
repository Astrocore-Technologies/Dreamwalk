const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
function fixture(size = 'large') {
  const s = g.createObservatoryState(['hero']);
  s.maps.observatory = {
    id: 'observatory',
    width: 24,
    height: 24,
    blocked: [],
    spawns: [{ x: 1, y: 1 }],
    exits: [],
    revision: 0,
  };
  s.entities = {
    hero: {
      id: 'hero',
      kind: 'player',
      mapId: 'observatory',
      x: 1,
      y: 1,
      revision: 0,
      movementGeneration: 0,
      lastInputSeq: 0,
    },
    giant: {
      id: 'giant',
      kind: 'npc',
      mapId: 'observatory',
      x: 5,
      y: 5,
      revision: 0,
      tokenSize: size,
      movementGeneration: 0,
      lastInputSeq: 0,
    },
  };
  s.npcBrains = {};
  return s;
}
test('large and huge creatures cannot traverse a one-cell gap; medium still can', () => {
  for (const size of ['large', 'huge']) {
    const s = fixture(size);
    s.maps.observatory.blocked = Array.from({ length: 24 }, (_, y) => ({ x: 10, y })).filter(
      (p) => p.y !== 6,
    );
    assert.equal(g.findPath(s, 'observatory', s.entities.giant, { x: 14, y: 5 }, 'giant'), null);
    s.entities.giant.tokenSize = 'medium';
    assert.ok(g.findPath(s, 'observatory', s.entities.giant, { x: 14, y: 5 }, 'giant'));
  }
});
test('full footprint bounds, walls and actor occupancy are enforced', () => {
  const s = fixture();
  assert.equal(g.walkable(s, 'observatory', { x: 23, y: 3 }, 'giant'), false);
  assert.equal(g.walkable(s, 'observatory', { x: 6, y: 6 }, 'hero'), false);
  s.maps.observatory.blocked.push({ x: 8, y: 8 });
  assert.equal(g.walkable(s, 'observatory', { x: 7, y: 7 }, 'giant'), false);
  assert.equal(
    g
      .validateMapState({
        ...s,
        entities: { ...s.entities, giant: { ...s.entities.giant, x: 7, y: 7 } },
      })
      .includes('entity:giant:footprint'),
    true,
  );
});
test('player spawn never overlaps a large creature', () => {
  const s = fixture();
  s.maps.observatory.spawns = [{ x: 6, y: 6 }];
  assert.equal(g.addPlayer(s, 'second').error, 'PATH_BLOCKED');
  s.maps.observatory.spawns.push({ x: 9, y: 9 });
  const added = g.addPlayer(s, 'second');
  assert.equal(added.error, undefined);
  assert.equal(added.state.entities.second.x, 9);
});
test('cannot close an open door intersecting any occupied creature cell', () => {
  const s = fixture();
  Object.assign(s.entities.hero, { x: 7, y: 6 });
  s.entities.door = {
    id: 'door',
    kind: 'door',
    mapId: 'observatory',
    x: 6,
    y: 6,
    open: true,
    revision: 0,
  };
  assert.equal(
    g.applyUnbudgetedAction(s, 'hero', { kind: 'close', targetId: 'door' }).error,
    'PATH_BLOCKED',
  );
});
test('transition checks complete destination footprint and preserves source on rejection', () => {
  const s = fixture();
  s.entities.giant.kind = 'player';
  s.maps.observatory.exits = [
    { id: 'out', x: 7, y: 6, destinationMapId: 'roof', destination: { x: 4, y: 4 } },
  ];
  s.maps.roof = {
    id: 'roof',
    width: 5,
    height: 5,
    blocked: [],
    spawns: [{ x: 1, y: 1 }],
    exits: [],
    revision: 0,
  };
  assert.equal(
    g.applyUnbudgetedAction(s, 'giant', { kind: 'transition', targetId: 'out' }).error,
    'PATH_BLOCKED',
  );
  s.maps.observatory.exits[0].destination = { x: 2, y: 2 };
  assert.equal(
    g.applyUnbudgetedAction(s, 'giant', { kind: 'transition', targetId: 'out' }).error,
    undefined,
  );
});
test('melee uses nearest occupied edge without altering damage or action budget', () => {
  let s = fixture();
  Object.assign(s.entities.hero, { x: 7, y: 6 });
  s = g.initializeTurnController(s, ['hero']).state;
  const fence = g.turnFence(s, 'hero');
  const result = g.applyTurnAction(s, 'hero', { kind: 'hit', targetId: 'giant' }, fence);
  assert.equal(result.error, undefined);
  assert.equal(
    result.state.entities.giant.vitality,
    result.state.turnController.ruleset.vitality - result.state.turnController.ruleset.hitDamage,
  );
  assert.equal(g.footprintDistance(s.entities.hero, s.entities.giant), 1);
});
test('legacy coordination area includes complete large participants at its edge', () => {
  const s = fixture('huge');
  Object.assign(s.entities.hero, { x: 4, y: 5 });
  Object.assign(s.entities.giant, { x: 6, y: 5 });
  const result = g.beginEncounter(s, 'hero', 0);
  assert.equal(result.error, undefined);
  const encounter = Object.values(result.state.encounters)[0];
  assert.ok(encounter.participants.includes('giant'));
  assert.ok(g.footprintInside(result.state.entities.giant, encounter.area));
  assert.ok(encounter.area.x + encounter.area.width <= 24);
});
test('visible exposed far edge remains targetable when the anchor ray is blocked', () => {
  const s = fixture('huge');
  Object.assign(s.entities.hero, { x: 9, y: 7 });
  // Anchor ray to (5,5) crosses this wall; far edge (7,7) remains exposed.
  s.maps.observatory.blocked.push({ x: 8, y: 6 });
  assert.equal(g.visible(s, s.entities.hero, s.entities.giant), true);
});
test('renderer and approach anchors use the full creature rectangle', () => {
  const s = fixture('huge');
  const anchors = g.adjacentFootprintAnchors(s.entities.hero, s.entities.giant);
  assert.ok(anchors.some((p) => p.x === 8 && p.y === 7));
  for (const point of anchors)
    assert.equal(g.footprintDistance({ ...s.entities.hero, ...point }, s.entities.giant), 1);
});

test('large creature can consume an accessible item at its occupied edge', () => {
  const s = fixture('huge');
  s.entities.food = {
    id: 'food',
    kind: 'item',
    mapId: 'observatory',
    x: 8,
    y: 7,
    revision: 0,
    item: {
      definitionId: 'food',
      quantity: 1,
      portable: true,
      edible: true,
      restoreVitality: 1,
      visual: 'food',
    },
  };
  assert.equal(g.consumeWorldItem(s, 'giant', 'food').error, undefined);
});

test('pushing a differently sized creature follows the contacted edge, not a diagonal center vector', () => {
  let s = fixture('large');
  Object.assign(s.entities.hero, { x: 7, y: 6 });
  s = g.initializeTurnController(s, ['hero']).state;
  const result = g.applyTurnAction(
    s,
    'hero',
    { kind: 'push', targetId: 'giant' },
    g.turnFence(s, 'hero'),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.giant.y, 5);
  assert.equal(result.state.entities.giant.x, 5 - result.state.turnController.ruleset.pushDistance);
});

test('large creature can flee at a boundary but cannot jump an intervening wall', () => {
  const s = fixture('large');
  s.entities.giant.kind = 'player';
  Object.assign(s.entities.giant, { x: 5, y: 5, encounterId: 'fight' });
  s.encounters.fight = {
    id: 'fight',
    mapId: 'observatory',
    generation: 1,
    round: 1,
    phase: 'planning',
    participants: ['giant'],
    area: { x: 5, y: 5, width: 5, height: 5 },
    deadlineMs: 1000,
    intents: {},
  };
  s.encounters.fight.intents.giant = { revision: 1, action: { kind: 'flee' }, ready: true };
  const escaped = g.resolveRound(s, 'fight', 1000);
  assert.equal(escaped.error, undefined);
  assert.equal(escaped.state.entities.giant.encounterId, undefined);
  assert.equal(
    g.footprintIntersectsArea(escaped.state.entities.giant, s.encounters.fight.area),
    false,
  );
  s.maps.observatory.blocked.push({ x: 5, y: 4 }, { x: 4, y: 5 });
  s.encounters.fight.intents.giant = { revision: 1, action: { kind: 'flee' }, ready: true };
  assert.ok(g.resolveRound(s, 'fight', 1000).events.some((event) => event.code === 'PATH_BLOCKED'));
});
test('huge actor in encounter interior cannot use footprint clearance as free movement', () => {
  const s = fixture('huge');
  s.entities.giant.kind = 'player';
  Object.assign(s.entities.giant, { x: 6, y: 6, encounterId: 'fight' });
  s.encounters.fight = {
    id: 'fight',
    mapId: 'observatory',
    generation: 1,
    round: 1,
    phase: 'planning',
    participants: ['giant'],
    area: { x: 5, y: 5, width: 5, height: 5 },
    deadlineMs: 1000,
    intents: {},
  };
  s.encounters.fight.intents.giant = { revision: 1, action: { kind: 'flee' }, ready: true };
  assert.ok(g.resolveRound(s, 'fight', 1000).events.some((event) => event.code === 'PATH_BLOCKED'));
  assert.deepEqual({ x: s.entities.giant.x, y: s.entities.giant.y }, { x: 6, y: 6 });
});

test('large NPC key carrier remains reachable at its edge during author compilation', () => {
  const draft = g.createAuthoredDraft();
  delete draft.npcBehavior;
  draft.npcs[0].tokenSize = 'large';
  draft.objects.find((item) => item.id === 'key').ownerNpcId = 'keeper';
  assert.deepEqual(g.compilePlayableDraft(draft).errors, []);
});
test('large NPC targeted dialogue and recipient-near promises use exposed edge proximity', () => {
  const d = g.createCompleteObservatoryDraft();
  delete d.supportingNpcPolicy;
  const s = g.createStateFromPlayable(g.compilePlayableDraft(d).playable, ['alice']);
  s.entities.keeper.tokenSize = 'large';
  Object.assign(s.entities.alice, { x: 8, y: 5 });
  const input = {
    operationId: require('node:crypto').randomUUID(),
    text: 'Hello',
    channel: 'say',
    targetNpcId: 'keeper',
    expectedCanonRevision: 0,
  };
  assert.doesNotThrow(() =>
    g.createMockStoryTurnProposal(s, 'alice', input, require('node:crypto').randomUUID()),
  );
  assert.equal(g.npcConditionsMet(s, 'keeper', [{ kind: 'recipient_near' }], 'alice'), true);
});
test('new large narrative NPC cannot cover a reserved spawn in a non-anchor cell', () => {
  const d = g.createCompleteObservatoryDraft();
  delete d.supportingNpcPolicy;
  const s = g.createStateFromPlayable(g.compilePlayableDraft(d).playable, ['alice']);
  const text = 'Explore beyond the room';
  const proposal = g.createMockNarrativeProposal(
    s,
    'alice',
    text,
    require('node:crypto').randomUUID(),
  );
  proposal.newNpc.tokenSize = 'large';
  proposal.newNpc.spawn = { x: 1, y: 2 }; // includes new-scene reserved (2,3)
  const result = g.applyNarrativeProposal(s, 'alice', proposal, text);
  assert.equal(result.error, 'PATH_BLOCKED');
  assert.equal(result.state, s);
});
test('large player may join across adjacent boundary but cannot jump a blocked swept cell', () => {
  const s = fixture('large');
  s.entities.giant.kind = 'player';
  Object.assign(s.entities.giant, { x: 3, y: 6 });
  s.encounters.fight = {
    id: 'fight',
    mapId: 'observatory',
    generation: 1,
    round: 1,
    phase: 'planning',
    participants: ['hero'],
    area: { x: 5, y: 5, width: 5, height: 5 },
    deadlineMs: 1000,
    intents: {},
    policy: { maxRounds: 5, planningMs: 30000 },
  };
  assert.equal(g.requestEncounterJoin(s, 'giant', 'fight').error, undefined);
  s.maps.observatory.blocked.push({ x: 5, y: 6 });
  assert.equal(g.requestEncounterJoin(s, 'giant', 'fight').error, 'OUT_OF_RANGE');
});
