import { z } from 'zod';
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/)
  .refine((v) => !Object.prototype.hasOwnProperty.call(Object.prototype, v));
const copy = (max: number) => z.string().trim().min(1).max(max);
export const narrativePremiseSchema = z
  .object({
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
    personalitySummary: copy(500),
    values: z
      .array(z.enum(['duty', 'kindness', 'caution', 'honesty']))
      .min(1)
      .max(4),
    publicSpeechStyle: z.enum(['neutral', 'warm', 'formal', 'terse', 'wry']),
    goal: z.enum(['patrol', 'help']),
    placement: z.enum(['current', 'new_scene']),
    spawn: z
      .object({ x: z.number().int().min(0).max(63), y: z.number().int().min(0).max(63) })
      .strict(),
    knownEntityIds: z.array(id).max(8),
  })
  .strict();
export const narrativeSceneSchema = z
  .object({
    name: copy(120),
    description: copy(1000),
    template: z.enum(['room', 'courtyard']),
    connection: z
      .object({
        fromMapId: id,
        x: z.number().int().min(0).max(63),
        y: z.number().int().min(0).max(63),
      })
      .strict(),
  })
  .strict();
export const narrativeActionSchema = z
  .object({
    kind: z.enum(['inspect', 'open', 'close', 'unlock', 'pick_up', 'give', 'transition', 'wait']),
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
  sceneId?: string;
  npcId?: string;
  evidenceIds: string[];
  introducedScene?: { id: string; name: string; description: string };
  introducedNpc?: { id: string; name: string; roleLabel: string };
}
export interface NarrativeCanon {
  revision: number;
  turns: ConfirmedNarrativeTurn[];
}
export const narrativePublicTurnSchema = z
  .object({ id: z.string().uuid(), tick: z.number().int().nonnegative(), narration: copy(2000) })
  .strict();
export type NarrativePublicTurn = z.infer<typeof narrativePublicTurnSchema>;
