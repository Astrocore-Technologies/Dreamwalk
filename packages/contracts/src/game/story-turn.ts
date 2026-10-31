import { z } from 'zod';
import { narrativeActionSchema, narrativeSceneSchema, narrativeNpcSchema } from './narrative';
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/);
export const storyTurnInputSchema = z
  .object({
    operationId: z.uuid(),
    text: z.string().trim().min(1).max(1000),
    channel: z.enum(['say', 'whisper']),
    targetNpcId: id.optional(),
    expectedCanonRevision: z.number().int().nonnegative(),
  })
  .strict();
export type StoryTurnInput = z.infer<typeof storyTurnInputSchema>;
export const storySegmentSchema = z
  .object({
    index: z.number().int().min(0).max(5),
    kind: z.enum(['attempt', 'speech']),
    text: z.string().min(1).max(1000),
  })
  .strict();
export type StorySegment = z.infer<typeof storySegmentSchema>;
export type StoryTurnMode = 'npc' | 'director';
export const storyClarificationSchema = z.enum([
  'AMBIGUOUS',
  'UNSUPPORTED',
  'WALK_FIRST',
  'CLEAR_TARGET_TO_CONTINUE_STORY',
  'PRIVATE_STORY_EXTENSION',
  'INVALID_MARKUP',
  'TOO_MANY_SEGMENTS',
]);
export const storyTurnProposalSchema = z
  .object({
    turnId: z.uuid(),
    contextHash: z.string().min(1).max(160),
    status: z.enum(['ready', 'clarification']),
    code: storyClarificationSchema.nullable(),
    steps: z
      .array(
        z
          .object({
            segmentIndex: z.number().int().min(0).max(5),
            action: narrativeActionSchema.nullable(),
            reply: z
              .union([
                z.object({ text: z.string().trim().min(1).max(1000) }).strict(),
                z.object({ code: z.literal('acknowledged') }).strict(),
              ])
              .nullable(),
          })
          .strict(),
      )
      .max(6),
    narrative: z
      .object({
        narration: z.string().trim().min(1).max(2000),
        newScene: narrativeSceneSchema.nullable(),
        newNpc: narrativeNpcSchema.nullable(),
        evidenceIds: z.array(id).max(8),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type StoryTurnProposal = z.infer<typeof storyTurnProposalSchema>;
export type StoryActionPreview = {
  segmentIndex: number;
  action: z.infer<typeof narrativeActionSchema>;
};
export interface StoryQuote {
  id: string;
  credits: number;
  expiresAt: string;
  demo: boolean;
  requiresConsent: boolean;
  providerUpperMicros: number;
  provider: string;
  external: boolean;
  policyVersion: string;
}
export interface StoryTurnQuoteResponse {
  status: 'quoted' | 'clarification';
  operationId: string;
  turnId?: string;
  code?: string;
  mode: StoryTurnMode;
  segments: StorySegment[];
  actionPreview: StoryActionPreview[];
  confirmationHash?: string;
  quote?: StoryQuote;
}
export const storyTurnSubmitSchema = storyTurnInputSchema
  .extend({
    turnId: z.uuid(),
    quoteId: z.uuid(),
    consent: z.literal(true),
    confirmedActionHash: z.string().max(160).optional(),
  })
  .strict();
export type StoryTurnSubmit = z.infer<typeof storyTurnSubmitSchema>;
export const storyTurnConfirmSchema = z
  .object({
    operationId: z.uuid(),
    decision: z.enum(['accept', 'decline']),
    proposalHash: z.string().min(1).max(160),
  })
  .strict();
export type StoryTurnConfirm = z.infer<typeof storyTurnConfirmSchema>;
export interface StoryTurnReceipt {
  id: string;
  operationId: string;
  status:
    | 'quoted'
    | 'queued'
    | 'awaiting_confirmation'
    | 'committed'
    | 'clarification'
    | 'stale'
    | 'failed'
    | 'declined';
  channel: 'say' | 'whisper';
  targetNpcId?: string;
  inputText: string;
  createdAt: string;
  code?: string;
  jobStatus?: string;
  proposalHash?: string;
  actions?: StoryActionPreview[];
  confirmationExpiresTick?: number;
  sceneId?: string;
  npcId?: string;
  generationCost: number | null;
  confirmationCost: 0;
}
export interface StoryFeedEntry {
  id: string;
  turnId?: string;
  sequence: number | null;
  ordinal: number;
  tick: number;
  createdAt: string | null;
  kind: 'attempt' | 'speech' | 'npc_reply' | 'narration' | 'outcome';
  channel: 'say' | 'whisper';
  authorId?: string;
  authorLabel?: string;
  text?: string;
  code?: string;
  action?: z.infer<typeof narrativeActionSchema>;
  legacy?: boolean;
}
export interface StoryTurnFeed {
  canonRevision: number;
  canSubmit: boolean;
  unavailableReason?: string | null;
  configuration: {
    provider: string;
    enabled: boolean;
    externalCallsEnabled: boolean;
    demo: boolean;
    creditPrice: number;
    providerUpperMicros: number;
  };
  entries: StoryFeedEntry[];
  turns: StoryTurnReceipt[];
}
