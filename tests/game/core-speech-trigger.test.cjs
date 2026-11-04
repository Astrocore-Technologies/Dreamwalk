const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
function world() {
  const draft = g.createAuthoredDraft('courtyard');
  draft.npcBehavior = 'reactive-v1';
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  Object.assign(state.entities.alice, { x: 5, y: 4 });
  Object.assign(state.entities.bob, { x: 5, y: 5 });
  return state;
}
function speak(state, input, speaker = 'alice') {
  const result = g.applyNpcSpeech(state, speaker, 'keeper', input, { suppressReply: true });
  assert.equal(result.error, undefined);
  const id = g.admittedNpcSpeechObservationId(result.state, speaker, 'keeper', input);
  assert.ok(id);
  return { state: result.state, id };
}
test('exact speech trigger survives unrelated evidence order and rejects missing, foreign and changed source', () => {
  const input = { channel: 'say', text: 'My promised phrase is the silver tide.' };
  const { state, id } = speak(world(), input);
  const memory = state.npcBrains.keeper.living;
  memory.observations.reverse();
  assert.equal(g.npcReplyObservation(state, 'alice', 'keeper', id).text, input.text);
  assert.equal(g.npcReplyObservation(state, 'bob', 'keeper', id), undefined);
  assert.equal(g.npcReplyObservation(state, 'alice', 'other-npc', id), undefined);
  assert.equal(g.npcReplyObservation(state, 'alice', 'keeper', 'missing'), undefined);
  memory.observations.find((o) => o.id === id).text = 'Tampered question';
  assert.equal(g.npcReplyObservation(state, 'alice', 'keeper', id), undefined);
});
test('typed allegation binds actual admitted speaker rather than the accused actorId', () => {
  const { state, id } = speak(world(), {
    channel: 'say',
    text: 'Bob took the key.',
    claim: { kind: 'item_taken', actorId: 'bob', targetId: 'key' },
  });
  assert.equal(g.npcReplyObservation(state, 'alice', 'keeper', id).actorId, 'bob');
  assert.equal(g.npcReplyObservation(state, 'bob', 'keeper', id), undefined);
});
test('reply trigger never bypasses whole-audience whisper disclosure', () => {
  const before = world();
  Object.assign(before.entities.bob, { x: 7, y: 5 }); // Outside the original one-cell whisper.
  const { state, id } = speak(before, { channel: 'whisper', text: 'Private phrase.' });
  assert.ok(
    !state.npcBrains.keeper.living.observations
      .find((o) => o.id === id)
      .audienceIds.includes('bob'),
  );
  assert.ok(g.npcReplyObservation(state, 'alice', 'keeper', id));
  assert.equal(
    g.buildNpcPublicSpeechContext(state, 'keeper', ['alice', 'keeper'], [id]).claims.length,
    1,
  );
  assert.equal(
    g.buildNpcPublicSpeechContext(state, 'keeper', ['alice', 'bob', 'keeper'], [id]).claims.length,
    0,
  );
  state.npcBrains.keeper.living.observations.find((o) => o.id === id).disclosure = 'private';
  assert.equal(g.npcReplyObservation(state, 'alice', 'keeper', id), undefined);
});

test('reply locale never changes reconstructible admitted speech identity', () => {
  const inputs = [
    { channel: 'say', text: 'A question in the original language.' },
    { channel: 'whisper', text: 'A private original question.' },
    { channel: 'say', claim: { kind: 'item_taken', actorId: 'bob', targetId: 'key' } },
    {
      channel: 'say',
      text: 'Bob took the key.',
      claim: { kind: 'item_taken', actorId: 'bob', targetId: 'key' },
    },
  ];
  for (const input of inputs) {
    for (const identity of [
      undefined,
      { turnId: '11111111-1111-4111-a111-111111111111', segmentIndex: 2 },
    ]) {
      let expected;
      for (const replyLocale of [undefined, 'uk', 'en', 'ru']) {
        const speech = { ...input, ...(replyLocale ? { replyLocale } : {}) };
        const result = g.applyNpcSpeech(world(), 'alice', 'keeper', speech, {
          suppressReply: true,
          identity,
        });
        assert.equal(result.error, undefined);
        const marker = g.admittedNpcSpeechObservationId(
          result.state,
          'alice',
          'keeper',
          speech,
          identity,
        );
        assert.ok(marker, `exact admitted ${replyLocale ?? 'legacy'} input is reconstructible`);
        expected ??= marker;
        assert.equal(
          marker,
          expected,
          'legacy and all reply locales have the same speech identity',
        );
        assert.ok(g.npcReplyObservation(result.state, 'alice', 'keeper', marker));
        assert.equal(
          g.admittedNpcSpeechObservationId(result.state, 'alice', 'keeper', input, identity),
          marker,
        );
      }
    }
  }
});
