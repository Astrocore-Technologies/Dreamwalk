import type { GameState } from '@dreamwalk/contracts';
import { observedVisible } from './observation-visibility';
/** Only perceived image-derived facts; no other-map geometry or hidden identities. */
export function spatialContext(state: GameState, actorId: string) {
  const actor = state.entities[actorId],
    map = actor && state.maps[actor.mapId];
  const g = map?.spatialGrounding;
  if (!actor || !map || !g) return undefined;
  const bound = state.artBindings?.find((b) => b.slot === `map:${map.id}:background`);
  if (bound && bound.revisionId !== g.imageRevisionId) return undefined;
  const seen = (x: number, y: number) =>
    observedVisible(state, actor, {
      id: 'spatial-cell',
      kind: 'item',
      revision: 0,
      mapId: map.id,
      x,
      y,
    });
  const visibleCells = new Set<string>();
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 24; x++) if (seen(x, y)) visibleCells.add(`${x},${y}`);
  const perceived = (x: number, y: number) => visibleCells.has(`${x},${y}`);
  return {
    mapId: map.id,
    width: map.width,
    height: map.height,
    actorPosition: { x: actor.x, y: actor.y },
    origin: 'top-left',
    xDirection: 'right',
    yDirection: 'down',
    evidence: 'image-analysis',
    confidence: g.confidence,
    policy:
      'Observed terrain is advisory RP context, not an action result. Unknown cells are not known floor. Door annotations do not grant locks, keys or actions. Do not invent hidden rooms or claim movement succeeded.',
    legend: {
      '.': 'safe floor',
      D: 'door threshold',
      '#': 'wall/rock/cliff',
      '~': 'water',
      X: 'obstacle',
      '?': 'unknown or not perceived',
    },
    rows: g.rows.map((row, y) =>
      [...row].map((cell, x) => (perceived(x, y) ? cell : '?')).join(''),
    ),
    doors: (g.doors ?? []).filter((d) => perceived(d.x, d.y)).map((d) => ({ ...d })),
    landmarks: g.landmarks.flatMap((r) => {
      const cells = [];
      for (let y = r.y; y < r.y + r.height; y++)
        for (let x = r.x; x < r.x + r.width; x++) if (perceived(x, y)) cells.push({ x, y });
      if (!cells.length) return [];
      // Partial observation never discloses a hidden room's name or unseen bounds.
      return [
        {
          kind: r.kind,
          ...(cells.length === r.width * r.height ? { label: r.label } : {}),
          visibleCells: cells,
        },
      ];
    }),
  };
}
