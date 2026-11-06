const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
function fixture(technician = false) {
  const d = g.createAuthoredDraft('courtyard');
  d.maps = [
    {
      ...d.maps[0],
      exits: [],
      composition: {
        version: 1,
        provenance: 'original-drawn-fixture',
        layers: [{ id: 'worktop', visual: 'table', x: 4, y: 3, width: 1, height: 1, solid: true }],
      },
      blocked: [{ x: 4, y: 3 }],
    },
  ];
  d.objects = [];
  d.npcs = [
    {
      id: 'host',
      label: technician ? 'Technician' : 'Innkeeper',
      mapId: 'courtyard',
      x: 3,
      y: 3,
      visual: 'keeper',
      goal: 'help',
      itemStock: technician
        ? [{ definitionId: 'battery', quantity: 1 }]
        : [
            { definitionId: 'meal', quantity: 1 },
            { definitionId: 'cup', quantity: 1 },
          ],
    },
  ];
  d.npcBehavior = 'reactive-v1';
  d.turnRules = g.turnRulesSchema.parse({});
  d.worldItemDefinitions = [
    {
      id: 'meal',
      label: 'Dinner',
      description: 'A fresh meal',
      visual: 'food',
      portable: false,
      edible: true,
      restoreVitality: 1,
    },
    {
      id: 'cup',
      label: 'Cup',
      description: 'A ceramic cup',
      visual: 'cup',
      portable: true,
      edible: false,
      restoreVitality: 0,
    },
    {
      id: 'battery',
      label: 'Battery',
      description: 'A charged battery',
      visual: 'battery',
      portable: true,
      edible: false,
      restoreVitality: 0,
    },
  ];
  d.worldItemRules = { version: 1, inventoryCapacity: 4, maxWorldItems: 8, surfaceCapacity: 4 };
  const c = g.compilePlayableDraft(d);
  assert.deepEqual(c.errors, []);
  const s = g.createStateFromPlayable(c.playable, ['alice']);
  Object.assign(s.entities.alice, { x: 4, y: 4, vitality: 3 });
  return s;
}
const world = (s) => g.endPlayerTurn(s, 'alice', g.turnFence(s)).state;
const meal = [
  { kind: 'place_stock', definitionId: 'meal', surfaceId: 'worktop', x: 4, y: 3 },
  { kind: 'place_stock', definitionId: 'cup', surfaceId: 'worktop', x: 4, y: 3 },
];
test('generic NPC stock becomes visible surface items; eat/take preserves identity over save/reload', () => {
  let s = fixture();
  assert.equal(g.materializeNpcItems(s, 'host', 'alice', meal, 'dinner').error, 'WRONG_MODE');
  s = world(s);
  let r = g.materializeNpcItems(s, 'host', 'alice', meal, 'dinner');
  assert.equal(r.error, undefined);
  s = r.state;
  assert.equal(s.entities['item-dinner-0'].item.surfaceId, 'worktop');
  assert.equal(s.entities.host.itemStock[0].quantity, 0);
  const view = g.projectState(s, 'alice');
  assert.ok(view.entities.some((e) => e.id === 'item-dinner-0'));
  assert.equal(view.entities.find((e) => e.id === 'host').itemStock, undefined);
  assert.equal(g.gameProjectionSchema.safeParse(view).success, true);
  s = g.finishWorldPhase(s, g.turnFence(s)).state;
  r = g.applyTurnAction(s, 'alice', { kind: 'consume', targetId: 'item-dinner-0' }, g.turnFence(s));
  assert.equal(r.error, undefined);
  s = r.state;
  assert.equal(s.entities.alice.vitality, 4);
  assert.equal(s.entities['item-dinner-0'], undefined);
  r = g.applyTurnAction(s, 'alice', { kind: 'pick_up', targetId: 'item-dinner-1' }, g.turnFence(s));
  assert.equal(r.error, undefined);
  s = JSON.parse(JSON.stringify(r.state));
  assert.equal(s.entities['item-dinner-1'].ownerId, 'alice');
  assert.deepEqual(s.entities.alice.inventory, ['item-dinner-1']);
  assert.equal(g.projectState(s, 'alice').inventory[0].label, 'Cup');
  assert.equal(s.turnController.resources.alice.main, 1);
  assert.equal(s.turnController.resources.alice.additional, 1);
  assert.equal(
    g.applyTurnAction(s, 'alice', { kind: 'consume', targetId: 'item-dinner-0' }, g.turnFence(s))
      .error,
    'INVALID_ACTION',
  );
  assert.equal(s.entities['item-dinner-0'], undefined);
});
test('unrelated technician hands battery to actual nearby addressee; no story-specific behavior', () => {
  let s = world(fixture(true));
  Object.assign(s.entities.alice, { x: 3, y: 4 });
  const intents = [{ kind: 'give_stock', definitionId: 'battery', recipientId: 'alice' }];
  let r = g.materializeNpcItems(s, 'host', 'alice', intents, 'repair');
  assert.equal(r.error, undefined);
  assert.equal(r.state.entities['item-repair-0'].ownerId, 'alice');
  assert.deepEqual(r.state.entities.alice.inventory, ['item-repair-0']);
  assert.ok(g.materializeNpcItems(r.state, 'host', 'alice', intents, 'repair').error);
  assert.equal(r.state.entities.host.itemStock[0].quantity, 0);
  assert.equal(g.materializeNpcItems(s, 'host', 'other', intents, 'repair').error, 'FORBIDDEN');
});
test('invalid item intents are atomic, bounded, private and do not spend turn resources', () => {
  const s = world(fixture()),
    before = structuredClone(s);
  for (const intents of [
    [...meal, { kind: 'place_stock', definitionId: 'cup', x: 4, y: 3 }],
    [{ ...meal[0], surfaceId: 'missing' }],
    [meal[0], { ...meal[1], definitionId: 'invented' }],
    [{ ...meal[0], x: 10, y: 8 }],
    [{ ...meal[0], restoreVitality: 999 }],
  ]) {
    const r = g.materializeNpcItems(s, 'host', 'alice', intents, 'invalid');
    assert.ok(r.error);
    assert.strictEqual(r.state, s);
    assert.deepEqual(s, before);
  }
  s.worldItemRules.surfaceCapacity = 1;
  assert.equal(g.materializeNpcItems(s, 'host', 'alice', meal, 'full').error, 'OUT_OF_RANGE');
  s.worldItemRules.surfaceCapacity = 4;
  s.turnController.worldNpcActions.host = s.turnController.ruleset.maxNpcActions;
  assert.equal(g.materializeNpcItems(s, 'host', 'alice', meal, 'limit').error, 'ROUND_LOCKED');
});
test('NPC speech with item intents rejects all or commits both in the same reducer', () => {
  let s = world(fixture());
  Object.assign(s.entities.alice, { x: 3, y: 4 });
  const context = g.buildNpcPublicSpeechContext(s, 'host', ['alice', 'host'], []);
  const input = {
    text: 'Your meal and cup are on the table.',
    itemIntents: meal,
    channel: 'say',
    recipientId: 'alice',
    observationIds: [],
    contextHash: g.npcContextFingerprint(context),
  };
  let r = g.commitNpcPublicUtterance(s, 'host', {
    ...input,
    itemIntents: [{ ...meal[0], definitionId: 'invented' }],
  });
  assert.ok(r.error);
  assert.strictEqual(r.state, s);
  assert.equal(s.npcUtterances?.length ?? 0, 0);
  r = g.commitNpcPublicUtterance(s, 'host', input);
  assert.equal(r.error, undefined);
  assert.equal(r.state.npcUtterances.at(-1).text, input.text);
  assert.equal(r.events.filter((e) => e.kind === 'item.placed').length, 2);
  const again = g.commitNpcPublicUtterance(r.state, 'host', input);
  assert.ok(again.error || again.events.length === 0);
  assert.equal(Object.values(again.state.entities).filter((e) => e.item).length, 2);
});
test('nonportable, unavailable, foreign and distant items cannot be consumed or taken', () => {
  let s = g.materializeNpcItems(world(fixture()), 'host', 'alice', meal, 'guards').state;
  s = g.finishWorldPhase(s, g.turnFence(s)).state;
  assert.equal(
    g.applyTurnAction(s, 'alice', { kind: 'pick_up', targetId: 'item-guards-0' }, g.turnFence(s))
      .error,
    'FORBIDDEN',
  );
  s.entities['item-guards-0'].ownerId = 'someone';
  assert.equal(
    g.applyTurnAction(s, 'alice', { kind: 'consume', targetId: 'item-guards-0' }, g.turnFence(s))
      .error,
    'OUT_OF_RANGE',
  );
  delete s.entities['item-guards-0'].ownerId;
  s.entities.alice.x = 9;
  assert.equal(
    g.applyTurnAction(s, 'alice', { kind: 'consume', targetId: 'item-guards-0' }, g.turnFence(s))
      .error,
    'OUT_OF_RANGE',
  );
  assert.equal(s.turnController.resources.alice.main, 1);
});

test('confirmed item consequences enter witness memory, while an uninvolved distant NPC learns nothing', () => {
  let before = world(fixture());
  let produced = g.materializeNpcItems(before, 'host', 'alice', meal, 'memory');
  let s = g.recordNpcEvents(before, produced.state, produced.events, 'place-items').state;
  assert.ok(
    s.npcBrains.host.living.observations.some(
      (o) => o.kind === 'item_placed' && o.targetId === 'item-memory-0',
    ),
  );
  s = g.finishWorldPhase(s, g.turnFence(s)).state;
  const previous = s;
  const eaten = g.applyTurnAction(
    s,
    'alice',
    { kind: 'consume', targetId: 'item-memory-0' },
    g.turnFence(s),
  );
  s = g.recordNpcEvents(previous, eaten.state, eaten.events, 'eat-once').state;
  const seen = s.npcBrains.host.living.observations.find((o) => o.kind === 'item_consumed');
  assert.equal(seen.targetId, 'item-memory-0');
  assert.equal(seen.actorId, 'alice');
  assert.ok(
    s.npcBrains.host.living.causes.some((c) => c.observationId === seen.id && c.priority >= 2),
  );
  const repeated = g.recordNpcEvents(previous, s, eaten.events, 'eat-once').state;
  assert.equal(
    repeated.npcBrains.host.living.observations.filter((o) => o.kind === 'item_consumed').length,
    1,
  );
});
test('provisioning respects NPC hard taboos without mutating stock or claiming success', () => {
  const s = world(fixture(true));
  s.entities.alice = { ...s.entities.alice, x: 3, y: 4 };
  s.npcBrains.host.living.personality.taboos.push('give_valuables');
  const r = g.materializeNpcItems(
    s,
    'host',
    'alice',
    [{ kind: 'give_stock', definitionId: 'battery', recipientId: 'alice' }],
    'forbidden',
  );
  assert.equal(r.error, 'FORBIDDEN');
  assert.strictEqual(r.state, s);
  assert.equal(s.entities.host.itemStock[0].quantity, 1);
  assert.deepEqual(g.npcItemContext(s, 'host').itemProvisioning.stock, []);
});

test('text consume and map consume share one main-action reducer in ru/en/uk', () => {
  let s = g.materializeNpcItems(world(fixture()), 'host', 'alice', meal, 'text-eat').state;
  s = g.finishWorldPhase(s, g.turnFence(s)).state;
  const click = g.applyTurnAction(
    s,
    'alice',
    { kind: 'consume', targetId: 'item-text-eat-0' },
    g.turnFence(s),
  );
  assert.equal(click.error, undefined);
  for (const text of ['eat Dinner', 'съесть Dinner', 'поїсти Dinner']) {
    const proposal = g.proposePlayerTextIntent(s, 'alice', text);
    assert.ok(proposal, text);
    assert.deepEqual(g.confirmPlayerTextIntent(s, 'alice', proposal, true), click);
  }
  assert.equal(click.state.turnController.resources.alice.main, 1);
  assert.equal(click.state.entities.alice.vitality, 4);
});
test('text consume can use an owned inventory item but cannot duplicate or bypass a stale target', () => {
  const initial = fixture();
  initial.worldItemDefinitions.find((d) => d.id === 'meal').portable = true;
  let s = g.materializeNpcItems(world(initial), 'host', 'alice', meal, 'inventory-eat').state;
  s = g.finishWorldPhase(s, g.turnFence(s)).state;
  s = g.applyTurnAction(
    s,
    'alice',
    { kind: 'pick_up', targetId: 'item-inventory-eat-0' },
    g.turnFence(s),
  ).state;
  const proposal = g.proposePlayerTextIntent(s, 'alice', 'eat Dinner');
  assert.ok(proposal);
  const stale = structuredClone(s);
  stale.entities['item-inventory-eat-0'].revision++;
  assert.equal(g.confirmPlayerTextIntent(stale, 'alice', proposal, true).error, 'STALE_STATE');
  assert.equal(stale.turnController.resources.alice.main, 1);
  assert.equal(
    g.proposePlayerActionIntent(s, 'alice', 'eat cup', {
      kind: 'consume',
      targetId: 'item-inventory-eat-1',
    }),
    null,
  );
  const eaten = g.confirmPlayerTextIntent(s, 'alice', proposal, true);
  assert.equal(eaten.error, undefined);
  assert.deepEqual(eaten.state.entities.alice.inventory, []);
  assert.equal(eaten.state.entities['item-inventory-eat-0'], undefined);
  const duplicate = g.confirmPlayerTextIntent(eaten.state, 'alice', proposal, true);
  assert.equal(duplicate.error, 'STALE_STATE');
  assert.strictEqual(duplicate.state, eaten.state);
  assert.equal(eaten.state.entities.alice.vitality, 4);
});
