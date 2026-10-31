const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
// Configuration-only import: no Db/client is constructed and no network is used.
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:9/unused';
const { GameService } = require('../../apps/api/dist/game/game.service');
function setup() {
  const draft = g.createAuthoredDraft('courtyard');
  draft.npcBehavior = 'reactive-v1';
  let state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  Object.assign(state.entities.alice, { x: 5, y: 4 });
  state.entities.bob.mapId = 'garden';
  const speech = { channel: 'whisper', text: 'Remember: the silver tide.' };
  state = g.applyNpcSpeech(state, 'alice', 'keeper', speech, { suppressReply: true }).state;
  const id = g.admittedNpcSpeechObservationId(state, 'alice', 'keeper', speech);
  const service = Object.create(GameService.prototype);
  service.ai = { contextBudgetBytes: () => 64000 };
  return { state, id, service };
}
test('runtime speech context binds exact allowed question and legacy manual requests remain valid', async () => {
  const { state, id, service } = setup();
  const context = service.speechContext(
    state,
    'keeper',
    'alice',
    'whisper',
    undefined,
    undefined,
    id,
  );
  assert.equal(context.replyToObservationId, id);
  assert.equal(context.currentUtterance.untrustedUtterance, 'Remember: the silver tide.');
  assert.deepEqual(
    context.currentUtterance,
    context.claims.find((c) => c.observationId === id),
  );
  const job = {
    id: 'job',
    npcId: 'keeper',
    purpose: 'speech',
    context,
    contextHash: context.contextHash,
    proposal: { text: 'The silver tide.' },
  };
  assert.equal((await service.evaluateDecision('campaign', state, job)).accepted, true);
  const manual = service.speechContext(state, 'keeper', 'alice', 'whisper');
  assert.equal(manual.replyToObservationId, undefined);
  assert.equal(
    (
      await service.evaluateDecision('campaign', state, {
        ...job,
        context: manual,
        contextHash: manual.contextHash,
      })
    ).accepted,
    true,
  );
});
test('runtime rejects missing, foreign, removed or changed triggers and new unauthorized public audience', async () => {
  const { state, id, service } = setup();
  for (const [recipient, selected, marker] of [
    ['alice', undefined, 'missing'],
    ['bob', undefined, id],
    ['alice', [], id],
  ])
    assert.throws(() =>
      service.speechContext(state, 'keeper', recipient, 'whisper', selected, undefined, marker),
    );
  // With only the original two participants present, a public reply has the same allowed audience.
  const context = service.speechContext(state, 'keeper', 'alice', 'say', undefined, undefined, id);
  const job = {
    id: 'job',
    npcId: 'keeper',
    purpose: 'speech',
    context,
    contextHash: context.contextHash,
    proposal: { text: 'The silver tide.' },
  };
  for (const mutate of [
    (s) => {
      s.npcBrains.keeper.living.observations = s.npcBrains.keeper.living.observations.filter(
        (o) => o.id !== id,
      );
    },
    (s) => {
      s.npcBrains.keeper.living.observations.find((o) => o.id === id).text = 'Changed question';
    },
    (s) => {
      Object.assign(s.entities.bob, { mapId: 'courtyard', x: 5, y: 5 });
    },
  ]) {
    const changed = structuredClone(state);
    mutate(changed);
    const result = await service.evaluateDecision('campaign', changed, job);
    assert.equal(result.accepted, false);
    assert.deepEqual(result.next, changed);
  }
});
