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
        label: 'Authored courtyard',
        width: 9,
        height: 9,
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
        width: 9,
        height: 9,
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
export function storyInput(visibility = 'private') {
  return {
    title: 'Authored playable acceptance',
    synopsis: 'A real custom courtyard with a copper key.',
    visibility,
    content: {
      world: 'A quiet courtyard.',
      locations: [{ id: 'courtyard', name: 'Courtyard' }],
      scenes: [{ id: 'arrival', name: 'Arrival', locationId: 'courtyard' }],
      startSceneId: 'arrival',
    },
  };
}
