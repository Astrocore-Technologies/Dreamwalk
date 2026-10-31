import { z } from 'zod';
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/)
  .refine((v) => !Object.prototype.hasOwnProperty.call(Object.prototype, v));
const copy = (max: number) => z.string().trim().min(1).max(max);
const value = z.enum(['duty', 'kindness', 'caution', 'honesty']);
const style = z.enum(['neutral', 'warm', 'formal', 'terse', 'wry']);
const goal = z.enum(['patrol', 'help']);
export const supportingNpcRoleSchema = z
  .object({
    id,
    needObjectiveId: id.optional(),
    label: copy(120),
    description: copy(1000),
    mapIds: z.array(id).min(1).max(4),
    operationalRole: z.enum(['guard', 'helper', 'patrol']),
    allowedValues: z.array(value).min(1).max(4),
    allowedGoals: z.array(goal).min(1).max(2),
    allowedSpeechStyles: z.array(style).min(1).max(5),
  })
  .strict();
export const supportingNpcPolicySchema = z
  .object({
    version: z.literal(1),
    maxSpawned: z.number().int().min(1).max(8).default(4),
    roles: z.array(supportingNpcRoleSchema).min(1).max(4),
  })
  .strict()
  .refine(
    (p) => new Set(p.roles.map((r) => r.id)).size === p.roles.length,
    'Duplicate supporting role',
  );
export type SupportingNpcPolicy = z.infer<typeof supportingNpcPolicySchema>;
/** Flavor copy is untrusted narrative, never a world fact or authority grant. */
export const supportingNpcCardSchema = z
  .object({
    generated: z.literal(true),
    roleId: id,
    roleLabel: copy(120),
    description: copy(1000),
    appearance: copy(500),
    personalitySummary: copy(500),
  })
  .strict();
export type SupportingNpcCard = z.infer<typeof supportingNpcCardSchema>;
export const supportingNpcProposalSchema = z
  .object({
    proposalId: z.string().uuid(),
    contextHash: copy(160),
    roleId: id,
    name: copy(80),
    appearance: copy(500),
    personalitySummary: copy(500),
    values: z.array(value).min(1).max(4),
    publicSpeechStyle: style,
    goal,
    spawn: z
      .object({ mapId: id, x: z.number().int().min(0).max(63), y: z.number().int().min(0).max(63) })
      .strict(),
    knownEntityIds: z.array(id).max(8),
  })
  .strict();
export type SupportingNpcProposal = z.infer<typeof supportingNpcProposalSchema>;
