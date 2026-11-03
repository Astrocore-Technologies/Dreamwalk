import { z } from 'zod';
import { BATTLEMAP_CELLS, tokenSizeSchema } from './battlemap';

const point = z
  .object({ x: z.number().int().min(0).max(31), y: z.number().int().min(0).max(31) })
  .strict();
const identifier = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,80}$/)
  .refine((v) => !(v in Object.prototype));
/** Composition is presentation data. Every solid footprint must also exist in map.blocked. */
export const sceneCompositionSchema = z
  .object({
    version: z.literal(1),
    provenance: z.enum(['original-drawn-fixture', 'ai-generated-plan']),
    layers: z
      .array(
        z
          .object({
            id: identifier,
            label: z.string().trim().min(1).max(80).optional(),
            visual: z.enum(['counter', 'table', 'shelf', 'plant', 'rug']),
            x: z.number().int().min(0).max(31),
            y: z.number().int().min(0).max(31),
            width: z.number().int().min(1).max(6),
            height: z.number().int().min(1).max(4),
            solid: z.boolean(),
          })
          .strict(),
      )
      .max(24),
  })
  .strict();
export type SceneComposition = z.infer<typeof sceneCompositionSchema>;
export const characterAnimationSchema = z
  .object({
    version: z.literal(1),
    frameWidth: z.literal(128),
    frameHeight: z.literal(192),
    columns: z.literal(6),
    rows: z.literal(4),
    directions: z.tuple([
      z.literal('south'),
      z.literal('west'),
      z.literal('east'),
      z.literal('north'),
    ]),
    idleFrames: z.tuple([z.literal(0), z.literal(1)]),
    walkFrames: z.tuple([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    fps: z.literal(8),
  })
  .strict();
export type CharacterAnimation = z.infer<typeof characterAnimationSchema>;
export const characterAnimation: CharacterAnimation = characterAnimationSchema.parse({
  version: 1,
  frameWidth: 128,
  frameHeight: 192,
  columns: 6,
  rows: 4,
  directions: ['south', 'west', 'east', 'north'],
  idleFrames: [0, 1],
  walkFrames: [2, 3, 4, 5],
  fps: 8,
});
export const characterBriefSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().min(10).max(2000),
    outfit: z.string().trim().min(1).max(500),
    appearance: z.string().trim().max(500).default(''),
    style: z.literal('drawn2D'),
    renderMode: z.enum(['animated', 'static']).default('animated'),
    target: z
      .object({
        kind: z.enum(['npc', 'hero']),
        id: z.uuid(),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    source: z.enum(['text', 'photo']),
    sourcePhotoAssetId: z.uuid().optional(),
    sourcePhotoPermission: z.boolean().default(false),
    allowOutputReuse: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.source === 'photo' && (!v.sourcePhotoAssetId || !v.sourcePhotoPermission))
      ctx.addIssue({ code: 'custom', message: 'Photo and separate source permission required' });
    if (v.source === 'text' && (v.sourcePhotoAssetId || v.sourcePhotoPermission))
      ctx.addIssue({ code: 'custom', message: 'Text brief cannot contain a photo' });
  });
export const locationBriefSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().min(10).max(2000),
    style: z.literal('drawn2D'),
  })
  .strict();
export type CharacterBrief = z.infer<typeof characterBriefSchema>;
export type LocationBrief = z.infer<typeof locationBriefSchema>;
export const visualAuthoringRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('character'),
      operationId: z.uuid(),
      brief: characterBriefSchema,
      generationMode: z.enum(['fixture', 'external']).default('fixture'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('location'),
      operationId: z.uuid(),
      adventureId: z.uuid(),
      brief: locationBriefSchema,
      generationMode: z.enum(['fixture', 'external']).default('fixture'),
      spatialMode: z.enum(['ai', 'manual']).optional(),
    })
    .strict(),
]);
export const visualMutationSchema = z
  .object({ operationId: z.uuid(), expectedRevision: z.number().int().positive() })
  .strict();
export const visualLayerEditSchema = visualMutationSchema
  .extend({
    layerId: identifier,
    mapId: identifier,
    point,
    visual: z.enum(['counter', 'table', 'shelf', 'plant', 'rug']),
  })
  .strict();
export type VisualPackage = {
  id: string;
  projectId: string;
  kind: 'character' | 'location';
  name: string;
  version: number;
  provider: 'fixture' | 'external';
  providerCalls: number;
  chargeMicros: number;
  visualReview?: { confirmed: true; structuralValidation: 'passed'; consistency: 'human-reviewed' };
  sourceJobIds?: string[];
  parts: {
    role: string;
    revisionId: string;
    uploadId: string;
    sha256: string;
    width: number;
    height: number;
  }[];
  representation?: 'static';
  animation?: CharacterAnimation;
};

/** Each quote and dispatch is an explicit manual step; neither polling nor approval dispatches. */
export const visualGenerationRoleSchema = z.enum([
  'concept',
  'portrait',
  'sheet',
  'background',
  'annex-background',
  'table',
  'counter',
  'shelf',
  'plant',
  'rug',
  'door-open',
  'door-closed',
  'sample-sheet',
  'npc-sheet',
  'quest-item',
]);
export const visualGenerationQuoteSchema = visualMutationSchema
  .extend({
    role: visualGenerationRoleSchema,
    declineReuse: z.boolean().default(false),
    liveTestSessionId: z.uuid().optional(),
  })
  .strict();
export const visualGenerationDispatchSchema = visualMutationSchema
  .extend({
    role: visualGenerationRoleSchema,
    quoteId: z.uuid(),
    consent: z.literal(true),
    estimateRiskConsent: z.literal(true).optional(),
  })
  .strict();
export const visualGenerationReuseSchema = visualMutationSchema
  .extend({
    role: visualGenerationRoleSchema,
    revisionId: z.uuid(),
    semanticReview: z.literal(true),
  })
  .strict();
export type VisualGenerationRole = z.infer<typeof visualGenerationRoleSchema>;

/** Bounded planner output. Stable technical IDs carry no story canon; all public text comes from the proposal. */
const spatialRoomId = z.enum(['atelier', 'annex']);
export const compactSpatialPlanSchema = z
  .object({
    version: z.literal(1),
    title: z.string().trim().min(2).max(80),
    premise: z.string().trim().min(1).max(200),
    rooms: z
      .array(
        z
          .object({
            id: spatialRoomId,
            name: z.string().trim().min(1).max(60),
            description: z.string().trim().min(1).max(160),
            width: z.literal(BATTLEMAP_CELLS),
            height: z.literal(BATTLEMAP_CELLS),
            spawns: z.array(point).length(4),
            blocked: z.array(point).max(12),
          })
          .strict(),
      )
      .length(2),
    connection: z
      .object({
        a: point,
        b: point,
        door: point,
        name: z.string().trim().min(1).max(60),
        description: z.string().trim().min(1).max(160),
      })
      .strict(),
    furniture: z
      .array(
        z
          .object({
            id: identifier,
            name: z.string().trim().min(1).max(60),
            room: spatialRoomId,
            visual: z.enum(['counter', 'table', 'shelf', 'plant', 'rug']),
            x: z.number().int().min(0).max(31),
            y: z.number().int().min(0).max(31),
            width: z.number().int().min(1).max(4),
            height: z.number().int().min(1).max(3),
          })
          .strict(),
      )
      .max(8),
    npc: z
      .object({
        tokenSize: tokenSizeSchema.optional(),
        room: spatialRoomId,
        point,
        name: z.string().trim().min(1).max(60),
        role: z.string().trim().min(1).max(60),
        description: z.string().trim().min(1).max(160),
        appearance: z.string().trim().min(1).max(160),
      })
      .strict(),
    item: z
      .object({
        room: spatialRoomId,
        point,
        name: z.string().trim().min(1).max(60),
        description: z.string().trim().min(1).max(160),
      })
      .strict(),
    objective: z
      .object({
        title: z.string().trim().min(1).max(80),
        description: z.string().trim().min(1).max(200),
        epilogue: z.string().trim().min(1).max(200),
      })
      .strict(),
  })
  .strict();
export type CompactSpatialPlan = z.infer<typeof compactSpatialPlanSchema>;
export const spatialQuoteRequestSchema = visualMutationSchema
  .extend({ sessionId: z.uuid().optional() })
  .strict();
export const spatialDispatchRequestSchema = visualMutationSchema
  .extend({ quoteId: z.uuid(), consent: z.literal(true) })
  .strict();
export const spatialApplyRequestSchema = visualMutationSchema
  .extend({ proposalId: z.uuid(), consent: z.literal(true) })
  .strict();
