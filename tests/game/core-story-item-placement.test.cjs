/** Semantic provider fixtures only. No live provider, application or database. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const contracts = require('../../packages/contracts/dist');
function world(turnBased = false) {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  let s = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  Object.assign(s.entities.alice, { x: 5, y: 4, inventory: ['key'] });
  Object.assign(s.entities.keeper, { x: 6, y: 4, label: 'Boris', inventory: [] });
  Object.assign(s.entities.bob, { x: 7, y: 5 });
  Object.assign(s.entities.key, {
    ownerId: 'alice',
    label: 'brass key',
    labelTranslations: { en: 'brass key', ru: 'латунный ключ', uk: 'латунний ключ' },
  });
  if (turnBased) {
    s = g.initializeTurnController(s, ['alice', 'bob']).state;
    s = g.endPlayerTurn(s, 'alice', g.turnFence(s)).state;
    s = g.endPlayerTurn(s, 'bob', g.turnFence(s)).state;
  }
  return s;
}
const drop = (target = { x: 5, y: 3 }, targetId = 'key') => ({ kind: 'drop', targetId, target });
function proposal(
  state,
  text = '*I set the key down*',
  actions = [drop()],
  narration = 'The key rests on the ground.',
  extra = {},
) {
  const turnId = randomUUID();
  const input = {
    operationId: randomUUID(),
    text,
    channel: 'say',
    replyLocale: 'en',
    expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
    ...(state.turnController ? { turnFence: g.turnFence(state) } : {}),
    ...extra,
  };
  const context = g.buildStoryTurnContext(state, 'alice', input, turnId);
  const body = {
    turnId,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps: context.segments.map((s, i) => ({
      segmentIndex: s.index,
      action: actions[i] ?? null,
      reply: null,
    })),
    narrative: { narration, newScene: null, newNpc: null, evidenceIds: [] },
  };
  return {
    context,
    input,
    body,
    turnId,
    apply: () => g.applyStoryTurnProposal(state, 'alice', input, turnId, body),
  };
}
const candidates = (p) => p.context.itemPlacementPolicy?.segmentCandidates[0] ?? { items: [] };
const assertRejected = (state, r) => {
  assert.ok(r.error || r.clarification);
  assert.strictEqual(r.state, state);
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.entries, []);
};
for (const turnBased of [false, true])
  test(`existing item ground placement is atomic and replay-safe, deferred=${turnBased}`, () => {
    const state = world(turnBased),
      p = proposal(state),
      before = structuredClone(state);
    assert.deepEqual(p.context.actionPreview, []);
    assert.ok(candidates(p).items[0].points.some((point) => point.x === 5 && point.y === 3));
    const r = p.apply();
    assert.equal(r.error, undefined);
    assert.equal(r.clarification, undefined);
    assert.deepEqual(state, before);
    assert.equal(r.state.entities.key.ownerId, undefined);
    assert.deepEqual(r.state.entities.alice.inventory, []);
    assert.equal(r.state.entities.key.x, 5);
    assert.equal(r.state.entities.key.y, 3);
    assert.equal(Object.keys(r.state.entities).length, Object.keys(state.entities).length);
    assert.equal(r.events.filter((e) => e.kind === 'item.placed').length, 1);
    if (turnBased) {
      assert.equal(r.state.turnController.resources.alice.additional, 0);
      assert.equal(r.state.turnController.phase, 'world');
    }
    assert.equal(r.entries.at(-1).text, p.body.narrative.narration);
    const reloaded = JSON.parse(JSON.stringify(r.state));
    const replay = g.applyStoryTurnProposal(reloaded, 'alice', p.input, p.turnId, p.body);
    assert.strictEqual(replay.state, reloaded);
    assert.deepEqual(replay.events, []);
  });
for (const text of [
  '*I lower the brass key from my pocket onto the ground beside me*',
  '*I let the key come to rest at my feet*',
  '*I leave the key here*',
  '*Кладу латунный ключ рядом*',
  '*Оставляю ключ у ног*',
  '*Викладаю латунний ключ на підлогу*',
  '*Обережно опускаю ключ до землі*',
  '*Without hesitation I set the key down*',
  '*Without saying anything, I set the key down*',
  '*Я кладу ключ рядом, не выпуская фонарь*',
  '*Не спеша кладу ключ рядом*',
  '*Не поднимая глаз, кладу ключ на пол*',
  '*Не поспішаючи залишаю ключ на підлозі*',
  '*I set the key on the ground and say thanks*',
  '*I am not keeping the key; I set it on the floor*',
  '*Кладу ключ на полу рядом со столом*',
])
  test(`typed semantic fixture admits varied wording: ${text}`, () => {
    const r = proposal(world(true), text).apply();
    assert.equal(r.error, undefined);
    assert.equal(r.clarification, undefined);
    assert.equal(r.state.entities.key.ownerId, undefined);
  });
for (const text of [
  '*I do not drop the key*',
  '*If I drop the key, Boris may notice*',
  '*I would set the key down*',
  '*He drops the key*',
  '*Boris drops the key*',
  '*I watch Boris put the key down*',
  '*I say "I drop the key"*',
  "*I say 'I drop the key'*",
  '*Я не кладу ключ на пол*',
  '*Якщо покладу ключ на підлогу*',
  '*Я говорю «кладу ключ на пол»*',
  '*Він залишає ключ на землі*',
  '*I dropped the key yesterday*',
  '*I place the key on the table*',
])
  test(`non-current/non-player/unsupported placement cannot authorize a forged drop: ${text}`, () => {
    const state = world(true),
      p = proposal(state, text);
    assertRejected(state, p.apply());
  });
test('a speech segment cannot authorize a placement', () => {
  const state = world(),
    p = proposal(state, 'I drop the key.', [drop()], undefined, { targetNpcId: 'keeper' });
  p.body.narrative = null;
  assertRejected(state, p.apply());
});
test('only named owned references appear, no unrelated private inventory or NPC knowledge', () => {
  const state = world();
  state.entities.secret = {
    ...state.entities.key,
    id: 'secret',
    label: 'PRIVATE_UNMENTIONED',
    labelTranslations: {},
  };
  state.entities.alice.inventory.push('secret');
  const p = proposal(state, '*I set the key down*', [drop()], undefined, {
    channel: 'whisper',
    targetNpcId: 'keeper',
  });
  assert.deepEqual(
    candidates(p).items.map((item) => item.id),
    ['key'],
  );
  assert.doesNotMatch(
    JSON.stringify(p.context.itemPlacementPolicy),
    /PRIVATE_UNMENTIONED|definitionId/,
  );
  assert.doesNotMatch(
    JSON.stringify(p.context.sceneSpeakers),
    /itemPlacementPolicy|PRIVATE_UNMENTIONED/,
  );
  const r = p.apply();
  assert.equal(r.error, undefined);
  assert.deepEqual(r.state.narrativeCanon.turns.at(-1).audienceIds, ['alice', 'keeper']);
  assert.equal(g.projectState(r.state, 'bob').narrative.turns.length, 0);
  assert.deepEqual(r.entries.find((entry) => entry.kind === 'outcome').action, { kind: 'drop' });
});
test('ambiguous nouns and identical full names cannot silently select inventory identity', () => {
  for (const name of ['silver key', 'brass key']) {
    const state = world();
    state.entities.other_key = {
      ...state.entities.key,
      id: 'other_key',
      label: name,
      labelTranslations: {},
    };
    state.entities.alice.inventory.push('other_key');
    const p = proposal(
      state,
      name === 'brass key' ? '*I lower the brass key to the ground*' : '*I set the key down*',
    );
    assert.deepEqual(candidates(p).items, []);
    assertRejected(state, p.apply());
    const identified = proposal(state, '*I lower other_key to the ground*', [
      drop({ x: 5, y: 3 }, 'other_key'),
    ]);
    assert.equal(identified.apply().error, undefined);
  }
});
test('invalid identities, missing/forged point and unreferenced items are forbidden', () => {
  for (const action of [
    drop({ x: 10, y: 10 }),
    drop({ x: 5, y: 3 }, 'keeper'),
    { kind: 'drop', targetId: 'key' },
    { ...drop(), itemId: 'key' },
  ]) {
    const state = world();
    assertRejected(state, proposal(state, '*I set the key down*', [action]).apply());
  }
  const state = world();
  assertRejected(state, proposal(state, '*I wave*').apply());
  state.entities.key.ownerId = 'bob';
  assertRejected(state, proposal(state).apply());
});
test('original actor, item, map and geometry changes invalidate frozen context', () => {
  for (const alter of [
    (s) => s.entities.alice.revision++,
    (s) => s.entities.key.revision++,
    (s) => s.maps.observatory.revision++,
    (s) => s.maps.observatory.blocked.push({ x: 12, y: 12 }),
  ]) {
    const state = world(),
      p = proposal(state);
    alter(state);
    assert.equal(p.apply().error, 'STALE_STATE');
  }
});
test('duplicate mutations roll back all effects and narration', () => {
  for (const second of [
    drop(),
    { kind: 'consume', targetId: 'key' },
    { kind: 'give', itemId: 'key', targetId: 'keeper' },
  ]) {
    const state = world(true);
    assertRejected(
      state,
      proposal(state, '*I lower the key to the floor* *I leave the key here*', [
        drop(),
        second,
      ]).apply(),
    );
  }
});
for (const narration of [
  'The key is now on the ground.',
  'The key settles beside you.',
  'You release the key onto the floor.',
  'Ты кладёшь ключ на пол.',
  'Ключ теперь лежит рядом.',
  'Ключ лежить на підлозі.',
])
  test(`prose-only tracked placement is not canon: ${narration}`, () => {
    const state = world();
    assertRejected(state, proposal(state, '*I set the key down*', [null], narration).apply());
  });
test('typed placement narration is the actual ground result, not model-invented surface or trajectory', () => {
  for (const narration of [
    'The key flies across the room and hits Boris.',
    'You put the key on the table.',
    'You keep the key in your pocket.',
  ]) {
    const r = proposal(world(), '*I set the key down*', [drop()], narration).apply();
    assert.equal(r.error, undefined);
    assert.equal(r.entries.at(-1).text, 'You placed the carried item on the ground.');
    assert.equal(r.state.narrativeCanon.turns.at(-1).narration, r.entries.at(-1).text);
  }
});
test('ordinary descriptive and untracked RP stays available', () => {
  for (const [text, narration] of [
    ['*I turn the key in my hand*', 'The key shines in your hand.'],
    ['*I turn the key in my hand*', 'The key is still in your hand as you look at the ground.'],
    ['*I hold the key*', 'You lower your eyes toward the floor while holding the key.'],
    ['*I hold the key and greet Boris*', 'Boris serves a cup of tea on the table.'],
    ['*I set a fictional scarf on the ground*', 'The scarf rests beside you.'],
    ['*I do not drop the key*', 'You keep the key in your pocket.'],
  ]) {
    const r = proposal(world(), text, [null], narration).apply();
    assert.equal(r.error, undefined, text);
    assert.equal(r.clarification, undefined, text);
    assert.equal(r.state.entities.key.ownerId, 'alice');
  }
});
test('drop remains absent from unrestricted legacy narrative actions', () => {
  assert.equal(contracts.narrativeActionSchema.safeParse(drop()).success, false);
  assert.equal(contracts.storyActionSchema.safeParse(drop()).success, true);
});
test('a post-drop stale advisory reply is omitted without losing source speech or the committed item', () => {
  const state = world(true),
    p = proposal(state, '*I lower the key onto the ground* There it is.', [drop(), null]);
  const voice = p.context.sceneSpeakers.find(
    (entry) => entry.npcId === 'keeper' && entry.segmentIndex === 1,
  );
  assert.ok(voice);
  Object.assign(p.body.steps[1], {
    replyNpcId: 'keeper',
    replyContextHash: 'stale-after-drop',
    reply: { text: 'I have seen your private inventory.' },
  });
  const r = p.apply();
  assert.equal(r.error, undefined);
  assert.equal(r.clarification, undefined);
  assert.equal(r.state.entities.key.ownerId, undefined);
  assert.equal(r.entries.filter((entry) => entry.kind === 'speech').length, 1);
  assert.equal(r.entries.filter((entry) => entry.kind === 'npc_reply').length, 0);
  assert.doesNotMatch(JSON.stringify(r.state.npcUtterances), /private inventory/);
});

test('an independently requested drop then pickup resolves in order when both resources remain', () => {
  const state = world(true);
  state.turnController.ruleset.additional = 2;
  state.turnController.resources.alice.additional = 2;
  const p = proposal(state, '*I lower the brass key onto the floor* *I pick up the brass key*', [
    drop(),
    { kind: 'pick_up', targetId: 'key' },
  ]);
  const r = p.apply();
  assert.equal(r.error, undefined);
  assert.equal(r.clarification, undefined);
  assert.equal(r.state.entities.key.ownerId, 'alice');
  assert.deepEqual(r.state.entities.alice.inventory, ['key']);
  assert.equal(r.events.filter((e) => e.kind === 'item.placed').length, 1);
  assert.equal(r.state.turnController.resources.alice.additional, 0);
  assert.equal(r.entries.at(-1).text, p.body.narrative.narration);
});

test('failure of a later pickup rolls back an earlier drop without success narration', () => {
  const state = world(true);
  assertRejected(
    state,
    proposal(state, '*I lower the brass key onto the floor* *I pick up the brass key*', [
      drop(),
      { kind: 'pick_up', targetId: 'key' },
    ]).apply(),
  );
});

test('earlier approach changes live reach: an old offered point is rechecked after movement', () => {
  const state = world();
  Object.assign(state.entities.keeper, { x: 10, y: 5 });
  const p = proposal(state, '*I approach Boris* *I lower the key to the ground*', [
    { kind: 'approach', targetId: 'keeper' },
    drop(),
  ]);
  assert.ok(
    candidates({
      context: {
        itemPlacementPolicy: {
          segmentCandidates: [
            p.context.itemPlacementPolicy.segmentCandidates.find(
              (entry) => entry.segmentIndex === 1,
            ),
          ],
        },
      },
    }).items[0].points.length,
  );
  assertRejected(state, p.apply());
});

test('ordered existing-location travel binds the second placement to the destination map', () => {
  const state = world(true);
  const destination = {
    ...structuredClone(state.maps.observatory),
    id: 'annex',
    label: 'Annex',
    blocked: [],
    exits: [],
    spawns: [{ x: 5, y: 4 }],
  };
  state.maps.annex = destination;
  const p = proposal(state, '*I go to Annex* *I lower the key to the ground*', [
    { kind: 'travel', targetId: 'annex' },
    null,
  ]);
  const second = p.context.itemPlacementPolicy.segmentCandidates.find(
    (entry) => entry.segmentIndex === 1,
  );
  assert.equal(second.readset.mapId, 'annex');
  assert.ok(second.items[0].points.length);
  p.body.steps[1].action = drop(second.items[0].points[0]);
  const r = p.apply();
  assert.equal(r.error, undefined);
  assert.equal(r.clarification, undefined);
  assert.equal(r.state.entities.alice.mapId, 'annex');
  assert.equal(r.state.entities.key.mapId, 'annex');
  assert.equal(r.state.entities.key.ownerId, undefined);
});

test('grounded placement keeps rich mixed RP prose and unrelated surfaces or hands', () => {
  for (const narration of [
    'The key rests at your feet while Boris sets a cup on the table.',
    'You lower the key to the floor, then keep your hands at your sides.',
    'You gently lower the key onto the floor. Boris smiles and points toward the open doorway.',
  ]) {
    const p = proposal(world(), '*I lower the key onto the ground*', [drop()], narration);
    const r = p.apply();
    assert.equal(r.error, undefined);
    assert.equal(r.clarification, undefined);
    assert.equal(r.entries.at(-1).text, narration);
    assert.equal(r.state.narrativeCanon.turns.at(-1).narration, narration);
  }
});

test('unrelated hidden NPC revision is not geometry, while a collision change invalidates placement', () => {
  const state = world();
  state.entities.hidden = { ...state.entities.keeper, id: 'hidden', x: 18, y: 18 };
  const p = proposal(state);
  state.entities.hidden.revision++;
  assert.equal(p.apply().error, undefined);
  Object.assign(state.entities.hidden, { x: 5, y: 3 });
  assert.equal(p.apply().error, 'STALE_STATE');
});
