import type { GameEnvelope } from '@dreamwalk/contracts';
export type EncounterRetryContext = {
  streamId: string;
  connectionEpoch: number;
  revision: number;
  actorId: string;
  mapId: string;
  x: number;
  y: number;
  movementGeneration: number;
  lastInputSeq: number;
  inEncounter: boolean;
};
export function encounterRetryContext(value: GameEnvelope | null): EncounterRetryContext | null {
  if (!value) return null;
  const p = value.projection,
    actor = p.entities.find((entry) => entry.id === p.actorId);
  if (!actor) return null;
  return {
    streamId: value.streamId,
    connectionEpoch: value.connectionEpoch,
    revision: p.revision,
    actorId: p.actorId,
    mapId: p.map.id,
    x: actor.x,
    y: actor.y,
    movementGeneration: actor.movementGeneration ?? 0,
    lastInputSeq: actor.lastInputSeq ?? 0,
    inEncounter: !!actor.encounterId || !!p.encounter,
  };
}
/** Only an explicitly rejected, non-effectful coordination start can be rebased once. */
export function canRetryEncounterBegin(input: {
  type: string;
  status: string;
  code?: string;
  attempts: number;
  connected: boolean;
  before: EncounterRetryContext | null;
  after: EncounterRetryContext | null;
}): boolean {
  const { before, after } = input;
  return (
    input.type === 'encounter.begin' &&
    input.status === 'rejected' &&
    input.code === 'STALE_STATE' &&
    input.attempts === 0 &&
    input.connected &&
    !!before &&
    !!after &&
    !before.inEncounter &&
    !after.inEncounter &&
    after.revision > before.revision &&
    before.streamId === after.streamId &&
    before.connectionEpoch === after.connectionEpoch &&
    before.actorId === after.actorId &&
    before.mapId === after.mapId &&
    before.x === after.x &&
    before.y === after.y &&
    before.movementGeneration === after.movementGeneration &&
    before.lastInputSeq === after.lastInputSeq
  );
}
