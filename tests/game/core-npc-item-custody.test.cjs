const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
function fixture() {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  const s = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  delete s.turnController;
  Object.assign(s.entities.alice, { x: 5, y: 4, inventory: ['key'] });
  Object.assign(s.entities.bob, { x: 18, y: 16 });
  Object.assign(s.entities.keeper, { x: 6, y: 4, label: 'Борис', inventory: [] });
  Object.assign(s.entities.key, {
    ownerId: 'alice',
    label: 'Латунный ключ',
    item: {
      definitionId: 'brass-key',
      quantity: 1,
      portable: true,
      edible: false,
      restoreVitality: 0,
      visual: 'object',
    },
  });
  s.maps[s.entities.alice.mapId].blocked = [];
  return s;
}
function transfer(s, from = 'alice', to = 'keeper', operation = 'return-key') {
  const result = g.applyAction(s, from, { kind: 'give', itemId: 'key', targetId: to });
  assert.equal(result.error, undefined);
  return { result, state: g.recordNpcEvents(s, result.state, result.events, operation).state };
}
function world(s) {
  s = g.initializeTurnController(s, ['alice', 'bob']).state;
  s = g.endPlayerTurn(s, 'alice', g.turnFence(s)).state;
  return g.endPlayerTurn(s, 'bob', g.turnFence(s)).state;
}
const observations = (s, npc = 'keeper') => s.npcBrains[npc].living.observations;
const voice = (s, ids = [], audience = ['alice', 'keeper']) =>
  g.buildNpcPublicSpeechContext(s, 'keeper', audience, ids);

test('committed player give preserves typed item identity, current custody and one helped effect', () => {
  const before = fixture();
  const { state: s, result } = transfer(before);
  const item = observations(s).find((o) => o.itemTransfer?.itemId === 'key');
  assert.equal(item.kind, 'item_given');
  assert.equal(item.confidence, 'witnessed');
  assert.equal(item.actorId, 'alice');
  assert.equal(item.itemTransfer.recipientId, 'keeper');
  assert.equal(item.itemTransfer.label, 'Латунный ключ');
  assert.equal(item.itemTransfer.revision, s.entities.key.revision);
  assert.deepEqual(item.audienceIds, ['alice', 'keeper']);
  assert.equal(
    observations(s).filter((o) => o.eventId === item.eventId && o.kind === 'helped').length,
    1,
  );
  const repeated = g.recordNpcEvents(before, s, result.events, 'return-key').state;
  assert.deepEqual(observations(repeated), observations(s));
  assert.deepEqual(g.buildNpcDecisionContext(s, 'keeper').ownInventory, [
    { id: 'key', label: 'Латунный ключ', revision: s.entities.key.revision },
  ]);
  assert.equal(voice(s, [item.id]).claims[0].itemTransfer.itemId, 'key');
  const renamed = structuredClone(s);
  renamed.entities.key.label = 'Later label';
  assert.equal(voice(renamed, [item.id]).claims[0].itemTransfer.label, 'Латунный ключ');
});

test('NPC voluntary give_existing commits the same returned item with speech once; refusal remains valid', () => {
  const s = world(transfer(fixture()).state);
  const context = voice(s);
  assert.equal(context.itemProvisioning.ownedItems[0].id, 'key');
  assert.equal(context.itemProvisioning.ownedItems[0].revision, s.entities.key.revision);
  const input = {
    text: 'Держи ключ.',
    channel: 'whisper',
    recipientId: 'alice',
    observationIds: [],
    contextHash: g.npcContextFingerprint(context),
    itemIntents: [{ kind: 'give_existing', itemId: 'key', recipientId: 'alice' }],
  };
  const refused = g.commitNpcPublicUtterance(s, 'keeper', {
    ...input,
    text: 'Пока оставлю его у себя.',
    itemIntents: [],
  });
  assert.equal(refused.error, undefined);
  assert.equal(refused.state.entities.key.ownerId, 'keeper');
  const invalid = g.commitNpcPublicUtterance(s, 'keeper', {
    ...input,
    itemIntents: [{ ...input.itemIntents[0], itemId: 'foreign' }],
  });
  assert.ok(invalid.error);
  assert.strictEqual(invalid.state, s);
  assert.deepEqual(invalid.events, []);
  const accepted = g.commitNpcPublicUtterance(s, 'keeper', input);
  assert.equal(accepted.error, undefined);
  assert.deepEqual(accepted.state.entities.alice.inventory, ['key']);
  assert.deepEqual(accepted.state.entities.keeper.inventory, []);
  assert.equal(accepted.state.entities.key.ownerId, 'alice');
  assert.equal(accepted.events.filter((e) => e.kind === 'item.given').length, 1);
  assert.equal(Object.keys(accepted.state.entities).length, Object.keys(s.entities).length);
  const again = g.commitNpcPublicUtterance(
    JSON.parse(JSON.stringify(accepted.state)),
    'keeper',
    input,
  );
  assert.ok(again.error || !again.events.length);
  assert.deepEqual(again.state.entities.alice.inventory, ['key']);
});

test('custody validates both ownership and membership; private legacy holdings do not expand speech capability', () => {
  const s = transfer(fixture()).state;
  s.entities.legacy = { ...s.entities.key, id: 'legacy', label: 'Private legacy token' };
  delete s.entities.legacy.item;
  s.entities.foreign = {
    ...s.entities.key,
    id: 'foreign',
    label: 'OTHER_INVENTORY',
    ownerId: 'bob',
  };
  s.entities.notItem = { ...s.entities.keeper, id: 'notItem', ownerId: 'keeper' };
  s.entities.keeper.inventory.push('key', 'legacy', 'foreign', 'missing', 'notItem');
  const privateInventory = g.buildNpcDecisionContext(s, 'keeper').ownInventory;
  assert.deepEqual(
    privateInventory.map((i) => i.id),
    ['key', 'legacy'],
  );
  assert.equal(privateInventory[1].label, 'Private legacy token');
  assert.deepEqual(
    voice(s).itemProvisioning.ownedItems.map((i) => i.id),
    ['key'],
  );
  s.npcBrains.keeper.living.personality.taboos.push('give_valuables');
  assert.deepEqual(g.buildNpcDecisionContext(s, 'keeper').ownInventory, privateInventory);
  assert.deepEqual(voice(s).itemProvisioning.ownedItems, []);
  assert.equal(
    g.materializeNpcItems(
      world(s),
      'keeper',
      'alice',
      [{ kind: 'give_existing', itemId: 'key', recipientId: 'alice' }],
      'taboo',
    ).error,
    'FORBIDDEN',
  );
});

test('new transfer provenance is not disclosed to a later wider audience, nor backfilled into legacy helped', () => {
  const s = transfer(fixture()).state;
  const item = observations(s).find((o) => o.itemTransfer);
  Object.assign(s.entities.bob, { x: 6, y: 5 });
  const wider = voice(s, [item.id], ['alice', 'keeper', 'bob']);
  assert.deepEqual(wider.claims, []);
  assert.equal(wider.itemProvisioning.ownedItems[0].id, 'key');
  const legacy = structuredClone(s);
  legacy.npcBrains.keeper.living.observations = observations(legacy).filter((o) => !o.itemTransfer);
  assert.ok(observations(legacy).some((o) => o.kind === 'helped'));
  assert.ok(
    !voice(
      legacy,
      observations(legacy).map((o) => o.id),
    ).claims.some((c) => c.itemTransfer),
  );
});

test('only actual attentive witnesses receive transfer snapshots; forged no-op events do not', () => {
  const s = fixture();
  for (const [id, x, y] of [
    ['witness', 6, 6],
    ['hidden', 18, 16],
    ['distracted', 6, 7],
  ]) {
    s.entities[id] = { ...structuredClone(s.entities.keeper), id, x, y };
    s.npcBrains[id] = structuredClone(s.npcBrains.keeper);
  }
  s.npcBrains.distracted.living.distractedUntilTick = s.tick + 100;
  const { state: after } = transfer(s);
  assert.ok(observations(after, 'witness').some((o) => o.itemTransfer));
  for (const id of ['hidden', 'distracted'])
    assert.ok(!observations(after, id).some((o) => o.itemTransfer));
  const fake = g.recordNpcEvents(
    s,
    s,
    [{ kind: 'action.give', actorId: 'alice', targetId: 'keeper', itemId: 'key' }],
    'not-committed',
  ).state;
  assert.ok(!observations(fake).some((o) => o.itemTransfer));
});

test('location-only contact witnesses a carried-item handoff without inventing item coordinates', () => {
  const s = fixture(),
    map = s.maps[s.entities.alice.mapId];
  Object.assign(map, {
    spatialMode: 'location_only',
    blocked: [],
    spawns: [],
    exits: [],
    scenePresence: {
      version: 1,
      entrySceneId: 'meeting',
      scenes: [
        {
          id: 'meeting',
          participantIds: [],
          evidence: { kind: 'authored_scene', reference: 'opening' },
        },
      ],
    },
  });
  delete map.composition;
  delete map.spatialGrounding;
  for (const e of Object.values(s.entities).filter((e) => e.mapId === map.id)) {
    delete e.x;
    delete e.y;
    delete e.path;
    delete e.movementTrace;
    e.spatialMode = 'location_only';
    e.sceneId = 'meeting';
    if (!e.ownerId) map.scenePresence.scenes[0].participantIds.push(e.id);
  }
  const { state: after } = transfer(s);
  assert.ok(observations(after).some((o) => o.itemTransfer?.itemId === 'key'));
  assert.equal(after.entities.key.x, undefined);
  assert.ok(!map.scenePresence.scenes[0].participantIds.includes('key'));
});

test('item revisions invalidate stale custody context even after an out-and-back cycle', () => {
  const s = transfer(fixture()).state;
  const old = g.npcContextFingerprint(voice(s));
  const away = transfer(s, 'keeper', 'alice', 'out').state;
  const back = transfer(away, 'alice', 'keeper', 'back').state;
  assert.notEqual(g.npcContextFingerprint(voice(back)), old);
  assert.equal(voice(back).itemProvisioning.ownedItems[0].revision, s.entities.key.revision + 2);
});

test('transfer recipient erasure closes causal roots including retellings', async () => {
  const { purgeLivingNpcReferences } = await import('../../scripts/game-data-requests.mjs');
  const s = transfer(transfer(fixture()).state, 'keeper', 'alice', 'to-player').state;
  const transferObservation = observations(s).find((o) => o.itemTransfer?.recipientId === 'alice');
  assert.ok(transferObservation);
  // Remove other identity fields to exercise the new nested recipient reference.
  delete transferObservation.actorId;
  delete transferObservation.targetId;
  const clean = purgeLivingNpcReferences(s, 'alice');
  assert.ok(!observations(clean).some((o) => o.rootId === transferObservation.rootId));
});

test('contact without recognition cannot disclose a richer transfer identity to its other participant', () => {
  const s = world(transfer(fixture()).state);
  Object.assign(s.entities.alice, { x: 5, y: 4 });
  const map = s.maps[s.entities.keeper.mapId];
  const rows = Array.from({ length: map.height }, () => Array(map.width).fill('.'));
  map.spatialGrounding = {
    imageRevisionId: 'synthetic',
    imageSha256: 'synthetic',
    rows: rows.map((r) => r.join('')),
  };
  s.artBindings = [
    { slot: `map:${map.id}:background`, revisionId: 'new-image', sha256: 'new-image' },
  ];
  assert.equal(g.visible(s, s.entities.keeper, s.entities.alice), false);
  // Stale image interpretation blocks recognition, not existing adjacent handoff admission.
  const moved = g.materializeNpcItems(
    s,
    'keeper',
    'alice',
    [{ kind: 'give_existing', itemId: 'key', recipientId: 'alice' }],
    'corner',
  );
  assert.equal(moved.error, undefined);
  const after = g.recordNpcEvents(s, moved.state, moved.events, 'corner').state;
  const seen = observations(after).find((o) => o.eventId?.startsWith('corner:') && o.itemTransfer);
  assert.equal(seen.actorId, 'keeper');
  assert.equal(seen.itemTransfer.recipientId, undefined);
  assert.deepEqual(seen.audienceIds, ['keeper']);
  // Later visibility does not authorize retrospective disclosure of that identity.
  delete after.maps[map.id].spatialGrounding;
  assert.deepEqual(voice(after, [seen.id]).claims, []);
});
