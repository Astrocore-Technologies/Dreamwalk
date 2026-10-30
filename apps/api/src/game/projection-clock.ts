import type { GameProjection } from '@dreamwalk/contracts';
/** Derived clock display values are not a new semantic state or a command CAS conflict. */
export function semanticGameProjection(projection: GameProjection) {
  return {
    ...projection,
    tick: 0,
    revision: 0,
    ...(projection.npcObligations
      ? {
          npcObligations: projection.npcObligations.map((obligation) => ({
            ...obligation,
            remainingTicks: 0,
          })),
        }
      : {}),
  };
}
