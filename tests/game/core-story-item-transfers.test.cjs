const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
function world(turnBased = false) {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  let s = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  Object.assign(s.entities.alice, { x: 5, y: 4, inventory: ['key'] });
  Object.assign(s.entities.keeper, { x: 6, y: 4, label: 'Борис', inventory: [] });
  Object.assign(s.entities.key, {
    ownerId: 'alice',
    label: 'латунный ключ',
    labelTranslations: { en: 'brass key', ru: 'латунный ключ', uk: 'латунний ключ' },
  });
  if (turnBased) {
    s = g.initializeTurnController(s, ['alice', 'bob']).state;
    s = g.endPlayerTurn(s, 'alice', g.turnFence(s)).state;
    s = g.endPlayerTurn(s, 'bob', g.turnFence(s)).state;
  }
  return s;
}
const give = () => ({ kind: 'give', itemId: 'key', targetId: 'keeper' });
function proposal(
  state,
  text,
  actions = [give()],
  narration = 'Борис принял латунный ключ.',
  extra = {},
) {
  const turnId = randomUUID();
  const input = {
    operationId: randomUUID(),
    text,
    channel: 'say',
    replyLocale: 'ru',
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
    body,
    input,
    turnId,
    apply: () => g.applyStoryTurnProposal(state, 'alice', input, turnId, body),
  };
}
for (const turnBased of [false, true])
  test(`semantic handoff commits existing custody atomically, deferred=${turnBased}`, () => {
    const state = world(turnBased);
    const p = proposal(state, '*Передаю Борису латунный ключ, который нашёл у входа.*');
    assert.deepEqual(p.context.actionPreview, []);
    assert.deepEqual(
      p.context.itemTransferPolicy.segmentCandidates[0].items.map((i) => i.id),
      ['key'],
    );
    const before = structuredClone(state);
    const result = p.apply();
    assert.equal(result.error, undefined);
    assert.equal(result.clarification, undefined);
    assert.deepEqual(state, before);
    assert.equal(result.state.entities.key.ownerId, 'keeper');
    assert.deepEqual(result.state.entities.alice.inventory, []);
    assert.deepEqual(result.state.entities.keeper.inventory, ['key']);
    assert.equal(result.events.filter((e) => e.kind === 'action.give').length, 1);
    assert.equal(result.state.narrativeCanon.turns.at(-1).narration, p.body.narrative.narration);
    const reloaded = JSON.parse(JSON.stringify(result.state));
    const replay = g.applyStoryTurnProposal(reloaded, 'alice', p.input, p.turnId, p.body);
    assert.strictEqual(replay.state, reloaded);
    assert.deepEqual(replay.events, []);
    assert.deepEqual(replay.state.entities.keeper.inventory, ['key']);
  });
test('semantic handoff is not limited to parser command verbs or recipient inflection', () => {
  for (const text of [
    '*Оставляю латунный ключ в раскрытой ладони Бориса.*',
    '*I entrust the brass key to Boris.*',
    '*Вкладаю латунний ключ у долоню Бориса.*',
  ]) {
    const p = proposal(world(true), text);
    assert.equal(p.apply().error, undefined, text);
    assert.equal(p.apply().state.entities.key.ownerId, 'keeper', text);
  }
});
test('owned-item references stay minimal and no NPC inventory or private definition is disclosed', () => {
  const state = world();
  state.entities.secret = {
    ...state.entities.key,
    id: 'secret',
    label: 'UNMENTIONED_SECRET',
    labelTranslations: {},
    ownerId: 'alice',
  };
  state.entities.alice.inventory.push('secret');
  state.entities.foreign = {
    ...state.entities.key,
    id: 'foreign',
    label: 'FOREIGN_SECRET',
    labelTranslations: {},
    ownerId: 'keeper',
  };
  state.entities.keeper.inventory.push('foreign');
  const p = proposal(state, '*Передаю Борису латунный ключ.*', [give()], undefined, {
    channel: 'whisper',
    targetNpcId: 'keeper',
  });
  assert.doesNotMatch(
    JSON.stringify(p.context.itemTransferPolicy),
    /UNMENTIONED_SECRET|FOREIGN_SECRET|definitionId/,
  );
  const r = p.apply();
  assert.equal(r.error, undefined);
  assert.deepEqual(r.state.narrativeCanon.turns.at(-1).audienceIds, ['alice', 'keeper']);
  assert.equal(g.projectState(r.state, 'bob').narrative.turns.length, 0);
  for (const entry of r.entries.filter((e) => e.kind === 'outcome'))
    assert.deepEqual(entry.action, { kind: 'give' });
});
test('forged ownership, hidden recipient, capacity and stale item never commit prose or effects', () => {
  for (const alter of [
    (s) => {
      s.entities.key.ownerId = 'bob';
    },
    (s) => {
      s.entities.keeper.mapId = 'hidden-map';
    },
    (s) => {
      s.entities.keeper.x = 9;
    },
    (s) => {
      s.worldItemRules = { ...s.worldItemRules, inventoryCapacity: 1 };
      s.entities.keeper.inventory = ['foreign'];
    },
  ]) {
    const s = world(true);
    alter(s);
    const p = proposal(s, '*Передаю Борису латунный ключ.*');
    const result = p.apply();
    assert.ok(result.error || result.clarification);
    assert.strictEqual(result.state, s);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.entries, []);
  }
  const s = world(true),
    p = proposal(s, '*Передаю Борису латунный ключ.*');
  s.entities.key.revision++;
  assert.equal(p.apply().error, 'STALE_STATE');
});
test('a later invalid handoff rolls back an earlier valid transfer and all narration', () => {
  const state = world(true);
  const p = proposal(
    state,
    '*Передаю Борису латунный ключ.* *Вкладываю латунный ключ в ладонь Бориса.*',
    [give(), give()],
  );
  const r = p.apply();
  assert.ok(r.error || r.clarification);
  assert.strictEqual(r.state, state);
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.entries, []);
  assert.equal(state.entities.key.ownerId, 'alice');
});
test('a null-action acceptance of the tracked key cannot become canon, while descriptive and untracked RP remains free', () => {
  const state = world(true);
  const falseClaim = proposal(state, '*Передаю Борису латунный ключ.*', [null]);
  const r = falseClaim.apply();
  assert.ok(r.error || r.clarification);
  assert.strictEqual(r.state, state);
  assert.deepEqual(r.entries, []);
  for (const [text, narration] of [
    ['*Вертю латунный ключ в пальцах.*', 'Латунный ключ блестит в твоих пальцах.'],
    [
      '*Показываю Борису латунный ключ.*',
      'Борис не принимает латунный ключ, но внимательно его рассматривает.',
    ],
    ['*Угощаю Бориса чашкой чая.*', 'Борис принял чашку чая и улыбнулся.'],
    ['*I turn the brass key in my fingers.*', 'You return the brass key to your pocket.'],
    [
      '*I turn the brass key in my fingers.*',
      'Boris gives you a reassuring smile as you turn the brass key in your fingers.',
    ],
    [
      '*I turn the brass key in my fingers.*',
      'Boris returns to his seat while you examine the brass key.',
    ],
    [
      '*Вертю латунный ключ в пальцах.*',
      'Борис принимает решение, пока ты вертишь латунный ключ в пальцах.',
    ],
  ]) {
    state.entities.keeper.label = narration.includes('Boris') ? 'Boris' : 'Борис';
    const p = proposal(state, text, [null], narration),
      result = p.apply();
    assert.equal(result.error, undefined, text);
    assert.equal(result.clarification, undefined, text);
    assert.equal(result.state.entities.key.ownerId, 'alice');
  }
});

test('recognized acceptance cannot name a recipient different from the committed transfer', () => {
  const state = world(true);
  Object.assign(state.entities.bob, { x: 6, y: 5, label: 'Мира' });
  const p = proposal(
    state,
    '*Передаю Борису латунный ключ.*',
    [give()],
    'Мира приняла латунный ключ.',
  );
  const result = p.apply();
  assert.ok(result.error || result.clarification);
  assert.strictEqual(result.state, state);
  assert.deepEqual(result.events, []);
});

test('an incidental named observer is not mistaken for a second receiver', () => {
  const state = world(true);
  Object.assign(state.entities.bob, { x: 6, y: 5, label: 'Мира' });
  const p = proposal(
    state,
    '*Передаю Борису латунный ключ.*',
    [give()],
    'Борис принял латунный ключ, пока Мира наблюдала.',
  );
  assert.equal(p.apply().error, undefined);
  assert.equal(p.apply().clarification, undefined);
});

test('recognized literal RU UK EN receipt cannot be prose-only even with abbreviated object reference', () => {
  for (const [label, narration] of [
    ['Борис', 'Борис молча принял ключ.'],
    ['Борис', 'Борис отримав латунний ключ.'],
    ['Boris', 'Boris accepted the brass key while Mira watched.'],
  ]) {
    const state = world(true);
    state.entities.keeper.label = label;
    Object.assign(state.entities.bob, { x: 6, y: 5, label: 'Mira' });
    const p = proposal(state, '*Передаю Борису латунный ключ.*', [null], narration);
    assert.equal(p.apply().clarification, 'UNSUPPORTED', narration);
    p.body.steps[0].action = give();
    assert.equal(p.apply().error, undefined, narration);
    assert.equal(p.apply().clarification, undefined, narration);
  }
});

test('a possessive pronoun in ordinary acceptance does not claim transfer of the referenced item', () => {
  const state = world(true);
  for (const narration of ['Борис принял его совет.', 'Борис прийняв його пораду.']) {
    const p = proposal(state, '*Вертю латунный ключ в пальцах.*', [null], narration);
    assert.equal(p.apply().clarification, undefined, narration);
    assert.equal(p.apply().error, undefined, narration);
  }
});

test('frozen QA handoff with dative recipient and second-sentence receipt cannot be canon-only', () => {
  const state = world(true);
  const text = '*Передаю Борису латунный ключ, который он дал мне для проверки.*';
  const narration =
    'Ты протягиваешь Борису латунный ключ. Он принимает его и кладёт рядом с рабочим столом, чтобы он оставался под рукой для проверки фонаря.';
  const p = proposal(state, text, [null], narration);
  const refused = p.apply();
  assert.equal(refused.clarification, 'UNSUPPORTED');
  assert.strictEqual(refused.state, state);
  assert.deepEqual(refused.entries, []);
  p.body.steps[0].action = give();
  const accepted = p.apply();
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.clarification, undefined);
  assert.equal(accepted.state.entities.key.ownerId, 'keeper');
  assert.deepEqual(accepted.state.entities.alice.inventory, []);
  assert.deepEqual(accepted.state.entities.keeper.inventory, ['key']);
  assert.equal(accepted.events.filter((e) => e.kind === 'action.give').length, 1);
});

test('receipt anaphora requires an explicit local object antecedent, not merely a mentioned inventory item', () => {
  const state = world(true);
  for (const narration of [
    'Ты предлагаешь Борису план. Он принимает его и кивает.',
    'Борис выслушивает твоё объяснение. Он принимает его.',
    'Ты показываешь Борису латунный ключ. Затем вы обсуждаете план. Он принимает его.',
    'Ты показываешь Борису латунный ключ. Если план удастся, он улыбнётся. Он принимает его.',
  ]) {
    const p = proposal(state, '*Вертю латунный ключ в пальцах.*', [null], narration);
    const result = p.apply();
    assert.equal(result.error, undefined, narration);
    assert.equal(result.clarification, undefined, narration);
    assert.equal(result.state.entities.key.ownerId, 'alice');
  }
});
