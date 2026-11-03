import { z } from 'zod';
const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((v) => !Object.prototype.hasOwnProperty.call(Object.prototype, v));
const point = { x: z.number().int().min(0).max(63), y: z.number().int().min(0).max(63) };
export const worldItemDefinitionSchema = z
  .object({
    id,
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000),
    visual: z.enum(['food', 'cup', 'battery', 'object']),
    portable: z.boolean(),
    edible: z.boolean(),
    restoreVitality: z.number().int().min(0).max(3).default(0),
  })
  .strict()
  .refine((v) => v.edible || v.restoreVitality === 0);
export type WorldItemDefinition = z.infer<typeof worldItemDefinitionSchema>;
export const worldItemDefinitionsSchema = z
  .array(worldItemDefinitionSchema)
  .max(32)
  .refine((v) => new Set(v.map((x) => x.id)).size === v.length);
export const npcItemStockSchema = z
  .array(z.object({ definitionId: id, quantity: z.number().int().min(0).max(64) }).strict())
  .max(32)
  .refine((v) => new Set(v.map((x) => x.definitionId)).size === v.length);
export type NpcItemStock = z.infer<typeof npcItemStockSchema>;
export const worldItemRulesSchema = z
  .object({
    version: z.literal(1),
    inventoryCapacity: z.number().int().min(1).max(128).default(32),
    maxWorldItems: z.number().int().min(1).max(128).default(64),
    surfaceCapacity: z.number().int().min(1).max(8).default(4),
  })
  .strict();
export type WorldItemRules = z.infer<typeof worldItemRulesSchema>;
export const worldItemStateSchema = z
  .object({
    definitionId: id,
    quantity: z.number().int().min(1).max(8),
    portable: z.boolean(),
    edible: z.boolean(),
    restoreVitality: z.number().int().min(0).max(3),
    visual: z.enum(['food', 'cup', 'battery', 'object']),
    surfaceSlot: z.number().int().min(0).max(7).optional(),
    surfaceId: id.optional(),
  })
  .strict();
export type WorldItemState = z.infer<typeof worldItemStateSchema>;
export const npcItemIntentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('place_stock'),
      definitionId: id,
      surfaceId: id.optional(),
      ...point,
    })
    .strict(),
  z.object({ kind: z.literal('give_stock'), definitionId: id, recipientId: id }).strict(),
  z
    .object({ kind: z.literal('place_existing'), itemId: id, surfaceId: id.optional(), ...point })
    .strict(),
  z.object({ kind: z.literal('give_existing'), itemId: id, recipientId: id }).strict(),
]);
export const npcItemIntentsSchema = z.array(npcItemIntentSchema).max(2);
export type NpcItemIntent = z.infer<typeof npcItemIntentSchema>;
/** NPC-authored decision, anchored to the addressed player's actual shared utterance. */
export const npcCompanionIntentSchema = z
  .object({
    kind: z.enum(['follow', 'stop']),
    actorId: id,
    sourceObservationId: z.string().min(1).max(200),
  })
  .strict();
export type NpcCompanionIntent = z.infer<typeof npcCompanionIntentSchema>;
export const npcPublicReplySchema = z.union([
  z
    .object({
      text: z.string().trim().min(1).max(1000),
      itemIntents: npcItemIntentsSchema.optional(),
      companionIntent: npcCompanionIntentSchema.optional(),
    })
    .strict(),
  z.object({ code: z.literal('acknowledged') }).strict(),
]);
