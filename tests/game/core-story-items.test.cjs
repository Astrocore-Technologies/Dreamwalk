const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const { characterTrigger } = require('../../packages/game-core/dist/character');
function world(turnBased = false) {
  const draft = g.createCompleteObservatoryDraft();
  if (turnBased) draft.turnRules = g.turnRulesSchema.parse({});
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  Object.assign(state.entities.alice, { x: 5, y: 4 });
  if (!turnBased) return state;
  let next = g.endPlayerTurn(state, 'alice', g.turnFence(state)).state;
  return g.endPlayerTurn(next, 'bob', g.turnFence(next)).state;
}
function proposal(
  state,
  text,
  newItem = { name: 'синий платок', description: 'Обычная вещь; происхождение неизвестно.' },
  targetId = 'new_item',
) {
  const turnId = randomUUID();
  const input = {
    operationId: randomUUID(),
    text,
    channel: 'say',
    expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
    ...(state.turnController ? { turnFence: g.turnFence(state) } : {}),
  };
  const context = g.buildStoryTurnContext(state, 'alice', input, turnId);
  const body = {
    turnId,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps: context.segments.map((s) => ({
      segmentIndex: s.index,
      action: s.kind === 'attempt' ? { kind: 'pick_up', targetId } : null,
      reply: null,
    })),
    narrative: {
      narration: 'Предмет теперь в кармане.',
      newScene: null,
      newNpc: null,
      newItem,
      evidenceIds: [],
    },
  };
  return {
    turnId,
    input,
    body,
    apply: () => g.applyStoryTurnProposal(state, 'alice', input, turnId, body),
  };
}
test('natural pickup grammar recognizes the implicit-self RU action and UK/EN without guesses', () => {
  for (const [text, label] of [
    ['смотрит на пол и подымает с пола синий платок и смотрит на смотрителя', 'синий платок'],
    ['положил синий платок себе в карман', 'синий платок'],
    ['поклав хустку в кишеню', 'хустку'],
    ['put the ribbon in my pocket', 'ribbon'],
    ['I take ribbon', 'ribbon'],
    ['я взял ribbon', 'ribbon'],
    ['looks down and takes ribbon', 'ribbon'],
  ])
    assert.equal(g.explicitStoryPickup(text, [label]), true, text);
  for (const text of [
    'не положил ribbon в карман',
    'хочу взять ribbon',
    'if I take ribbon',
    'says take ribbon',
    'might pocket ribbon',
    'looks at ribbon',
    'take another item',
    'take the key and look at ribbon',
    'take the key, ribbon stays there',
    '«take ribbon»',
    'take ribbons',
    'Bob takes ribbon',
    'Страж взяла ribbon',
    'скажи смотрителю взять ribbon',
    'tell Bob to take ribbon',
    'look at Bob and Bob takes ribbon',
    'Страж смотрит на пол и взяла ribbon',
  ])
    assert.equal(g.explicitStoryPickup(text, ['ribbon']), false, text);
});
test('new ordinary RP prop commits inventory, owner, canon and witnessed pickup atomically', () => {
  const state = world(),
    p = proposal(state, '*положил синий платок себе в карман*'),
    r = p.apply();
  assert.equal(r.error, undefined);
  assert.equal(r.clarification, undefined);
  const id = `prop-${p.turnId}`;
  assert.deepEqual(state.entities.alice.inventory, []);
  assert.deepEqual(r.state.entities.alice.inventory, [id]);
  assert.equal(r.state.entities[id].ownerId, 'alice');
  assert.equal(r.state.entities[id].item.restoreVitality, 0);
  assert.equal(r.state.entities[id].item.edible, false);
  assert.equal(r.state.entities[id].keyId, undefined);
  assert.equal(r.state.narrativeCanon.turns.at(-1).introducedItem.id, id);
  assert.ok(r.entries.some((e) => e.kind === 'outcome' && e.code === 'ACTION_SUCCEEDED'));
  assert.ok(r.events.some((e) => e.kind === 'action.pick_up'));
  assert.ok(
    Object.values(r.state.npcBrains).some((brain) =>
      brain.living?.observations.some(
        (observation) =>
          observation.kind === 'item_taken' &&
          observation.targetId === id &&
          observation.confidence === 'witnessed',
      ),
    ),
  );
  assert.equal(g.projectState(r.state, 'alice').inventory[0].id, id);
  assert.ok(!g.projectState(r.state, 'bob').inventory.some((e) => e.id === id));
  assert.equal(g.gameProjectionSchema.safeParse(g.projectState(r.state, 'alice')).success, true);
  const replay = g.applyStoryTurnProposal(r.state, 'alice', p.input, p.turnId, p.body);
  assert.strictEqual(replay.state, r.state);
  assert.ok(replay.error);
  assert.equal(r.state.entities.alice.inventory.length, 1);
});
test('world-phase explicit pickup consumes only the normal remaining item-action resource', () => {
  const state = world(true),
    p = proposal(state, '*положил синий платок себе в карман*'),
    r = p.apply();
  assert.equal(r.error, undefined);
  assert.equal(r.clarification, undefined);
  assert.equal(
    r.state.turnController.resources.alice.additional,
    state.turnController.resources.alice.additional - 1,
  );
  assert.equal(
    r.state.turnController.resources.alice.movement,
    state.turnController.resources.alice.movement,
  );
  assert.equal(r.state.turnController.phase, 'world');
});
test('capacity, exhausted action resource and collisions never leave fictional success or orphan props', () => {
  for (const blocked of ['capacity', 'budget', 'duplicate']) {
    const state = world(true);
    if (blocked === 'capacity') {
      state.worldItemRules = {
        version: 1,
        inventoryCapacity: 1,
        maxWorldItems: 64,
        surfaceCapacity: 4,
      };
      state.entities.alice.inventory = ['token'];
      state.entities.token.ownerId = 'alice';
    }
    if (blocked === 'budget') state.turnController.resources.alice.additional = 0;
    if (blocked === 'duplicate')
      Object.assign(state.entities.key, { label: 'синий платок', x: 5, y: 5 });
    const p = proposal(state, '*положил синий платок себе в карман*'),
      r = p.apply();
    assert.ok(r.error || r.clarification, blocked);
    assert.strictEqual(r.state, state);
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.entries, []);
    assert.equal(r.state.entities[`prop-${p.turnId}`], undefined);
  }
});
test('negation, speech, unsupported power fields and owner claims cannot create inventory', () => {
  for (const text of [
    '*не положил синий платок себе в карман*',
    'положил синий платок себе в карман',
    '*смотрит на синий платок*',
    '*Bob takes синий платок*',
    '*смотритель положил синий платок себе в карман*',
  ]) {
    const state = world(),
      p = proposal(state, text),
      r = p.apply();
    assert.ok(r.error || r.clarification, text);
    assert.strictEqual(r.state, state);
  }
  for (const extra of [
    { ownerId: 'keeper' },
    { restoreVitality: 99 },
    { keyId: 'door' },
    { itemOwnershipContext: 'unestablished' },
  ]) {
    const state = world(),
      p = proposal(state, '*положил синий платок себе в карман*');
    Object.assign(p.body.narrative.newItem, extra);
    assert.equal(p.apply().error, 'INVALID_ACTION');
  }
});
test('existing natural pickup reuses the real item; existing owner cannot be displaced', () => {
  const state = world();
  Object.assign(state.entities.key, { x: 5, y: 5, label: 'ribbon' });
  assert.deepEqual(g.parsePlayerTextAction(state, 'alice', 'put ribbon in my pocket'), {
    kind: 'pick_up',
    targetId: 'key',
  });
  const p = proposal(state, '*put ribbon in my pocket*', null, 'key'),
    r = p.apply();
  assert.equal(r.error, undefined);
  assert.equal(r.state.entities.key.ownerId, 'alice');
  assert.equal(Object.keys(r.state.entities).length, Object.keys(state.entities).length);
  const again = proposal(r.state, '*put ribbon in my pocket*', null, 'key').apply();
  assert.equal(again.error, undefined);
  assert.equal(again.clarification, undefined);
  assert.deepEqual(again.state.entities.alice.inventory, ['key']);
  const owned = structuredClone(state);
  owned.entities.key.ownerId = 'bob';
  owned.entities.bob.inventory.push('key');
  const wrong = proposal(owned, '*put ribbon in my pocket*', null, 'key').apply();
  assert.ok(wrong.error || wrong.clarification);
  assert.strictEqual(wrong.state, owned);
});
test('pickup attempt cannot select another item, evade distance or introduce a private prop', () => {
  const state = world();
  Object.assign(state.entities.key, { x: 5, y: 5, label: 'ribbon' });
  const wrong = proposal(state, '*take ribbon*', null, 'journal').apply();
  assert.ok(wrong.error || wrong.clarification);
  assert.strictEqual(wrong.state, state);
  const p = proposal(state, '*take ribbon*', null, 'key');
  state.entities.key.x = 8;
  const stale = p.apply();
  assert.ok(stale.error);
  assert.strictEqual(stale.state, state);
  const secret = proposal(world(), '*положил синий платок себе в карман*');
  secret.input.channel = 'whisper';
  const privateResult = secret.apply();
  assert.ok(privateResult.error);
});

for (const characterized of [false, true]) {
  test(`first mundane prop pickup preserves witness evidence without moral penalties (characterization=${characterized})`, () => {
    const state = world();
    const memory = state.npcBrains.keeper.living;
    memory.personality.role = 'guard';
    memory.personality.values = ['duty'];
    if (characterized)
      memory.personality.characterization = {
        version: 1,
        motives: [{ kind: 'duty', priority: 3 }],
        reactions: [{ trigger: 'betrayal', response: 'warn', publicStance: 'guarded' }],
        publicVoice: { cadence: 'balanced', register: 'plain', humor: 'none' },
        dialogueExamples: [],
      };
    memory.relationships.alice = { trust: 2, alertness: 0, debt: 1, evidenceIds: [] };
    Object.assign(state.entities['side-door'], { x: 6, y: 5, open: true });
    const previousAffect = structuredClone(memory.affect);
    const previousRelationship = structuredClone(memory.relationships.alice);
    const p = proposal(state, '*положил синий платок себе в карман*');
    const r = p.apply();
    assert.equal(r.error, undefined);
    const next = r.state.npcBrains.keeper.living;
    const observation = next.observations.find((o) => o.targetId === `prop-${p.turnId}`);
    assert.equal(observation.kind, 'item_taken');
    assert.equal(observation.confidence, 'witnessed');
    assert.equal(observation.itemOwnershipContext, 'unestablished');
    assert.equal(characterTrigger(observation, 'keeper'), undefined);
    assert.deepEqual(next.affect, previousAffect);
    assert.deepEqual(next.relationships.alice, previousRelationship);
    assert.ok(
      next.beliefs.some(
        (b) => b.predicate === 'took_item' && b.evidenceIds.includes(observation.id),
      ),
    );
    assert.ok(!next.causes.some((c) => c.observationId === observation.id));
    assert.deepEqual(g.chooseLivingNpcIntent(r.state, 'keeper'), { kind: 'wait' });
    const speech = g.buildNpcPublicSpeechContext(r.state, 'keeper', ['alice'], [observation.id]);
    assert.equal(speech.claims[0].itemOwnershipContext, 'unestablished');
    assert.ok(!JSON.stringify(speech.claims).includes('Обычная вещь'));
    assert.equal(
      g.buildNpcDecisionContext(r.state, 'keeper').observations.find((o) => o.id === observation.id)
        .itemOwnershipContext,
      'unestablished',
    );
    const stepped = g.stepLivingNpcs(r.state);
    assert.ok(
      !stepped.events.some((e) => e.actorId === 'keeper' && e.kind === 'npc.investigating'),
    );
    assert.equal(stepped.state.entities['side-door'].open, true);
    const replay = g.applyStoryTurnProposal(r.state, 'alice', p.input, p.turnId, p.body);
    assert.strictEqual(replay.state, r.state);
    const repeated = proposal(
      r.state,
      '*положил синий платок себе в карман*',
      null,
      `prop-${p.turnId}`,
    ).apply();
    assert.equal(repeated.error, undefined);
    assert.deepEqual(repeated.state.npcBrains.keeper.living.observations, next.observations);
    assert.deepEqual(repeated.state.npcBrains.keeper.living.relationships, next.relationships);
  });
}

test('neutral pickup provenance stays within actual perception and safe speech admission', () => {
  const state = world();
  const hidden = structuredClone(state);
  hidden.entities.keeper.mapId = 'unseen-room';
  const privatePickup = proposal(hidden, '*положил синий платок себе в карман*');
  const unseen = privatePickup.apply();
  assert.equal(unseen.error, undefined);
  assert.ok(
    !unseen.state.npcBrains.keeper.living.observations.some(
      (o) => o.targetId === `prop-${privatePickup.turnId}`,
    ),
  );
  const p = proposal(state, '*положил синий платок себе в карман*');
  const seen = p.apply().state;
  const observation = seen.npcBrains.keeper.living.observations.find(
    (o) => o.targetId === `prop-${p.turnId}`,
  );
  observation.disclosure = 'private';
  observation.revealCondition = 'never';
  assert.deepEqual(
    g.buildNpcPublicSpeechContext(seen, 'keeper', ['alice'], [observation.id]).claims,
    [],
  );
});

test('ordinary authored items retain existing witnessed pickup appraisal and guard response', () => {
  const state = world();
  state.npcBrains.keeper.living.personality.role = 'guard';
  Object.assign(state.entities.key, { x: 5, y: 5, label: 'ribbon' });
  const r = proposal(state, '*take ribbon*', null, 'key').apply();
  assert.equal(r.error, undefined);
  const memory = r.state.npcBrains.keeper.living;
  const observation = memory.observations.find(
    (o) => o.kind === 'item_taken' && o.targetId === 'key',
  );
  assert.equal(observation.itemOwnershipContext, undefined);
  assert.equal(characterTrigger(observation), 'betrayal');
  assert.equal(memory.affect.mood, 'alarmed');
  assert.equal(memory.relationships.alice.trust, -1);
  assert.ok(memory.causes.some((c) => c.observationId === observation.id));
});

test('permitted reports preserve the limited pickup context, dedup and uncertainty', () => {
  const state = world();
  const p = proposal(state, '*положил синий платок себе в карман*');
  const seen = p.apply().state;
  seen.entities.listener = { ...structuredClone(seen.entities.keeper), id: 'listener', x: 6, y: 5 };
  seen.npcBrains.listener = structuredClone(seen.npcBrains.keeper);
  seen.npcBrains.listener.living = g.createLivingMemory();
  const observation = seen.npcBrains.keeper.living.observations.find(
    (o) => o.targetId === `prop-${p.turnId}`,
  );
  const report = g.conveyNpcObservation(seen, 'keeper', 'listener', observation.id);
  assert.equal(report.error, undefined);
  const memory = report.state.npcBrains.listener.living;
  const copied = memory.observations.find((o) => o.rootId === observation.rootId);
  assert.equal(copied.itemOwnershipContext, 'unestablished');
  assert.equal(copied.confidence, 'reported');
  assert.equal(memory.affect.mood, 'calm');
  assert.equal(memory.relationships.alice, undefined);
  assert.deepEqual(memory.causes, []);
  const replay = g.conveyNpcObservation(report.state, 'keeper', 'listener', observation.id);
  assert.strictEqual(replay.state, report.state);
  assert.equal(
    g.applyNpcSpeech(state, 'alice', 'keeper', {
      channel: 'say',
      claim: {
        kind: 'item_taken',
        actorId: 'alice',
        targetId: 'key',
        itemOwnershipContext: 'unestablished',
      },
    }).error,
    'INVALID_ACTION',
  );
});
