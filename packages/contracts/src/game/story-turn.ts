import type { CurrencyFunding } from '../sparks';
import { turnFenceSchema } from './turns';
import { z } from 'zod';
import type { GameError } from './index';
import { npcCompanionIntentSchema, npcActionIntentSchema } from './world-items';
import { narrativeActionSchema, narrativeSceneSchema, narrativeNpcSchema } from './narrative';
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/);
export const storyTurnInputSchema = z
  .object({
    turnFence: turnFenceSchema.optional(),
    replyLocale: z.enum(['uk', 'en', 'ru']).optional(),
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
export const storyActionSchema = narrativeActionSchema.extend({
  kind: z.enum([...narrativeActionSchema.shape.kind.options, 'approach', 'move_to']),
  target: z
    .object({ x: z.number().int().min(0).max(63), y: z.number().int().min(0).max(63) })
    .strict()
    .optional(),
});
/** Semantic interpretation of the player's current departure, never an already completed journey. */
export const storyTravelIntentSchema = z
  .object({
    segmentIndex: z.number().int().min(0).max(5),
    destinationName: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .regex(/^[^<>\p{Cc}\p{Cf}]+$/u)
      .regex(/[\p{L}\p{N}]/u),
    description: z.string().trim().min(1).max(500),
    template: z.enum(['room', 'courtyard']),
  })
  .strict();
export type StoryTravelIntent = z.infer<typeof storyTravelIntentSchema>;
/** Semantic coauthoring result, not a weapon or an unrestricted combat command. */
export const narrativeImpactSchema = z
  .object({
    targetId: id,
    effect: z.enum(['harm', 'blocked', 'unconscious', 'death', 'recover', 'revive']),
  })
  .strict();
export type NarrativeImpact = z.infer<typeof narrativeImpactSchema>;
export const storyTurnProposalSchema = z
  .object({
    turnId: z.uuid(),
    contextHash: z.string().min(1).max(160),
    status: z.enum(['ready', 'clarification']),
    travelIntent: storyTravelIntentSchema.nullable().optional(),
    code: storyClarificationSchema.nullable(),
    steps: z
      .array(
        z
          .object({
            segmentIndex: z.number().int().min(0).max(5),
            action: storyActionSchema.nullable(),
            narrativeImpact: narrativeImpactSchema.nullable().optional(),
            sceneEncounter: z.object({ npcId: id }).strict().optional(),
            replyNpcId: id.nullable().optional(),
            replyContextHash: z.string().min(1).max(160).nullable().optional(),
            reply: z
              .union([
                z
                  .object({
                    text: z.string().trim().min(1).max(1000),
                    companionIntent: npcCompanionIntentSchema.optional(),
                    actionIntent: npcActionIntentSchema.optional(),
                  })
                  .strict(),
                z.object({ code: z.literal('acknowledged') }).strict(),
              ])
              .nullable(),
          })
          .strict()
          .superRefine((step, ctx) => {
            if (
              step.sceneEncounter &&
              (step.action ||
                step.narrativeImpact ||
                step.reply ||
                step.replyNpcId ||
                step.replyContextHash)
            )
              ctx.addIssue({
                code: 'custom',
                message: 'Scene encounter cannot be combined with another step effect',
              });
          }),
      )
      .max(6),
    narrative: z
      .object({
        narration: z.string().trim().min(1).max(2000),
        newScene: narrativeSceneSchema.nullable(),
        newNpc: narrativeNpcSchema.nullable(),
        newItem: z
          .object({
            name: z
              .string()
              .trim()
              .min(2)
              .max(120)
              .regex(/^[^<>\p{Cc}\p{Cf}]+$/u),
            description: z.string().trim().min(1).max(500),
          })
          .strict()
          .nullable()
          .optional(),
        evidenceIds: z.array(id).max(8),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type StoryTurnProposal = z.infer<typeof storyTurnProposalSchema>;
export type StoryActionPreview = {
  segmentIndex: number;
  targetLabel?: string;
  action: z.infer<typeof storyActionSchema>;
};
/** Server-resolved results retained for deferred narration, never executable proposals. */
export interface StoryAttackOutcome {
  segmentIndex: number;
  kind: 'hit' | 'push';
  targetId: string;
  code:
    | GameError
    | 'ACTION_SUCCEEDED'
    | 'ACTION_PENDING'
    | 'PUSH_BLOCKED'
    | 'NARRATIVE_HARM'
    | 'NARRATIVE_BLOCKED';
}
export interface StoryQuote {
  /** Current-map vision is part of this same quote, never an extra generation. */
  runtimeMapImages?: number;
  generatedLocationImages?: number;
  estimateRiskConsentRequired?: boolean;
  chargeUnit?: 'sparks' | 'credits';
  funding?: CurrencyFunding;
  sparkReservedSubunits?: string | null;
  sparkQuoteId?: string | null;
  sparkRateVersion?: string;
  id: string;
  credits: number;
  expiresAt: string;
  demo: boolean;
  requiresConsent: boolean;
  providerUpperMicros: number | null;
  providerReserveMicros?: number;
  estimatedTotalMicros?: number;
  providerEnforcesQuotedCap?: boolean;
  estimateSnapshot?: {
    schemaVersion: 1;
    costBasis: 'operator_estimate' | 'legacy_fixed';
    fingerprint: string;
    reserveMicros: number;
    estimatedTotalMicros: number;
    providerEnforcesQuotedCap: false;
  };
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
  /** Explicit location-only RP posts need no second action-confirmation dialog. */
  travel?: { destinationName: string; generationRequired: boolean };
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
    turnFence: turnFenceSchema.optional(),
    operationId: z.uuid(),
    decision: z.enum(['accept', 'decline']),
    proposalHash: z.string().min(1).max(160),
  })
  .strict();
export type StoryTurnConfirm = z.infer<typeof storyTurnConfirmSchema>;
export interface StoryTurnReceipt {
  travel?: {
    destinationName: string;
    status: 'prepared' | 'accepted' | 'committed' | 'failed' | 'declined';
    imageStatus?: string;
    sparkStatus?: 'held' | 'pending' | 'settled' | 'released';
    funding?: CurrencyFunding;
    sparkReservedSubunits?: string;
    sparkCapturedSubunits?: string | null;
  };
  generationNeedsConfirmation?: boolean;
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
  sparkStatus?: 'held' | 'pending' | 'settled' | 'released';
  funding?: CurrencyFunding;
  sparkReservedSubunits?: string;
  sparkCapturedSubunits?: string | null;
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
  action?: z.infer<typeof storyActionSchema>;
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
