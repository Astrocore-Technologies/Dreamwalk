import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/)
  .refine((v) => !(v in Object.prototype));
const counter = z.number().int().nonnegative().safe();
/** A small Dreamwalk preset, not an implementation of a D&D edition. */
export const turnRulesSchema = z
  .object({
    id: z.literal('dreamwalk-base').default('dreamwalk-base'),
    version: z.literal(1).default(1),
    movement: z.number().int().min(1).max(32).default(6),
    main: z.number().int().min(1).max(3).default(1),
    additional: z.number().int().min(0).max(3).default(1),
    reaction: z.number().int().min(0).max(2).default(1),
    vitality: z.number().int().min(1).max(100).default(6),
    hitDamage: z.number().int().min(1).max(20).default(1),
    pushDistance: z.number().int().min(1).max(2).default(1),
    maxReactionDepth: z.number().int().min(1).max(2).default(1),
    maxWorldActions: z.number().int().min(1).max(32).default(16),
    maxNpcActions: z.number().int().min(1).max(3).default(1),
    maxQueuedSpeech: z.number().int().min(1).max(16).default(8),
  })
  .strict();
export type TurnRules = z.infer<typeof turnRulesSchema>;
export const turnFenceSchema = z
  .object({
    roundId: id,
    phaseEpoch: counter,
    rulesetVersion: z.literal(1),
  })
  .strict();
export type TurnFence = z.infer<typeof turnFenceSchema>;
export const turnResourcesSchema = z
  .object({
    movement: counter,
    main: counter,
    additional: counter,
    reaction: counter,
  })
  .strict();
export type TurnResources = z.infer<typeof turnResourcesSchema>;
export const deferredTurnSpeechSchema = z
  .object({
    id: z.string().min(1).max(200),
    recipientId: id,
    utteranceId: z.string().min(1).max(240),
    channel: z.enum(['say', 'whisper']),
    audienceIds: z.array(id).min(2),
  })
  .strict();
export type DeferredTurnSpeechInput = z.infer<typeof deferredTurnSpeechSchema>;
export type DeferredTurnSpeech = DeferredTurnSpeechInput & {
  /** Server-only dependency, not an admitted utterance or NPC memory. */
  pendingStoryTurnId?: string;
  actorId: string;
  sequence: number;
  roundId: string;
  phaseEpoch: number;
};
export type TurnPendingResolution = {
  id: string;
  actorId: string;
  action: { kind: 'hit' | 'push'; targetId: string };
  actorRevision: number;
  targetRevision: number;
};
export type TurnReaction = {
  id: string;
  reactorId: string;
  causeActorId: string;
  depth: number;
  resumePhase: 'player' | 'world';
  resumeActorId: string | null;
};
export interface TurnController {
  version: 1;
  ruleset: TurnRules;
  roundId: string;
  roundNumber: number;
  phase: 'player' | 'reaction' | 'world';
  phaseEpoch: number;
  activeActorId: string | null;
  actorOrder: string[];
  actorIndex: number;
  resources: Record<string, TurnResources>;
  deferredSpeech: DeferredTurnSpeech[];
  nextSpeechSequence: number;
  pendingResolution?: TurnPendingResolution;
  reaction?: TurnReaction;
  /** Frozen server-admitted current-map NPC roster for this world phase. */
  worldActorIds?: string[];
  worldActions: number;
  worldNpcActions: Record<string, number>;
}
/** Private utterance references and other players' resource sheets never leave the server. */
export const turnProjectionSchema = z
  .object({
    version: z.literal(1),
    ruleset: turnRulesSchema,
    roundId: id,
    roundNumber: z.number().int().positive().safe(),
    phase: z.enum(['player', 'reaction', 'world']),
    phaseEpoch: counter,
    activeActorId: id.nullable(),
    actorOrder: z.array(id).max(4),
    resources: turnResourcesSchema,
    ownTurn: z.boolean(),
    pendingResolution: z.boolean(),
    pendingNpcReplies: z.array(
      z.object({ npcId: id, count: z.number().int().positive().max(64) }).strict(),
    ),
    reaction: z
      .object({
        id: z.string().max(200),
        reactorId: id,
        causeActorId: id,
        depth: z.number().int().positive().max(2),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TurnProjection = z.infer<typeof turnProjectionSchema>;
export const movementTraceSchema = z
  .object({
    sequence: counter,
    points: z
      .array(
        z
          .object({ x: z.number().int().min(0).max(63), y: z.number().int().min(0).max(63) })
          .strict(),
      )
      .min(1)
      .max(33),
  })
  .strict();
export const actorFeedbackSchema = z
  .object({
    kind: z.enum(['hit', 'push']),
    sequence: counter,
    dx: z.number().int().min(-1).max(1),
    dy: z.number().int().min(-1).max(1),
  })
  .strict();
