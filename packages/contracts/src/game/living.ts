import { z } from 'zod';
/** Server-private cognition. Never serialize this structure as a player projection. */
export const npcPersonalitySchema = z
  .object({
    role: z.enum(['guard', 'helper', 'patrol']),
    values: z
      .array(z.enum(['duty', 'kindness', 'caution', 'honesty']))
      .min(1)
      .max(4),
    taboos: z.array(z.enum(['steal', 'harm', 'disclose_private'])).max(3),
    speechStyle: z.string().trim().max(200),
    publicSpeechStyle: z.enum(['neutral', 'warm', 'formal', 'terse', 'wry']).optional(),
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
  | 'item_taken'
  | 'item_missing'
  | 'door_changed'
  | 'noise'
  | 'addressed'
  | 'helped'
  | 'claim'
  | 'known_entity'
  | 'said';
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
  depth: number;
  disclosure: 'public' | 'participants' | 'private';
  audienceIds: string[];
  revealCondition?: 'never' | 'asked' | 'trusted';
  text?: string;
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
}
export interface NpcRelationship {
  trust: number;
  alertness: number;
  debt: number;
  evidenceIds: string[];
}
export interface NpcObligation {
  id: string;
  toActorId: string;
  itemId: string;
  createdTick: number;
  dueTick: number;
  status: 'accepted' | 'fulfilled' | 'broken' | 'cancelled';
  evidenceIds: string[];
  resolutionEventId?: string;
}
export interface NpcMemorySummary {
  policyVersion: 1;
  modelVersion: 'grounded-summary-v1';
  coveredEventRange: { firstEventId: string; lastEventId: string } | null;
  revision: number;
  knowledgeRevision: number;
  inputFingerprint: string;
  observationIds: string[];
  claims: { observationId: string; kind: NpcObservationKind }[];
}
export interface LivingNpcMemory {
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
  sourceObservationIds?: string[];
  mapId: string;
  audienceIds: string[];
  speakerKnownToIds: string[];
}
