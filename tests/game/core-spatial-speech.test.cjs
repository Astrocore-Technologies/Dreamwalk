const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
function world() {
  const draft = g.createAuthoredDraft('courtyard');
  draft.npcBehavior = 'reactive-v1';
  const compiled = g.compilePlayableDraft(draft);
  assert.deepEqual(compiled.errors, []);
  const state = g.createStateFromPlayable(compiled.playable, ['alice']);
  state.maps.courtyard.blocked = [];
  state.maps.courtyard.width = state.maps.courtyard.height = 24;
  for (const entity of Object.values(state.entities))
    if (entity.kind === 'door') entity.open = true;
  Object.assign(state.entities.alice, { x: 5, y: 5 });
  Object.assign(state.entities.keeper, { x: 8, y: 5 });
  for (const [id, x, y] of [
    ['one', 6, 5],
    ['three', 5, 8],
    ['four', 9, 5],
    ['six', 11, 5],
    ['seven', 12, 5],
    ['diagonal', 7, 7],
  ]) {
    state.entities[id] = { ...state.entities.keeper, id, x, y };
    state.npcBrains[id] = structuredClone(state.npcBrains.keeper);
  }
  return state;
}
test('area speech reaches every listener at normal3, shout6, whisper1 inclusive boundaries', () => {
  const state = world();
  for (const [speech, heard, excluded] of [
    [
      { channel: 'say', text: 'Hello' },
      ['one', 'keeper', 'three'],
      ['four', 'six', 'seven', 'diagonal'],
    ],
    [
      { channel: 'say', text: 'Hello!' },
      ['one', 'keeper', 'three', 'four', 'six', 'diagonal'],
      ['seven'],
    ],
    [
      { channel: 'whisper', text: 'Hello!' },
      ['one'],
      ['keeper', 'three', 'four', 'six', 'seven', 'diagonal'],
    ],
  ]) {
    const result = g.applyNpcSpeech(state, 'alice', undefined, speech, { suppressReply: true });
    assert.equal(result.error, undefined);
    for (const id of heard) {
      const marker = g.admittedNpcSpeechObservationId(result.state, 'alice', id, speech);
      assert.ok(marker, `${speech.channel} ${speech.text}: ${id} hears`);
      assert.ok(g.npcReplyObservation(result.state, 'alice', id, marker));
    }
    for (const id of excluded)
      assert.equal(
        g.admittedNpcSpeechObservationId(result.state, 'alice', id, speech),
        undefined,
        id,
      );
    assert.equal(
      result.state.npcUtterances.length,
      1,
      'one area utterance and no compulsory NPC response',
    );
  }
});
test('hearing follows Manhattan footprint edges, same map, and acoustic barriers', () => {
  const state = world();
  Object.assign(state.entities.alice, { tokenSize: 'large' });
  assert.ok(
    g.npcSpeechListenerIds(state, 'alice', { channel: 'say', text: 'Hello' }).includes('four'),
  );
  state.entities.one.mapId = 'elsewhere';
  assert.ok(
    !g.npcSpeechListenerIds(state, 'alice', { channel: 'whisper', text: 'Hello' }).includes('one'),
  );
  state.entities.alice.tokenSize = 'medium';
  state.maps.courtyard.blocked = Array.from({ length: 24 }, (_, y) => ({ x: 7, y }));
  assert.ok(
    !g.npcSpeechListenerIds(state, 'alice', { channel: 'say', text: 'Hello!' }).includes('keeper'),
  );
});
test('whisper participant privacy includes nearby bystanders, not distant listeners', () => {
  const state = world();
  Object.assign(state.entities.keeper, { x: 5, y: 6 });
  const result = g.applyNpcSpeech(
    state,
    'alice',
    'keeper',
    { channel: 'whisper', text: 'Quiet!' },
    { suppressReply: true },
  );
  assert.equal(result.error, undefined);
  for (const id of ['keeper', 'one']) {
    const observation = result.state.npcBrains[id].living.observations.at(-1);
    assert.equal(observation.disclosure, 'participants');
    assert.deepEqual(observation.audienceIds, ['alice', 'keeper', 'one']);
    assert.equal(
      g.buildNpcPublicSpeechContext(
        result.state,
        id,
        ['alice', 'keeper', 'one', 'three'],
        [observation.id],
      ).claims.length,
      0,
    );
  }
});
test('deferred reply authorizes prospective range6 then delivers actual normal3 or shout6', () => {
  let state = world();
  state = g.initializeTurnController(state, ['alice']).state;
  const speech = { channel: 'say', text: 'Can anyone hear me!' };
  const identity = { turnId: '00000000-0000-4000-8000-000000000001', segmentIndex: 0 };
  state = g.applyNpcSpeech(state, 'alice', undefined, speech, {
    suppressReply: true,
    identity,
  }).state;
  const marker = g.admittedNpcSpeechObservationId(state, 'alice', 'keeper', speech, identity);
  const audience = g.npcSpeechListenerIds(state, 'alice', speech);
  const queued = g.queueTurnSpeech(
    state,
    'alice',
    {
      id: 'area-reply',
      recipientId: 'keeper',
      utteranceId: marker,
      channel: 'say',
      audienceIds: audience,
    },
    g.turnFence(state),
  );
  assert.equal(queued.error, undefined);
  state = g.endPlayerTurn(queued.state, 'alice', g.turnFence(queued.state)).state;
  const prospective = g.npcSpeechProspectiveListenerIds(state, 'keeper', 'say');
  const context = g.buildNpcPublicSpeechContext(
    state,
    'keeper',
    prospective,
    [marker],
    [],
    'area-reply',
  );
  const input = {
    channel: 'say',
    recipientId: 'alice',
    observationIds: [marker],
    deferredSpeechId: 'area-reply',
    contextHash: g.npcContextFingerprint(context),
  };
  const normal = g.commitNpcPublicUtterance(state, 'keeper', { ...input, text: 'I can hear you.' });
  assert.equal(normal.error, undefined);
  assert.ok(
    !normal.state.npcUtterances.at(-1).audienceIds.includes('three'),
    'source heard shout but is six cells from NPC',
  );
  const shout = g.commitNpcPublicUtterance(state, 'keeper', { ...input, text: 'I can hear you!' });
  assert.equal(shout.error, undefined);
  assert.ok(shout.state.npcUtterances.at(-1).audienceIds.includes('three'));
  assert.ok(
    shout.state.npcUtterances.at(-1).audienceIds.includes('seven'),
    'NPC shout includes a preapproved listener beyond the player incoming range',
  );
});
test('new reply whisper bystander cannot expose original private utterance', () => {
  let state = world();
  Object.assign(state.entities.keeper, { x: 5, y: 6 });
  state = g.initializeTurnController(state, ['alice']).state;
  const speech = { channel: 'whisper', text: 'Private source words' };
  const identity = { turnId: '00000000-0000-4000-8000-000000000003', segmentIndex: 0 };
  state = g.applyNpcSpeech(state, 'alice', undefined, speech, {
    suppressReply: true,
    identity,
  }).state;
  const marker = g.admittedNpcSpeechObservationId(state, 'alice', 'keeper', speech, identity);
  const queued = g.queueTurnSpeech(
    state,
    'alice',
    {
      id: 'private-reply',
      recipientId: 'keeper',
      utteranceId: marker,
      channel: 'whisper',
      audienceIds: g.npcSpeechListenerIds(state, 'alice', speech),
    },
    g.turnFence(state),
  );
  assert.equal(queued.error, undefined);
  state = g.endPlayerTurn(queued.state, 'alice', g.turnFence(queued.state)).state;
  Object.assign(state.entities.four, { x: 5, y: 7 });
  const audience = g.npcSpeechProspectiveListenerIds(state, 'keeper', 'whisper');
  assert.ok(audience.includes('four'));
  const context = g.buildNpcPublicSpeechContext(
    state,
    'keeper',
    audience,
    [marker],
    [],
    'private-reply',
  );
  assert.equal(context.claims.length, 0);
  assert.ok(!JSON.stringify(context).includes('Private source words'));
  const result = g.commitNpcPublicUtterance(state, 'keeper', {
    channel: 'whisper',
    text: 'Private source words',
    recipientId: 'alice',
    observationIds: [marker],
    deferredSpeechId: 'private-reply',
    contextHash: g.npcContextFingerprint(context),
  });
  assert.equal(result.error, 'FORBIDDEN');
});
