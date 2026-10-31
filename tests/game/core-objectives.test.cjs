const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
const definition = (conditions, mode = 'all') => ({
  id: 'journal',
  title: 'Retrieve the journal',
  description: 'Find the roof notes.',
  epilogue: 'The observations are safe.',
  translations: {
    ru: {
      title: 'Найдите журнал',
      description: 'Журнал на крыше.',
      epilogue: 'Наблюдения сохранены.',
    },
  },
  completion: { mode, conditions },
});
function world(objectives) {
  const draft = g.createAuthoredDraft('observatory');
  draft.objectives = objectives;
  const compiled = g.compilePlayableDraft(draft);
  assert.deepEqual(compiled.errors, []);
  return g.createStateFromPlayable(compiled.playable, ['alice', 'bob']);
}
test('achievement is monotonic, exactly once and clock-bound; empty or revoked party cannot win', () => {
  const state = world([definition([{ kind: 'party_owns_item', itemId: 'key' }])]);
  state.tick = 80;
  state.entities.key.ownerId = 'alice';
  state.entities.alice.inventory = ['key'];
  assert.equal(g.advanceObjectives(state, []).events.length, 0);
  assert.equal(g.advanceObjectives(state, ['bob']).events.length, 0);
  const won = g.advanceObjectives(state, ['alice', 'bob']);
  assert.equal(won.events.length, 1);
  assert.equal(won.state.objectiveProgress.journal.achievedTick, 80);
  assert.equal(state.objectiveProgress?.journal, undefined);
  const restored = JSON.parse(JSON.stringify(won.state));
  restored.entities.key.ownerId = 'keeper';
  restored.entities.alice.inventory = [];
  const replay = g.advanceObjectives(restored, ['alice', 'bob']);
  assert.equal(replay.events.length, 0);
  assert.equal(replay.state.objectiveProgress.journal.achievedTick, 80);
});
test('public projection omits every condition and every unfinished localized epilogue', () => {
  let state = world([definition([{ kind: 'party_owns_item', itemId: 'key' }])]);
  const active = g.projectState(state, 'alice').objectives[0];
  assert.equal(active.status, 'active');
  assert.equal(active.epilogue, undefined);
  assert.equal(active.translations.ru.epilogue, undefined);
  assert.equal(active.completion, undefined);
  assert.equal(JSON.stringify(active).includes('itemId'), false);
  assert.equal(g.gameProjectionSchema.safeParse(g.projectState(state, 'alice')).success, true);
  state.entities.key.ownerId = 'alice';
  state.entities.alice.inventory = ['key'];
  state = g.advanceObjectives(state, ['alice']).state;
  const done = g.projectState(state, 'bob').objectives[0];
  assert.equal(done.epilogue, 'The observations are safe.');
  assert.equal(done.translations.ru.epilogue, 'Наблюдения сохранены.');
});
test('all/any combinations use actual authorized actors and actual door state', () => {
  const conditions = [
    { kind: 'door_open', doorId: 'door' },
    { kind: 'party_reaches_map', mapId: 'roof' },
  ];
  let state = world([definition(conditions)]);
  state.entities.door.open = true;
  assert.equal(g.advanceObjectives(state, ['alice']).events.length, 0);
  state.entities.alice.mapId = 'roof';
  assert.equal(g.advanceObjectives(state, ['alice']).events.length, 1);
  state = world([definition(conditions, 'any')]);
  state.entities.door.open = true;
  assert.equal(g.advanceObjectives(state, ['alice']).events.length, 1);
});
test('compiler rejects dangling/type-mismatched/duplicate/empty objective definitions', () => {
  for (const objectives of [
    [definition([{ kind: 'party_owns_item', itemId: 'missing' }])],
    [definition([{ kind: 'party_owns_item', itemId: 'door' }])],
    [definition([{ kind: 'door_open', doorId: 'key' }])],
    [definition([{ kind: 'party_reaches_map', mapId: 'secret-map' }])],
    [definition([])],
    [
      definition([{ kind: 'door_open', doorId: 'door' }]),
      definition([{ kind: 'door_open', doorId: 'door' }]),
    ],
  ]) {
    const draft = g.createAuthoredDraft();
    draft.objectives = objectives;
    assert.ok(g.compilePlayableDraft(draft).errors.length);
  }
});
test('old packages have no synthetic objective and definitions are snapshot copies', () => {
  const draft = g.createAuthoredDraft();
  const compiled = g.compilePlayableDraft(draft);
  const legacy = g.createStateFromPlayable(compiled.playable, ['alice']);
  assert.equal(g.projectState(legacy, 'alice').objectives, undefined);
  draft.objectives = [definition([{ kind: 'door_open', doorId: 'door' }])];
  const authored = g.compilePlayableDraft(draft).playable;
  const state = g.createStateFromPlayable(authored, ['alice']);
  authored.objectives[0].title = 'changed';
  assert.equal(state.objectives[0].title, 'Retrieve the journal');
});
function stepWorld(state, count = 1) {
  for (let i = 0; i < count; i++) {
    let result = g.tick(state);
    state = g.recordNpcEvents(
      state,
      result.state,
      result.events,
      `tick-${result.state.tick}`,
    ).state;
    state = g.stepLivingNpcs(state).state;
    for (const id of Object.keys(state.npcBrains)) {
      result = g.stepNpcPlan(state, id);
      state = g.recordNpcEvents(
        state,
        result.state,
        result.events,
        `npc-${state.tick}-${id}`,
      ).state;
    }
  }
  return state;
}
function action(state, command) {
  const result = g.applyAction(state, 'alice', command);
  assert.equal(result.error, undefined, JSON.stringify(command));
  return g.recordNpcEvents(
    state,
    result.state,
    result.events,
    `action-${state.tick}-${state.revision}`,
  ).state;
}
function walk(state, x, y) {
  state = action(state, { kind: 'move_to', target: { x, y } });
  for (let i = 0; i < 600 && state.entities.alice.path?.length; i++) state = stepWorld(state);
  assert.deepEqual({ x: state.entities.alice.x, y: state.entities.alice.y }, { x, y });
  return state;
}
for (const route of ['main', 'social'])
  test(`complete observatory ${route} route uses lawful actions and one final journal`, () => {
    const draft = g.createCompleteObservatoryDraft();
    const compiled = g.compilePlayableDraft(draft);
    assert.deepEqual(compiled.errors, []);
    let state = g.createStateFromPlayable(compiled.playable, ['alice']);
    assert.equal(g.projectState(state, 'alice').map.sceneProfile, 'observatory-interior-v1');
    if (route === 'main') {
      state = walk(state, 4, 6);
      state = action(state, { kind: 'pick_up', targetId: 'key' });
      state = walk(state, 9, 5);
      state = action(state, { kind: 'unlock', targetId: 'door' });
      state = action(state, { kind: 'open', targetId: 'door' });
      state = walk(state, 13, 5);
      state = action(state, { kind: 'transition', targetId: 'roof-exit' });
      assert.equal(state.entities.token.ownerId, 'keeper');
    } else {
      state = walk(state, 5, 4);
      const spoken = g.applyNpcSpeech(
        state,
        'alice',
        'keeper',
        { channel: 'say', text: 'May I use the service stairs?' },
        { suppressReply: true },
      );
      assert.equal(spoken.error, undefined);
      state = g.stepLivingNpcs(spoken.state).state;
      const offer = state.npcBrains.keeper.living.obligations.find(
        (o) => o.templateId === 'roof-pass',
      );
      assert.ok(offer);
      assert.equal(offer.status, 'proposed');
      assert.equal(state.entities.token.ownerId, 'keeper');
      state = stepWorld(state, 120); // A player may read the offer before accepting.
      assert.deepEqual({ x: state.entities.keeper.x, y: state.entities.keeper.y }, { x: 6, y: 4 });
      assert.equal(state.entities.token.ownerId, 'keeper');
      const accepted = g.respondNpcObligation(state, 'alice', 'keeper', offer.id, 'accept');
      assert.equal(accepted.error, undefined);
      state = stepWorld(accepted.state, 40);
      assert.equal(state.entities.token.ownerId, 'alice');
      state = walk(state, 7, 8);
      state = action(state, { kind: 'unlock', targetId: 'side-door' });
      state = action(state, { kind: 'open', targetId: 'side-door' });
      state = walk(state, 8, 9);
      state = action(state, { kind: 'transition', targetId: 'side-roof-exit' });
      assert.equal(state.entities.door.locked, true);
      assert.equal(state.entities.key.ownerId, undefined);
    }
    assert.equal(state.entities.alice.mapId, 'roof');
    state = walk(state, 6, 4);
    state = action(state, { kind: 'pick_up', targetId: 'journal' });
    const result = g.advanceObjectives(state, ['alice']);
    assert.equal(result.events.length, 1);
    assert.equal(result.state.entities.alice.inventory.filter((id) => id === 'journal').length, 1);
    assert.equal(g.projectState(result.state, 'alice').objectives[0].status, 'achieved');
    assert.equal(
      g.advanceObjectives(JSON.parse(JSON.stringify(result.state)), ['alice']).events.length,
      0,
    );
    assert.equal(
      g.gameProjectionSchema.safeParse(g.projectState(result.state, 'alice')).success,
      true,
    );
  });
test('objective cannot require an unreachable item or an NPC inventory without lawful acquisition', () => {
  const draft = g.createAuthoredDraft('courtyard');
  draft.objects.push({
    id: 'sealed-note',
    kind: 'item',
    mapId: 'garden',
    x: 7,
    y: 5,
    label: 'Note',
    visual: 'journal',
  });
  draft.maps[1].blocked.push({ x: 6, y: 5 }, { x: 8, y: 5 }, { x: 7, y: 4 }, { x: 7, y: 6 });
  draft.objectives = [definition([{ kind: 'party_owns_item', itemId: 'sealed-note' }])];
  assert.ok(g.compilePlayableDraft(draft).errors.includes('objective:journal:unreachable-entity'));
  const reactive = g.createAuthoredDraft();
  reactive.npcBehavior = 'reactive-v1';
  reactive.objectives = [definition([{ kind: 'party_owns_item', itemId: 'token' }])];
  assert.ok(
    g.compilePlayableDraft(reactive).errors.includes('objective:journal:item-not-obtainable'),
  );
});
test('scene profiles are explicit allowlisted metadata; journal is a real item visual', () => {
  const sample = g.createCompleteObservatoryDraft();
  const compiled = g.compilePlayableDraft(sample).playable;
  const state = g.createStateFromPlayable(compiled, ['alice']);
  assert.equal(state.maps.roof.sceneProfile, 'observatory-roof-v1');
  assert.equal(state.entities.journal.visual, 'journal');
  const forged = structuredClone(sample);
  forged.maps[0].sceneProfile = '<script>unexpected-scene</script>';
  assert.ok(g.compilePlayableDraft(forged).errors.length);
  const legacy = g.createAuthoredDraft();
  legacy.maps[0].label = 'observatory-interior-v1';
  assert.equal(g.compilePlayableDraft(legacy).playable.maps.observatory.sceneProfile, undefined);
});
test('curated sample labels are versioned optional metadata with no hidden-object projection', () => {
  const draft = g.createCompleteObservatoryDraft();
  const compiled = g.compilePlayableDraft(draft).playable;
  const state = g.createStateFromPlayable(compiled, ['alice']);
  const view = g.projectState(state, 'alice');
  assert.equal(view.map.labelTranslations.uk, 'Обсерваторія');
  assert.equal(view.map.exits[0].labelTranslations.ru, 'Крыша');
  assert.equal(state.entities.journal.labelTranslations.uk, 'Журнал спостережень');
  assert.equal(
    view.entities.some((e) => e.id === 'journal'),
    false,
  );
  assert.equal(
    view.entities.some((e) => e.id === 'token'),
    false,
  );
  assert.equal(g.gameProjectionSchema.safeParse(view).success, true);
  draft.objects.find((e) => e.id === 'journal').labelTranslations.ru = 'Changed';
  assert.equal(state.entities.journal.labelTranslations.ru, 'Журнал наблюдений');
  const custom = g.createAuthoredDraft();
  custom.objects[0].label = 'My original item';
  const customVersion = g.compilePlayableDraft(custom).playable;
  assert.equal(customVersion.entities.key.label, 'My original item');
  assert.equal(customVersion.entities.key.labelTranslations, undefined);
  const invalid = g.createCompleteObservatoryDraft();
  invalid.objects[0].labelTranslations.fr = 'Not an approved locale';
  assert.ok(g.compilePlayableDraft(invalid).errors.length);
});
