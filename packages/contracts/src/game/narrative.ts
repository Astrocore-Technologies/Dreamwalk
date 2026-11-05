import { z } from 'zod';
import { tokenSizeSchema } from './battlemap';
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/)
  .refine((v) => !Object.prototype.hasOwnProperty.call(Object.prototype, v));
const copy = (max: number) => z.string().trim().min(1).max(max);
export const narrativePremiseSchema = z
  .object({
    rules: z.string().trim().max(8000).optional(),
    boundaries: z.array(z.string().trim().max(120)).max(20).optional(),
    openingScene: z.string().trim().max(6000).optional(),
    title: copy(120),
    summary: z.string().trim().max(4000),
    world: z.string().trim().max(12000).optional(),
    genre: z.string().trim().max(50).optional(),
  })
  .strict();
export type NarrativePremise = z.infer<typeof narrativePremiseSchema>;
export const narrativeConstraintsSchema = z
  .object({
    allowNewScenes: z.boolean().default(true),
    allowNewNpcs: z.boolean().default(true),
    maxScenes: z.number().int().min(1).max(32).default(16),
    maxSupportingNpcs: z.number().int().min(1).max(32).default(16),
    maxTurns: z.number().int().min(1).max(512).default(256),
    protectedFacts: z
      .array(z.object({ id, text: copy(1000) }).strict())
      .max(16)
      .default([]),
    forbiddenRoles: z.array(copy(120)).max(16).default([]),
  })
  .strict();
export type NarrativeConstraints = z.infer<typeof narrativeConstraintsSchema>;
export const narrativeNpcSchema = z
  .object({
    name: copy(80),
    roleLabel: copy(120),
    description: copy(1000),
    appearance: copy(500),
    tokenSize: tokenSizeSchema.optional(),
    personalitySummary: copy(500),
    values: z
      .array(z.enum(['duty', 'kindness', 'caution', 'honesty']))
      .min(1)
      .max(4),
    publicSpeechStyle: z.enum(['neutral', 'warm', 'formal', 'terse', 'wry']),
    goal: z.enum(['patrol', 'help']),
    placement: z.enum(['current', 'new_scene']),
    spatialMode: z.literal('location_only').optional(),
    spawn: z
      .object({ x: z.number().int().min(0).max(63), y: z.number().int().min(0).max(63) })
      .strict()
      .optional(),
    knownEntityIds: z.array(id).max(8),
  })
  .strict()
  .superRefine((n, ctx) => {
    if (n.spatialMode === 'location_only' ? !!n.spawn : !n.spawn)
      ctx.addIssue({ code: 'custom', message: 'NPC placement must match spatial mode' });
  });
export const narrativeSceneSchema = z
  .object({
    name: copy(120),
    description: copy(1000),
    template: z.enum(['room', 'courtyard']),
    connection: z
      .object({
        fromMapId: id,
        spatialMode: z.literal('location_only').optional(),
        x: z.number().int().min(0).max(63).optional(),
        y: z.number().int().min(0).max(63).optional(),
      })
      .strict()
      .superRefine((c, ctx) => {
        if (
          c.spatialMode === 'location_only'
            ? c.x !== undefined || c.y !== undefined
            : c.x === undefined || c.y === undefined
        )
          ctx.addIssue({ code: 'custom', message: 'Connection must match spatial mode' });
      }),
  })
  .strict();
export const narrativeActionSchema = z
  .object({
    kind: z.enum([
      'inspect',
      'open',
      'close',
      'unlock',
      'pick_up',
      'consume',
      'give',
      'transition',
      'travel',
      'wait',
      'hit',
      'push',
    ]),
    targetId: id.optional(),
    itemId: id.optional(),
  })
  .strict();
export const narrativeProposalSchema = z
  .object({
    turnId: z.string().uuid(),
    contextHash: copy(160),
    narration: copy(2000),
    newScene: narrativeSceneSchema.nullable(),
    newNpc: narrativeNpcSchema.nullable(),
    actions: z.array(narrativeActionSchema).max(2),
    evidenceIds: z.array(id).max(8),
  })
  .strict();
export type NarrativeProposal = z.infer<typeof narrativeProposalSchema>;
export interface ConfirmedNarrativeTurn {
  id: string;
  actorId: string;
  requestHash: string;
  tick: number;
  narration: string;
  /** Server-owned textual audience. Legacy entries without scope remain public. */
  channel?: 'public' | 'whisper';
  audienceIds?: string[];
  sceneId?: string;
  npcId?: string;
  evidenceIds: string[];
  introducedScene?: { id: string; name: string; description: string };
  introducedNpc?: { id: string; name: string; roleLabel: string };
  introducedItem?: { id: string; name: string; description: string };
  sceneEncounter?: {
    segmentIndex: number;
    npcId: string;
    fingerprint: string;
    requestToken: string;
  };
  /** Durable admission prevents a deferred director retry from applying injury twice. */
  impact?: {
    segmentIndex: number;
    targetId: string;
    effect: 'harm' | 'blocked' | 'unconscious' | 'death' | 'recover' | 'revive';
    damage: number;
    lifeStateBefore?: 'conscious' | 'unconscious' | 'dead';
    lifeStateAfter?: 'conscious' | 'unconscious' | 'dead';
    vitalityBefore?: number;
    vitalityAfter?: number;
  };
}
export interface NarrativeCanon {
  revision: number;
  turns: ConfirmedNarrativeTurn[];
}
export const narrativePublicTurnSchema = z
  .object({
    id: z.string().uuid(),
    tick: z.number().int().nonnegative(),
    narration: copy(2000),
    channel: z.enum(['say', 'whisper']).optional(),
  })
  .strict();
export type NarrativePublicTurn = z.infer<typeof narrativePublicTurnSchema>;
