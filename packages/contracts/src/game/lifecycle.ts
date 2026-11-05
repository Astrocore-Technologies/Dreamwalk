import { z } from 'zod';

export const actorLifeStateSchema = z.enum(['conscious', 'unconscious', 'dead']);
export type ActorLifeState = z.infer<typeof actorLifeStateSchema>;
type LifeStateEntity = { kind?: string; lifeState?: ActorLifeState; vitality?: number };

/** Older saves used zero vitality without a lifecycle flag. It means incapacity,
 * never retroactive death. Positive healing alone cannot clear an explicit state. */
export function actorLifeState(entity: LifeStateEntity): ActorLifeState {
  return (
    entity.lifeState ??
    (entity.vitality !== undefined && entity.vitality <= 0 ? 'unconscious' : 'conscious')
  );
}
export function isActorConscious(entity: LifeStateEntity | undefined): boolean {
  return (
    !!entity &&
    actorLifeState(entity) === 'conscious' &&
    (entity.vitality === undefined || entity.vitality > 0)
  );
}
