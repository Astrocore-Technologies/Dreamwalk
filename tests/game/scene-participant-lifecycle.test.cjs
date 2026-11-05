const test = require('node:test');
const assert = require('node:assert/strict');
const {
  remapSceneParticipants,
} = require('../../apps/api/src/story-authoring/scene-participants.ts');
test('copy and replacement remap only explicit participant IDs; removal never substitutes another NPC', () => {
  const scenes = [{ id: 'opening', participantNpcIds: ['a', 'b'] }, { id: 'legacy' }];
  assert.deepEqual(
    remapSceneParticipants(
      scenes,
      new Map([
        ['a', 'copy-a'],
        ['b', 'copy-b'],
      ]),
    ),
    [{ id: 'opening', participantNpcIds: ['copy-a', 'copy-b'] }, { id: 'legacy' }],
  );
  assert.deepEqual(remapSceneParticipants(scenes, new Map([['a', 'a']])), [
    { id: 'opening', participantNpcIds: ['a'] },
    { id: 'legacy' },
  ]);
  assert.deepEqual(scenes[0].participantNpcIds, ['a', 'b']);
});
