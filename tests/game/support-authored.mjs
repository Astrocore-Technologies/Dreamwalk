import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
/** Deliberately non-observatory authored map proves campaigns compile actual author data. */
export function authoredDraft(sourceNpcId) {
  const boundary = [];
  for (let x = 0; x < 9; x++) boundary.push({ x, y: 0 }, { x, y: 8 });
  for (let y = 1; y < 8; y++) boundary.push({ x: 0, y }, { x: 8, y });
  return {
    schemaVersion: 1,
    title: 'Independent authored courtyard',
    startMapId: 'courtyard',
    maps: [
      {
        id: 'courtyard',
        sourceLocationId: 'courtyard',
        label: 'Authored courtyard',
        width: 24,
        height: 24,
        blocked: boundary,
        spawns: [
          { x: 2, y: 2 },
          { x: 2, y: 3 },
          { x: 2, y: 4 },
          { x: 2, y: 5 },
        ],
        exits: [
          {
            id: 'garden-exit',
            x: 7,
            y: 6,
            destinationMapId: 'garden',
            destination: { x: 2, y: 2 },
          },
        ],
      },
      {
        id: 'garden',
        label: 'Quiet garden',
        width: 24,
        height: 24,
        blocked: boundary,
        spawns: [
          { x: 2, y: 2 },
          { x: 2, y: 3 },
          { x: 2, y: 4 },
          { x: 2, y: 5 },
        ],
        exits: [
          {
            id: 'courtyard-exit',
            x: 1,
            y: 2,
            destinationMapId: 'courtyard',
            destination: { x: 7, y: 6 },
          },
        ],
      },
    ],
    objects: [
      {
        id: 'authored-key',
        kind: 'item',
        label: 'Copper key',
        mapId: 'courtyard',
        x: 3,
        y: 2,
        visual: 'key',
      },
      {
        id: 'authored-token',
        kind: 'item',
        label: 'Linen token',
        mapId: 'courtyard',
        x: 5,
        y: 3,
        visual: 'token',
        ownerNpcId: 'gardener',
      },
      {
        id: 'authored-door',
        kind: 'door',
        label: 'Garden door',
        mapId: 'courtyard',
        x: 6,
        y: 6,
        visual: 'door',
        locked: true,
        open: false,
        keyId: 'authored-key',
      },
    ],
    npcs: [
      {
        id: 'gardener',
        ...(sourceNpcId ? { sourceNpcId } : {}),
        label: 'Gardener',
        mapId: 'courtyard',
        x: 5,
        y: 3,
        visual: 'keeper',
        goal: 'help',
        patrolTarget: { x: 6, y: 3 },
      },
    ],
    roundPolicy: { maxRounds: 3, planningMs: 5000 },
  };
}
export function storyInput(visibility = 'private', npcIds = []) {
  return {
    title: 'Authored playable acceptance',
    synopsis: 'A real custom courtyard with a copper key.',
    visibility,
    content: {
      world: 'A quiet courtyard.',
      npcIds,
      locations: [{ id: 'courtyard', name: 'Courtyard' }],
      scenes: [{ id: 'arrival', name: 'Arrival', locationId: 'courtyard' }],
      startSceneId: 'arrival',
    },
  };
}

/** Explicit synthetic private publication, not an implicit change to the HTTP client.
 * Old gameplay fixtures predate source-location links: align only those references,
 * never geometry, behavior, items, rights or invitations. All writes use real APIs. */
export async function releasePrivateFixture(client, adventureId) {
  const root = `/studio/adventures/${adventureId}`;
  const story = await client.request(root);
  assert.equal(story.visibility, 'private');
  let game = await client.request(`${root}/playable-draft`);
  assert.ok(game.draft, 'A validated playable fixture must be saved before publication');
  const draft = structuredClone(game.draft);
  const content = structuredClone(story.content);
  if (!content.locations.length)
    content.locations = draft.maps.map((m) => ({
      id: m.id,
      name: m.label ?? m.id,
      description: m.description ?? '',
    }));
  const used = new Set();
  for (const location of content.locations) {
    const map =
      draft.maps.find(
        (m) => !used.has(m.id) && (m.sourceLocationId === location.id || m.id === location.id),
      ) ?? draft.maps.find((m) => !used.has(m.id));
    assert.ok(map, 'Every source location needs a fixture map');
    used.add(map.id);
    map.sourceLocationId = location.id;
  }
  const sourceIds = [...new Set(draft.npcs.flatMap((n) => (n.sourceNpcId ? [n.sourceNpcId] : [])))];
  content.npcIds = sourceIds;
  if (JSON.stringify(content) !== JSON.stringify(story.content))
    await client.request(root, { content }, 'PATCH');
  if (JSON.stringify(draft) !== JSON.stringify(game.draft)) {
    await client.request(
      `${root}/playable-draft`,
      { expectedRevision: game.revision, draft },
      'PUT',
    );
    game = await client.request(`${root}/playable-draft`);
  }
  const fresh = await client.request(root);
  const released = await client.request(`${root}/private-release`, {
    operationId: randomUUID(),
    expectedEditRevision: fresh.editRevision,
    expectedGameRevision: game.revision,
    expectedArtRevision: 0,
  });
  assert.ok(released.releaseId);
  assert.ok(released.playableVersionId);
  return released;
}
