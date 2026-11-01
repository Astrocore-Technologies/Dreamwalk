/** Provider fixtures only: different geometry and public canon, no network/model claim. */
export function spatialFixture(kind = 'library') {
  const garden = kind === 'greenhouse',
    width = garden ? 18 : 14,
    height = garden ? 14 : 12;
  return {
    version: 1,
    title: garden ? 'The glass seedhouse' : 'The copper catalogue',
    premise: garden
      ? 'A living conservatory shelters rare seedlings.'
      : 'A maritime library preserves lost navigation records.',
    rooms: [
      {
        id: 'atelier',
        name: garden ? 'Sunlit conservatory' : 'Chart reading room',
        description: garden
          ? 'Warm glass walls and orderly seed benches.'
          : 'Oak shelves surround quiet chart tables.',
        width,
        height,
        spawns: [
          { x: 2, y: 8 },
          { x: 3, y: 8 },
          { x: 2, y: 9 },
          { x: 3, y: 9 },
        ],
        blocked: [],
      },
      {
        id: 'annex',
        name: garden ? 'Propagation room' : 'Catalogue archive',
        description: garden
          ? 'A cool chamber keeps rare seed cases.'
          : 'A compact archive holds brass catalogue tags.',
        width: 10,
        height: 10,
        spawns: [
          { x: 2, y: 6 },
          { x: 3, y: 6 },
          { x: 2, y: 7 },
          { x: 3, y: 7 },
        ],
        blocked: [],
      },
    ],
    connection: {
      a: { x: width - 2, y: 4 },
      b: { x: 1, y: 4 },
      door: { x: width - 2, y: 5 },
      name: garden ? 'Fernwork gate' : 'Archive door',
      description: garden
        ? 'An iron gate bears a curling fern motif.'
        : 'An oak door has a polished brass handle.',
    },
    furniture: [
      {
        id: garden ? 'seed-bench' : 'chart-table',
        name: garden ? 'Seed sorting bench' : 'Navigator chart table',
        room: 'atelier',
        visual: 'table',
        x: 4,
        y: garden ? 5 : 4,
        width: garden ? 4 : 3,
        height: 2,
      },
      {
        id: garden ? 'shade-fern' : 'reading-rug',
        name: garden ? 'Shade fern' : 'Blue reading rug',
        room: 'atelier',
        visual: garden ? 'plant' : 'rug',
        x: 7,
        y: 7,
        width: garden ? 1 : 2,
        height: garden ? 1 : 2,
      },
    ],
    npc: {
      room: 'atelier',
      point: { x: 9, y: 4 },
      name: garden ? 'Elian' : 'Sera',
      role: garden ? 'botanist' : 'cataloguer',
      description: garden
        ? 'A patient botanist tends the seed trays.'
        : 'A careful cataloguer sorts numbered charts.',
      appearance: garden
        ? 'Green apron and rolled sleeves.'
        : 'Indigo coat and round reading glasses.',
    },
    item: {
      room: 'annex',
      point: { x: 5, y: 3 },
      name: garden ? 'Rare seed case' : 'Brass catalogue tag',
      description: garden
        ? 'A sealed case holds a pale spiral seed.'
        : 'A numbered brass tag identifies a missing chart.',
    },
    objective: {
      title: garden ? 'Recover the rare seed' : 'Recover the catalogue tag',
      description: garden
        ? 'Bring the seed case out of the propagation room.'
        : 'Find the tag in the catalogue archive.',
      epilogue: garden
        ? 'The recovered seed opens a new question about the conservatory.'
        : 'The tag points toward another lost navigation record.',
    },
  };
}
