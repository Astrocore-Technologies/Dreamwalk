/** Synthetic fixture via real validated authoring/publication APIs; never provider generation. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAuthoredDraft } = require('../packages/game-core/dist');
export async function publishPrivateFixture(call, adventureId) {
  const root = `/studio/adventures/${adventureId}`;
  const story = await call('GET', root);
  let game = await call('GET', `${root}/playable-draft`);
  if (!game.draft) {
    assert.equal(
      story.content.locations.length,
      1,
      'This bounded fixture supports one authored location',
    );
    const draft = createAuthoredDraft('courtyard');
    draft.maps = [{ ...draft.maps[0], exits: [], sourceLocationId: story.content.locations[0].id }];
    draft.objects = [];
    draft.npcs = story.content.npcIds.map((id, index) => ({
      ...draft.npcs[0],
      id: `release-npc-${index}`,
      sourceNpcId: id,
      label: `Fixture NPC ${index}`,
      x: 5 + index,
      y: 4,
    }));
    await call('PUT', `${root}/playable-draft`, { expectedRevision: game.revision, draft });
    game = await call('GET', `${root}/playable-draft`);
  }
  const fresh = await call('GET', root);
  const release = await call(
    'POST',
    `${root}/private-release`,
    {
      operationId: randomUUID(),
      expectedEditRevision: fresh.editRevision,
      expectedGameRevision: game.revision,
      expectedArtRevision: 0,
    },
    201,
  );
  assert.ok(release.releaseId);
  assert.ok(release.playableVersionId);
  return release;
}
