import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/)
  .refine((value) => !Object.prototype.hasOwnProperty.call(Object.prototype, value));
const point = z
  .object({ x: z.number().int().min(0).max(63), y: z.number().int().min(0).max(63) })
  .strict();
/** Declarative fictional results, never arbitrary state, authorisation, or wallet patches. */
export const establishedRoleplayEffectSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('door_state'), targetId: id, open: z.boolean(), locked: z.boolean() })
    .strict(),
  z.object({ kind: z.literal('item_custody'), itemId: id, recipientId: id }).strict(),
  z
    .object({ kind: z.literal('item_placement'), itemId: id, point, surfaceId: id.nullable() })
    .strict(),
  z.object({ kind: z.literal('item_consumed'), itemId: id }).strict(),
  z
    .object({
      kind: z.literal('public_condition'),
      targetId: id,
      description: z.string().trim().min(1).max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal('actor_state'),
      targetId: id,
      lifeState: z.enum(['conscious', 'unconscious', 'dead']),
      vitality: z.number().int().min(0).max(100),
    })
    .strict(),
  z
    .object({ kind: z.literal('relocate'), targetId: id, mapId: id, point: point.nullable() })
    .strict(),
  z
    .object({
      kind: z.literal('create_prop'),
      ref: id,
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().min(1).max(500),
    })
    .strict(),
]);
export type EstablishedRoleplayEffect = z.infer<typeof establishedRoleplayEffectSchema>;
export const establishedRoleplayEventSchema = z
  .object({
    description: z.string().trim().min(1).max(1000),
    entityIds: z.array(id),
    effects: z.array(establishedRoleplayEffectSchema),
  })
  .strict();
export type EstablishedRoleplayEvent = z.infer<typeof establishedRoleplayEventSchema>;
export interface EstablishedRoleplayReceipt extends EstablishedRoleplayEvent {
  id: string;
  segmentIndex: number;
  eventIndex: number;
  actorId: string;
  audienceIds: string[];
  requestHash: string;
  /** Free prose is fiction, never evidence of a change to tracked physical fields. */
  authority: 'authored_fiction';
}
