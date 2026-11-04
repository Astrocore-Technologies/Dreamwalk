import { z } from 'zod';
/** Authored fictional roleplay state, never a model reasoning trace or mechanical fact. */
export const npcCognitionSchema = z
  .object({
    motive: z.string().trim().min(1).max(240),
    belief: z.string().trim().min(1).max(240),
    intent: z.string().trim().min(1).max(240),
    innerThought: z.string().trim().min(1).max(480),
    reconsiderAfterRounds: z.number().int().min(1).max(3).default(1),
  })
  .strict();
export type NpcCognition = z.infer<typeof npcCognitionSchema>;
export type NpcCognitionState = NpcCognition & {
  /** Server-stamped reader ACL; absent means no player disclosure. */
  audienceIds?: string[];
  /** Private authored inputs require current source-author access as well as the actor ACL. */
  requiresSourceAuthor?: boolean;
  tick: number;
  knowledgeRevision: number;
  roundId?: string;
  roundNumber?: number;
  sourceObservationId?: string;
};
/** Opt-in authored behavior version. Free prose stays in private decision context. */
export const npcCharacterizationSchema = z
  .object({
    version: z.literal(1),
    motives: z
      .array(
        z
          .object({
            kind: z.enum(['protect', 'belong', 'discover', 'prosper', 'duty', 'care']),
            priority: z.number().int().min(1).max(5),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    reactions: z
      .array(
        z
          .object({
            trigger: z.enum(['threat', 'help', 'betrayal', 'request', 'uncertainty']),
            response: z.enum(['observe', 'assist', 'warn', 'withdraw', 'refuse']),
            publicStance: z.enum(['reserved', 'friendly', 'firm', 'guarded']),
          })
          .strict(),
      )
      .max(5),
    publicVoice: z
      .object({
        cadence: z.enum(['brief', 'balanced', 'elaborate']),
        register: z.enum(['plain', 'formal', 'colloquial']),
        humor: z.enum(['none', 'dry', 'playful']),
      })
      .strict(),
    dialogueExamples: z
      .array(
        z
          .object({
            situation: z.enum(['greeting', 'thanks', 'refusal', 'danger']),
            text: z.string().trim().min(1).max(240),
          })
          .strict(),
      )
      .max(4),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.motives.map((m) => m.kind)).size !== value.motives.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate motive', path: ['motives'] });
    if (new Set(value.reactions.map((r) => r.trigger)).size !== value.reactions.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate reaction trigger', path: ['reactions'] });
  });
export type NpcCharacterization = z.infer<typeof npcCharacterizationSchema>;
/** Server-private cognition. Never serialize this structure as a player projection. */
export const npcPersonalitySchema = z
  .object({
    role: z.enum(['guard', 'helper', 'patrol']),
    behaviorProfile: z.enum(['green-apple', 'cookie']).optional(),
    values: z
      .array(z.enum(['duty', 'kindness', 'caution', 'honesty']))
      .min(1)
      .max(4),
    taboos: z
      .array(
        z.enum([
          'steal',
          'harm',
          'disclose_private',
          'share_rumors',
          'give_valuables',
          'lock_doors',
        ]),
      )
      .max(6),
    speechStyle: z.string().trim().max(200),
    publicSpeechStyle: z.enum(['neutral', 'warm', 'formal', 'terse', 'wry']).optional(),
    characterization: npcCharacterizationSchema.optional(),
    biography: z.string().trim().max(2000).optional(),
    habits: z
      .array(z.enum(['observe_before_acting', 'keep_promises', 'share_warnings']))
      .max(3)
      .optional(),
    decisionExamples: z
      .array(
        z
          .object({
            situation: z.string().trim().min(1).max(240),
            response: z.string().trim().min(1).max(240),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    links: z
      .array(
        z
          .object({
            npcId: z.string().min(1).max(100),
            relation: z.enum(['ally', 'rival', 'mentor']),
          })
          .strict(),
      )
      .max(4)
      .optional(),
  })
  .strict();
export type NpcPersonality = z.infer<typeof npcPersonalitySchema>;
export type NpcObservationKind =
  | 'harmed'
  | 'pushed'
  | 'item_placed'
  | 'item_given'
  | 'item_consumed'
  | 'item_taken'
  | 'item_missing'
  | 'actor_seen'
  | 'actor_departed'
  | 'door_changed'
  | 'noise'
  | 'addressed'
  | 'helped'
  | 'claim'
  | 'known_entity'
  | 'authored_fact'
  | 'said'
  | 'attempted';
export interface NpcObservation {
  id: string;
  eventId: string;
  rootId: string;
  kind: NpcObservationKind;
  tick: number;
  mapId: string;
  point?: { x: number; y: number };
  channel: 'direct' | 'heard' | 'report';
  confidence: 'witnessed' | 'uncertain' | 'reported';
  actorId?: string;
  targetId?: string;
  sourceNpcId?: string;
  addressedNpcId?: string;
  /** Server-created durable story turn provenance; never accepted from speech input. */
  speechIdentity?: { turnId: string; segmentIndex: number };
  depth: number;
  disclosure: 'public' | 'participants' | 'private';
  audienceIds: string[];
  revealCondition?: 'never' | 'asked' | 'trusted';
  text?: string;
  factId?: string;
  title?: string;
  definitionText?: string;
  publicQuestion?: string;
  relevanceTopics?: string[];
  relevanceMapId?: string;
}
export interface NpcBelief {
  id: string;
  subjectId?: string;
  targetId?: string;
  predicate: 'item_missing' | 'took_item' | 'heard_noise' | 'needs_help';
  confidence: 'certain' | 'uncertain' | 'reported';
  evidenceIds: string[];
  status: 'active' | 'disputed';
  revision: number;
  reason?: 'direct_evidence' | 'reported_claim' | 'contradiction';
}
export interface NpcRelationship {
  trust: number;
  alertness: number;
  debt: number;
  evidenceIds: string[];
  /** Present only for opt-in characterization; never a player HUD projection. */
  character?: {
    affinity: number;
    respect: number;
    fear: number;
    lastChangedTick: number;
    stage: 'hostile' | 'wary' | 'neutral' | 'cooperative' | 'trusted';
  };
}
export interface NpcObligation {
  id: string;
  toActorId: string;
  itemId?: string;
  promisedAction?: NpcPromisedAction;
  createdTick: number;
  dueTick: number;
  status: 'proposed' | 'accepted' | 'fulfilled' | 'broken' | 'cancelled';
  conditions?: NpcCondition[];
  acceptedTick?: number;
  templateId?: string;
  evidenceIds: string[];
  resolutionEventId?: string;
  sourceUtteranceId?: string;
  sourceUtterance?: string;
  alternativeGoalId?: string;
  alternativeHandled?: boolean;
}
export interface NpcMemorySummary {
  policyVersion: 1;
  modelVersion: 'grounded-summary-v1';
  coveredEventRange: { firstEventId: string; lastEventId: string } | null;
  revision: number;
  knowledgeRevision: number;
  inputFingerprint: string;
  observationIds: string[];
  narrative?: string;
  claims: { observationId: string; kind: NpcObservationKind }[];
}
export interface LivingNpcMemory {
  /** Server-private first mechanical opportunity for an already admitted commitment. */
  continuationOpportunity?: { key: string; roundId: string };
  /** Server-private authored RP. Exposed only by a separately authorized reader. */
  cognition?: NpcCognitionState;
  lastActionOutcome?: {
    actionKind: string;
    status: 'completed' | 'progressed' | 'blocked';
    code?: string;
    tick: number;
    roundId?: string;
  };
  /** Server-only, evidence-backed mechanics; never project private NPC memory. */
  companionship?: {
    actorId: string;
    sourceObservationId: string;
    utteranceId: string;
    crossings: { mapId: string; exitId: string; destinationMapId: string }[];
  };
  policyVersion: 1;
  personality: NpcPersonality;
  knowledgeRevision: number;
  rememberedItems?: Record<string, { mapId: string; x: number; y: number; present: boolean }>;
  observations: NpcObservation[];
  beliefs: NpcBelief[];
  relationships: Record<string, NpcRelationship>;
  obligations: NpcObligation[];
  causes: { id: string; observationId: string; priority: number; notBeforeTick: number }[];
  processedCauses: string[];
  nextRoutineTick: number;
  distractedUntilTick: number;
  goal: {
    kind: 'patrol' | 'investigate' | 'assist' | 'warn';
    revision: number;
    evidenceIds: string[];
    targetId?: string;
  };
  summary?: NpcMemorySummary;
  affect?: NpcAffect;
  goalPolicy?: NpcGoalPolicy;
  goalDefinitions?: NpcGoalDefinition[];
  goalOutcomes?: Record<string, { status: 'succeeded' | 'cancelled' | 'blocked'; tick: number }>;
  promiseTemplates?: NpcPromiseTemplate[];
  offeredCauseIds?: string[];
}
export const npcNoticeSchema = z
  .object({
    id: z.string().min(1).max(100),
    npcId: z.string().min(1).max(100),
    kind: z.enum([
      'investigating',
      'warned',
      'promised',
      'fulfilled',
      'promise_broken',
      'patrolling',
      'door_closed',
      'distracted',
      'heard',
      'promise_offered',
      'promise_cancelled',
      'resting',
    ]),
    tick: z.number().int().nonnegative(),
  })
  .strict();
export type NpcNotice = z.infer<typeof npcNoticeSchema>;
export interface PrivateNpcNotice extends NpcNotice {
  mapId: string;
  audienceIds: string[];
}
export const npcSpeechSchema = z
  .object({
    replyLocale: z.enum(['uk', 'en', 'ru']).optional(),
    channel: z.enum(['say', 'whisper']),
    text: z.string().trim().min(1).max(1000).optional(),
    claim: z
      .object({
        kind: z.literal('item_taken'),
        actorId: z.string().min(1).max(100),
        targetId: z.string().min(1).max(100),
      })
      .strict()
      .optional(),
  })
  .strict();

export const npcUtteranceSchema = z
  .object({
    id: z.string().max(100),
    speakerId: z.string().max(100).optional(),
    tick: z.number().int().nonnegative(),
    text: z.string().max(1000).optional(),
    code: z.enum(['acknowledged']).optional(),
  })
  .strict();
export type NpcUtterance = z.infer<typeof npcUtteranceSchema>;
export interface PrivateNpcUtterance extends NpcUtterance {
  presentationKind?: 'attempt';
  sourceObservationIds?: string[];
  mapId: string;
  audienceIds: string[];
  speakerKnownToIds: string[];
}

const livingId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
// Generated story NPC entity IDs are source UUIDs; authored goal/item IDs stay bounded.
const livingEntityReference = z.union([livingId, z.uuid()]);
export const npcConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('always') }).strict(),
  z
    .object({
      kind: z.literal('observed'),
      event: z.enum([
        'item_taken',
        'item_missing',
        'noise',
        'helped',
        'addressed',
        'said',
        'actor_seen',
        'actor_departed',
      ]),
      targetId: livingEntityReference.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('near_entity'), entityId: livingEntityReference }).strict(),
  z.object({ kind: z.literal('owns_item'), itemId: livingId }).strict(),
  z.object({ kind: z.literal('recipient_near') }).strict(),
  z
    .object({ kind: z.literal('trust_at_least'), minimum: z.number().int().min(-5).max(5) })
    .strict(),
  z.object({ kind: z.literal('elapsed'), ticks: z.number().int().min(0).max(12000) }).strict(),
]);
export type NpcCondition = z.infer<typeof npcConditionSchema>;
export const npcAuthoredFactSchema = z
  .object({
    id: livingId,
    title: z.string().trim().min(1).max(120),
    text: z.string().trim().min(1).max(1000),
    disclosure: z.enum(['never', 'asked', 'trusted', 'public']),
    topicEntityId: livingEntityReference.optional(),
    publicQuestion: z.string().trim().min(1).max(120).optional(),
    relevanceTopics: z.array(z.string().trim().min(1).max(40)).max(6).optional(),
    relevanceMapId: z
      .string()
      .regex(/^[\w-]{1,100}$/)
      .refine((id) => !Object.prototype.hasOwnProperty.call(Object.prototype, id))
      .optional(),
  })
  .strict();
export const npcGoalDefinitionSchema = z
  .object({
    id: livingId,
    kind: z.enum(['patrol', 'guard', 'investigate', 'assist']),
    itemId: livingId.optional(),
    targetId: livingEntityReference.optional(),
    priority: z.number().int().min(1).max(5),
    motivation: z.enum(['duty', 'kindness', 'curiosity', 'routine']),
    when: z.array(npcConditionSchema).max(4),
    success: z.array(npcConditionSchema).max(4),
    cancelWhen: z.array(npcConditionSchema).max(4),
    holdTicks: z.number().int().min(0).max(200),
    risk: z.enum(['cautious', 'balanced', 'bold']).optional(),
    fallbackGoalId: livingId.optional(),
  })
  .strict();
export type NpcGoalDefinition = z.infer<typeof npcGoalDefinitionSchema>;
export const npcPromisedActionSchema = z
  .object({ kind: z.enum(['open', 'inspect']), targetId: livingEntityReference })
  .strict();
export type NpcPromisedAction = z.infer<typeof npcPromisedActionSchema>;
export const npcPromiseTemplateSchema = z
  .object({
    id: livingId,
    itemId: livingId.optional(),
    promisedAction: npcPromisedActionSchema.optional(),
    offerOn: z.enum(['addressed', 'helped']),
    conditions: z.array(npcConditionSchema).max(4),
    dueTicks: z.number().int().min(1).max(12000),
    requiresAcceptance: z.boolean(),
    alternativeGoalId: livingId.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.itemId) !== Boolean(v.promisedAction), {
    message: 'Choose one promised item or action',
  });
export type NpcPromiseTemplate = z.infer<typeof npcPromiseTemplateSchema>;
export interface NpcAffect {
  fatigue: number;
  attention: number;
  alertness: number;
  mood: 'calm' | 'curious' | 'alarmed' | 'grateful';
  lastUpdatedTick: number;
  /** Characterized mood holds use game ticks, never a paid/background timer. */
  moodUntilTick?: number;
}
export interface NpcGoalPolicy {
  motivation: 'duty' | 'kindness' | 'curiosity' | 'promise' | 'routine';
  priority: number;
  startedTick: number;
  holdUntilTick: number;
  success: NpcCondition[];
  cancelWhen: NpcCondition[];
  definitionId?: string;
  risk?: 'cautious' | 'balanced' | 'bold';
  replans?: number;
  goalRevision?: number;
  status: 'active' | 'succeeded' | 'cancelled' | 'blocked';
}

export const npcBeliefRevisionSchema = z
  .object({
    beliefId: z.string().min(1).max(160).optional(),
    expectedRevision: z.number().int().nonnegative(),
    predicate: z.enum(['item_missing', 'took_item', 'heard_noise', 'needs_help']),
    subjectId: z.string().min(1).max(100).optional(),
    targetId: z.string().min(1).max(100).optional(),
    evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(8),
    confidence: z.enum(['certain', 'uncertain', 'reported']),
    status: z.enum(['active', 'disputed']),
    reason: z.enum(['direct_evidence', 'reported_claim', 'contradiction']),
  })
  .strict();
export type NpcBeliefRevision = z.infer<typeof npcBeliefRevisionSchema>;
