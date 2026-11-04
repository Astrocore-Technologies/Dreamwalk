const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const { prepareSceneMedia } = require('../../apps/api/dist/game/media-preparation');

function fixture() {
  const draft = g.createCompleteObservatoryDraft();
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  for (const actor of ['alice', 'bob']) Object.assign(state.entities[actor], { x: 5, y: 4 });
  state.maps[state.entities.alice.mapId].description = 'Public map fallback';
  return state;
}
function introduction(state, description, scope = {}) {
  const mapId = state.entities.alice.mapId;
  return {
    id: randomUUID(),
    actorId: 'alice',
    tick: 1,
    narration: description,
    requestHash: 'fixture',
    evidenceIds: [],
    sceneId: mapId,
    introducedScene: { id: mapId, name: 'Room', description },
    ...scope,
  };
}
const privateScopes = [
  { channel: 'whisper', audienceIds: ['alice', 'keeper'] },
  { channel: 'whisper' },
  { channel: 'public', audienceIds: ['alice', 'keeper'] },
  { audienceIds: ['alice'] },
  { audienceIds: [] },
  { channel: 'unknown' },
];

test('media prompts never use private or malformed legacy scene introductions, even for their author', () => {
  for (const scope of privateScopes) {
    const state = fixture();
    state.narrativeCanon = {
      revision: 1,
      turns: [introduction(state, 'PRIVATE_SCENE_DESCRIPTION', scope)],
    };
    const before = structuredClone(state);
    for (const actor of ['alice', 'bob'])
      for (const input of [{ kind: 'background' }, { kind: 'portrait', entityId: 'keeper' }]) {
        const result = prepareSceneMedia(state, actor, 'source', input);
        assert.equal(
          result.grounding.storyReference.locationDescription.text,
          'Public map fallback',
        );
        assert.equal(JSON.stringify(result).includes('PRIVATE_SCENE_DESCRIPTION'), false);
      }
    assert.deepEqual(state, before);
  }
});

test('media selects the original public introduction past private entries and the recent canon window', () => {
  for (const publicScope of [{}, { channel: 'public' }]) {
    const state = fixture();
    state.narrativeCanon = {
      revision: 25,
      turns: [
        introduction(state, 'PRIVATE_SCENE_DESCRIPTION', privateScopes[0]),
        introduction(state, 'Public original introduction', publicScope),
        ...Array.from({ length: 23 }, () =>
          introduction(state, 'PRIVATE_NEWER_DESCRIPTION', privateScopes[0]),
        ),
      ],
    };
    const result = prepareSceneMedia(state, 'alice', 'source', { kind: 'background' });
    assert.equal(
      result.grounding.storyReference.locationDescription.text,
      'Public original introduction',
    );
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  }
});
