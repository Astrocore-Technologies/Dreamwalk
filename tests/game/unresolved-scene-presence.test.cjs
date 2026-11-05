const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  bindUnresolvedScenePresence,
} = require('../../apps/api/src/game/unresolved-scene-presence.ts');
const { visualDigest } = require('../../apps/api/src/visual-authoring/fingerprint.ts');
function fixture() {
  const npc = randomUUID(),
    content = { npcIds: [npc], locations: [{ id: 'tower' }], scenes: [] };
  const state = {
    entities: {
      [npc]: {
        id: npc,
        kind: 'npc',
        mapId: 'tower',
        sceneId: 'unresolved',
        spatialMode: 'location_only',
        unresolvedScenePresence: {
          kind: 'unspecified_opening',
          sourceMapId: 'tower',
          sourceSceneId: 'unresolved',
          sourceChecksum: visualDigest(content),
        },
      },
    },
    maps: {
      tower: {
        id: 'tower',
        spatialMode: 'location_only',
        scenePresence: {
          entrySceneId: 'entry',
          scenes: [
            { id: 'entry', participantIds: [] },
            { id: 'unresolved', participantIds: [npc] },
          ],
        },
      },
    },
  };
  return { npc, content, state };
}
test('fresh start binds existing unassigned singleton source proof to immutable package checksum', () => {
  const f = fixture();
  bindUnresolvedScenePresence(f.state, f.content, 'b'.repeat(64));
  assert.equal(f.state.entities[f.npc].unresolvedScenePresence.sourceChecksum, 'b'.repeat(64));
});
for (const [name, change] of [
  [
    'authored hidden assignment',
    (f) => {
      f.content.scenes.push({ id: 'secret', participantNpcIds: [f.npc] });
      f.state.entities[f.npc].unresolvedScenePresence.sourceChecksum = visualDigest(f.content);
    },
  ],
  ['wrong content', (f) => f.content.locations.push({ id: 'other' })],
  ['foreign NPC', (f) => (f.content.npcIds = [])],
  ['different scene', (f) => (f.state.entities[f.npc].sceneId = 'entry')],
  [
    'shared singleton',
    (f) => f.state.maps.tower.scenePresence.scenes[1].participantIds.push('other'),
  ],
])
  test(`cannot establish unresolved eligibility for ${name}`, () => {
    const f = fixture();
    change(f);
    assert.throws(
      () => bindUnresolvedScenePresence(f.state, f.content, 'b'.repeat(64)),
      /UNRESOLVED_SOURCE_INVALID/,
    );
  });
