const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');

function world() {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  Object.assign(state.entities.alice, { x: 5, y: 4 });
  return state;
}
function turn(narration, scope = {}) {
  return {
    id: randomUUID(),
    actorId: 'alice',
    requestHash: 'fixture',
    tick: 1,
    narration,
    evidenceIds: [],
    ...scope,
  };
}
function proposal(state, audienceIds, overrides = {}) {
  return {
    turnId: randomUUID(),
    contextHash: g.buildNarrativeContext(state, 'alice', 'Continue', 'en', audienceIds).contextHash,
    narration: 'PRIVATE_CANON_TEXT',
    newScene: null,
    newNpc: null,
    actions: [],
    evidenceIds: [],
    ...overrides,
  };
}
function apply(state, p, audienceIds) {
  return g.applyNarrativeProposal(state, 'alice', p, 'Continue', 'en', audienceIds);
}

test('public context excludes private canon and evidence even for its author', () => {
  const state = world();
  const legacy = turn('Legacy public canon'),
    publicTurn = turn('Explicit public canon', { channel: 'public' }),
    whisper = turn('PRIVATE_ALICE_KEEPER', {
      channel: 'whisper',
      audienceIds: ['alice', 'keeper'],
    }),
    otherWhisper = turn('PRIVATE_BOB_KEEPER', {
      actorId: 'bob',
      channel: 'whisper',
      audienceIds: ['bob', 'keeper'],
    });
  state.narrativeCanon = { revision: 4, turns: [legacy, publicTurn, whisper, otherWhisper] };
  for (const actorId of ['alice', 'bob']) {
    const context = g.buildNarrativeContext(state, actorId, 'Continue');
    assert.deepEqual(context.evidenceIds, [legacy.id, publicTurn.id]);
    assert.deepEqual(
      context.confirmedTurns.map((t) => t.id),
      context.evidenceIds,
    );
    assert.equal(JSON.stringify(context).includes('PRIVATE_'), false);
  }
  const p = proposal(state, undefined, { evidenceIds: [whisper.id] });
  assert.equal(apply(state, p).error, 'FORBIDDEN');
});

test('private context uses the complete audience intersection and binds that scope', () => {
  const state = world();
  const publicTurn = turn('Public canon'),
    whisper = turn('PRIVATE_SHARED', { channel: 'whisper', audienceIds: ['alice', 'keeper'] }),
    actorOnly = turn('PRIVATE_ACTOR_ONLY', { channel: 'whisper', audienceIds: ['alice'] }),
    targetOnly = turn('PRIVATE_TARGET_ONLY', { channel: 'whisper', audienceIds: ['keeper'] });
  state.narrativeCanon = { revision: 4, turns: [publicTurn, whisper, actorOnly, targetOnly] };
  const context = g.buildNarrativeContext(state, 'alice', 'Continue', 'en', ['keeper', 'alice']);
  assert.equal(context.channel, 'whisper');
  assert.deepEqual(context.audienceIds, ['alice', 'keeper']);
  assert.deepEqual(context.sharedAudience, [{ id: 'alice' }, { id: 'keeper' }]);
  assert.deepEqual(context.evidenceIds, [publicTurn.id, whisper.id]);
  assert.equal(JSON.stringify(context).includes('PRIVATE_ACTOR_ONLY'), false);
  assert.equal(JSON.stringify(context).includes('PRIVATE_TARGET_ONLY'), false);
  assert.equal(
    context.contextHash,
    g.buildNarrativeContext(state, 'alice', 'Continue', 'en', ['alice', 'keeper', 'alice'])
      .contextHash,
  );
  for (const audience of [undefined, ['alice', 'bob']]) {
    const inaccessible = g.buildNarrativeContext(state, 'alice', 'Continue', 'en', audience);
    assert.deepEqual(inaccessible.evidenceIds, [publicTurn.id]);
    assert.notEqual(inaccessible.contextHash, context.contextHash);
  }
  const p = proposal(state, ['alice', 'keeper'], { evidenceIds: [actorOnly.id] });
  assert.equal(apply(state, p, ['alice', 'keeper']).error, 'FORBIDDEN');
});

test('context rejects empty, unrelated or invalid private audiences before reading canon', () => {
  const state = world();
  state.narrativeCanon = {
    revision: 1,
    turns: [turn('PRIVATE_BOB_KEEPER', { channel: 'whisper', audienceIds: ['bob', 'keeper'] })],
  };
  for (const audience of [[], ['bob', 'keeper'], ['alice', 'missing'], ['alice', 'door'], 'alice'])
    assert.throws(
      () => g.buildNarrativeContext(state, 'alice', 'Continue', 'en', audience),
      /^Error: FORBIDDEN$/,
    );
});

test('shared scene descriptions never fall back to private turn introductions', () => {
  const state = world(),
    mapId = state.entities.alice.mapId;
  state.maps[mapId].description = 'Public map description';
  state.narrativeCanon = {
    revision: 1,
    turns: [
      turn('PRIVATE_STORY', {
        channel: 'whisper',
        audienceIds: ['alice', 'keeper'],
        sceneId: mapId,
        introducedScene: { id: mapId, name: 'Private name', description: 'PRIVATE_SCENE' },
      }),
    ],
  };
  for (const audience of [undefined, ['alice', 'keeper']])
    assert.equal(
      g.buildNarrativeContext(state, 'alice', 'Continue', 'en', audience).currentScene.description,
      'Public map description',
    );
});

test('private textual canon is server-stamped, immutable, and replay-bound to its audience', () => {
  const state = world(),
    before = structuredClone(state),
    audience = ['keeper', 'alice'],
    p = proposal(state, audience),
    result = apply(state, p, audience);
  assert.equal(result.error, undefined);
  assert.deepEqual(state, before);
  const committed = result.state.narrativeCanon.turns.at(-1);
  assert.equal(committed.channel, 'whisper');
  assert.deepEqual(committed.audienceIds, ['alice', 'keeper']);
  assert.deepEqual(result.state.entities, before.entities);
  audience.push('bob');
  assert.deepEqual(committed.audienceIds, ['alice', 'keeper']);
  const restored = JSON.parse(JSON.stringify(result.state));
  const replay = apply(restored, p, ['alice', 'keeper']);
  assert.equal(replay.error, undefined);
  assert.strictEqual(replay.state, restored);
  assert.deepEqual(replay.events, []);
  for (const changedAudience of [undefined, ['alice', 'bob'], ['alice', 'keeper', 'bob']])
    assert.equal(apply(restored, p, changedAudience).error, 'INVALID_ACTION');
  assert.equal(apply(state, p).error, 'STALE_STATE');
  const publicProposal = proposal(state);
  assert.equal(apply(state, publicProposal, ['alice', 'keeper']).error, 'STALE_STATE');
  const publicResult = apply(state, publicProposal);
  assert.equal(publicResult.error, undefined);
  assert.equal(publicResult.state.narrativeCanon.turns.at(-1).audienceIds, undefined);
  assert.deepEqual(apply(publicResult.state, publicProposal).events, []);
});

test('private canon cannot add shared scenes or NPCs or choose its own audience', () => {
  const state = world(),
    audience = ['alice', 'keeper'],
    mock = g.createMockNarrativeProposal(state, 'alice', 'Continue', randomUUID()),
    before = structuredClone(state);
  for (const change of [{ newScene: mock.newScene }, { newNpc: mock.newNpc }])
    assert.equal(apply(state, proposal(state, audience, change), audience).error, 'FORBIDDEN');
  for (const change of [
    { audienceIds: ['alice', 'bob'] },
    { channel: 'public' },
    { actions: [{ kind: 'mint_currency' }] },
  ])
    assert.equal(apply(state, proposal(state, audience, change), audience).error, 'INVALID_ACTION');
  for (const invalidAudience of [[], ['keeper'], ['alice', 'missing'], ['alice', 'door']])
    assert.equal(apply(state, proposal(state, audience), invalidAudience).error, 'FORBIDDEN');
  assert.deepEqual(state, before);
});

test('projection filters before truncation, keeps legacy public turns, and fails closed on missing scope', () => {
  const state = world(),
    publicTurn = turn('Public canon'),
    privateTurns = Array.from({ length: 20 }, () =>
      turn('PRIVATE_ALICE_KEEPER', { channel: 'whisper', audienceIds: ['alice', 'keeper'] }),
    );
  state.narrativeCanon = {
    revision: 24,
    turns: [
      publicTurn,
      ...privateTurns,
      turn('PRIVATE_NO_RECIPIENTS', { channel: 'whisper' }),
      turn('PRIVATE_EMPTY_RECIPIENTS', { audienceIds: [] }),
      turn('PRIVATE_CONTRADICTORY_SCOPE', { channel: 'public', audienceIds: ['alice'] }),
    ],
  };
  assert.deepEqual(g.projectState(state, 'bob').narrative.turns, [
    { id: publicTurn.id, tick: publicTurn.tick, narration: publicTurn.narration },
  ]);
  const own = g.projectState(state, 'alice');
  assert.equal(own.narrative.turns.length, 16);
  assert.equal(own.narrative.turns.at(-1).narration, 'PRIVATE_CONTRADICTORY_SCOPE');
  assert.ok(own.narrative.turns.every((entry) => entry.channel === 'whisper'));
  assert.equal(JSON.stringify(own.narrative).includes('PRIVATE_NO_RECIPIENTS'), false);
  assert.equal(JSON.stringify(own.narrative).includes('PRIVATE_EMPTY_RECIPIENTS'), false);
  assert.ok(g.gameProjectionSchema.safeParse(own).success);
  const privateTurn = privateTurns[0];
  assert.equal(g.narrativeTurnVisibleTo(privateTurn, 'keeper'), true);
  assert.equal(g.narrativeTurnVisibleTo(privateTurn, 'alice'), true);
  assert.equal(g.narrativeTurnVisibleTo(privateTurn, 'bob'), false);
  assert.equal(
    g.narrativeTurnVisibleTo(turn('Invalid scope', { channel: 'unknown' }), 'alice'),
    false,
  );
  assert.equal(
    g.narrativeTurnVisibleTo(
      turn('Invalid scope', { channel: 'whisper', audienceIds: 'alice' }),
      'alice',
    ),
    false,
  );
});
