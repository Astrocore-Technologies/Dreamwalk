import {
  characterAnimation,
  type AuthoredGameDraft,
  type LocationBrief,
} from '@dreamwalk/contracts';
/** Deterministic acceptance template. This never claims to interpret arbitrary prose with AI. */
export function createLocationFixture(brief: LocationBrief): AuthoredGameDraft {
  const border = (width: number, height: number) => {
    const points = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (!x || y < 2 || x === width - 1 || y === height - 1) points.push({ x, y });
    return points;
  };
  const layers = [
    { id: 'worktable', visual: 'table' as const, x: 3, y: 4, width: 3, height: 2, solid: true },
    { id: 'counter', visual: 'counter' as const, x: 9, y: 5, width: 3, height: 2, solid: true },
    { id: 'shelves', visual: 'shelf' as const, x: 9, y: 2, width: 3, height: 1, solid: true },
    { id: 'fern', visual: 'plant' as const, x: 2, y: 8, width: 1, height: 1, solid: true },
    { id: 'carpet', visual: 'rug' as const, x: 6, y: 6, width: 2, height: 2, solid: false },
  ];
  const blocked = border(16, 12);
  for (const l of layers.filter((l) => l.solid))
    for (let y = l.y; y < l.y + l.height; y++)
      for (let x = l.x; x < l.x + l.width; x++) blocked.push({ x, y });
  return {
    schemaVersion: 1,
    title: brief.name,
    startMapId: 'atelier',
    npcBehavior: 'reactive-v1',
    narrativeConstraints: {
      allowNewScenes: true,
      allowNewNpcs: true,
      maxScenes: 16,
      maxSupportingNpcs: 16,
      maxTurns: 256,
      protectedFacts: [],
      forbiddenRoles: [],
    },
    maps: [
      {
        id: 'atelier',
        label: brief.name,
        description: brief.description,
        width: 16,
        height: 12,
        blocked,
        composition: { version: 1, provenance: 'original-drawn-fixture', layers },
        spawns: [
          { x: 7, y: 9 },
          { x: 8, y: 9 },
          { x: 7, y: 10 },
          { x: 8, y: 10 },
        ],
        exits: [
          {
            id: 'to-annex',
            label: 'Rain room',
            x: 14,
            y: 4,
            destinationMapId: 'annex',
            destination: { x: 2, y: 4 },
            doorId: 'atelier-door',
          },
        ],
      },
      {
        id: 'annex',
        label: 'Rain room',
        width: 8,
        height: 7,
        blocked: border(8, 7),
        composition: { version: 1, provenance: 'original-drawn-fixture', layers: [] },
        spawns: [{ x: 2, y: 4 }],
        exits: [
          {
            id: 'to-atelier',
            x: 1,
            y: 4,
            destinationMapId: 'atelier',
            destination: { x: 13, y: 4 },
          },
        ],
      },
    ],
    objects: [
      {
        id: 'atelier-door',
        kind: 'door',
        label: 'Glass door',
        mapId: 'atelier',
        x: 14,
        y: 5,
        visual: 'door',
        open: false,
        locked: false,
      },
      {
        id: 'rain-journal',
        kind: 'item',
        label: 'Rain journal',
        mapId: 'annex',
        x: 4,
        y: 3,
        visual: 'journal',
      },
    ],
    npcs: [
      {
        id: 'alchemist',
        characterAnimation,
        label: 'Mira',
        mapId: 'atelier',
        x: 10,
        y: 4,
        visual: 'traveler',
        goal: 'help',
        patrolTarget: { x: 10, y: 4 },
        personality: {
          role: 'helper',
          values: ['kindness', 'honesty'],
          taboos: ['steal', 'harm', 'disclose_private'],
          speechStyle: 'warm',
        },
      },
    ],
    objectives: [
      {
        id: 'recover-rain-journal',
        title: 'Find the rain journal',
        description:
          'Mira asks you to retrieve the journal from the room behind the glass door. Open the door, step inside and bring the journal into your inventory.',
        epilogue:
          'The brass ink records tomorrow’s weather. Tonight’s impossible rain is a warning from the old observatory. You have recovered the journal and found a new lead; the story can continue.',
        translations: {
          en: {
            title: 'Find the rain journal',
            description: 'Open the glass door, enter the rain room and collect the journal.',
            epilogue:
              'The brass ink records tomorrow’s weather. Tonight’s impossible rain is a warning from the old observatory. The journal is recovered; the story can continue.',
          },
          ru: {
            title: 'Найти журнал дождя',
            description: 'Открой стеклянную дверь, войди в соседнюю комнату и забери журнал.',
            epilogue:
              'Латунные чернила записывают завтрашнюю погоду. Невозможный дождь — предупреждение из старой обсерватории. Журнал найден; историю можно продолжить.',
          },
          uk: {
            title: 'Знайти журнал дощу',
            description: 'Відчини скляні двері, увійди до сусідньої кімнати й забери журнал.',
            epilogue:
              'Латунне чорнило записує завтрашню погоду. Неможливий дощ — попередження зі старої обсерваторії. Журнал знайдено; історію можна продовжити.',
          },
        },
        completion: {
          mode: 'all',
          conditions: [{ kind: 'party_owns_item', itemId: 'rain-journal' }],
        },
      },
    ],
    roundPolicy: { maxRounds: 5, planningMs: 30000 },
  };
}
