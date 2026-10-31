import {
  narrativeConstraintsSchema,
  narrativePublicTurnSchema,
  type NarrativeConstraints,
  type NarrativePremise,
  type NarrativeCanon,
  type NarrativePublicTurn,
} from './narrative';
export * from './narrative';
import {
  supportingNpcPolicySchema,
  supportingNpcCardSchema,
  type SupportingNpcPolicy,
  type SupportingNpcCard,
} from './supporting';
export * from './supporting';
import { frozenArtBindingsSchema, type FrozenArtBinding } from './art';
export * from './art';
import {
  npcPersonalitySchema,
  npcNoticeSchema,
  npcUtteranceSchema,
  npcAuthoredFactSchema,
  npcGoalDefinitionSchema,
  npcPromiseTemplateSchema,
  npcBeliefRevisionSchema,
  npcPromisedActionSchema,
} from './living';
import type {
  LivingNpcMemory,
  NpcNotice,
  PrivateNpcNotice,
  NpcUtterance,
  PrivateNpcUtterance,
} from './living';
export * from './living';
import { z } from 'zod';
export const bundledGameAssetManifest = {
  id: 'observatory-prototype-atlas-v1',
  sha256: 'dbfdb127d64aabc022b094d261ecb3825a1760e4301e3f2abeb73f9cd0c47886',
} as const;
export const gameAssetManifestSchema = z
  .object({
    id: z.literal(bundledGameAssetManifest.id),
    sha256: z.literal(bundledGameAssetManifest.sha256),
  })
  .strict();

export const gameIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/)
  .refine(
    (id) => !Object.prototype.hasOwnProperty.call(Object.prototype, id),
    'Reserved identifier',
  );
export const gamePointSchema = z
  .object({ x: z.number().int().min(0).max(63), y: z.number().int().min(0).max(63) })
  .strict();
export const gameActionSchema = z
  .object({
    kind: z.enum([
      'move_to',
      'wait',
      'inspect',
      'talk',
      'distract',
      'pick_up',
      'give',
      'unlock',
      'open',
      'close',
      'lock',
      'knock',
      'communicate',
      'transition',
      'defend',
      'flee',
    ]),
    targetId: gameIdSchema.optional(),
    itemId: gameIdSchema.optional(),
    target: gamePointSchema.optional(),
    channel: z.enum(['say', 'whisper']).optional(),
    observationIds: z.array(z.string().min(1).max(200)).min(1).max(4).optional(),
  })
  .strict()
  .superRefine((action, ctx) => {
    if (action.kind === 'communicate') {
      if (
        !action.channel ||
        !action.observationIds ||
        new Set(action.observationIds).size !== action.observationIds.length
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Communication requires channel and unique observation references',
        });
    } else if (action.channel !== undefined || action.observationIds !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Only communicate accepts speech references' });
    const noTarget = ['wait', 'defend', 'flee'].includes(action.kind);
    if (
      noTarget &&
      (action.targetId !== undefined || action.itemId !== undefined || action.target !== undefined)
    )
      ctx.addIssue({ code: 'custom', message: 'Action accepts no target' });
    if (action.kind === 'move_to') {
      if (!action.target || action.targetId !== undefined || action.itemId !== undefined)
        ctx.addIssue({ code: 'custom', message: 'Movement requires only a target point' });
    } else if (!noTarget) {
      if (!action.targetId || action.target !== undefined)
        ctx.addIssue({ code: 'custom', message: 'Action requires an entity or exit target' });
      if (action.kind === 'give' && !action.itemId)
        ctx.addIssue({ code: 'custom', message: 'Give requires an item' });
      if (!['give', 'unlock', 'lock'].includes(action.kind) && action.itemId !== undefined)
        ctx.addIssue({ code: 'custom', message: 'Action does not accept an item' });
    }
  });
export type GameAction = z.infer<typeof gameActionSchema>;
export type GamePoint = z.infer<typeof gamePointSchema>;
export const gameMoveSchema = z
  .object({
    inputSeq: z.number().int().nonnegative(),
    movementGeneration: z.number().int().nonnegative(),
    target: gamePointSchema,
  })
  .strict();
export type GameMove = z.infer<typeof gameMoveSchema>;
export const gameIntentSchema = z
  .object({
    encounterId: gameIdSchema,
    generation: z.number().int().nonnegative(),
    round: z.number().int().positive(),
    intentRevision: z.number().int().positive(),
    action: gameActionSchema,
    ready: z.boolean(),
  })
  .strict();
export type GameIntentInput = z.infer<typeof gameIntentSchema>;
export type GameError =
  | 'FORBIDDEN'
  | 'STALE_STATE'
  | 'OUT_OF_RANGE'
  | 'PATH_BLOCKED'
  | 'TARGET_UNAVAILABLE'
  | 'WRONG_MODE'
  | 'ROUND_LOCKED'
  | 'RATE_LIMITED'
  | 'INVALID_ACTION';
export const gameLabelTranslationsSchema = z
  .object({
    uk: z.string().trim().min(1).max(120).optional(),
    en: z.string().trim().min(1).max(120).optional(),
    ru: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type GameLabelTranslations = z.infer<typeof gameLabelTranslationsSchema>;
export interface GameEntity extends GamePoint {
  supportingNpc?: SupportingNpcCard;
  id: string;
  kind: 'player' | 'npc' | 'item' | 'door';
  label?: string;
  labelTranslations?: GameLabelTranslations;
  visual?: 'key' | 'token' | 'journal' | 'door' | 'keeper' | 'traveler';
  mapId: string;
  revision: number;
  ownerId?: string;
  locked?: boolean;
  open?: boolean;
  keyId?: string;
  inventory?: string[];
  movementGeneration?: number;
  lastInputSeq?: number;
  path?: GamePoint[];
  lastMoveTick?: number;
  encounterId?: string;
  knownIds?: string[];
}
export interface GameMap {
  sceneProfile?: 'observatory-interior-v1' | 'observatory-roof-v1';
  id: string;
  label?: string;
  labelTranslations?: GameLabelTranslations;
  width: number;
  height: number;
  blocked: GamePoint[];
  spawns: GamePoint[];
  exits: {
    id: string;
    x: number;
    y: number;
    label?: string;
    labelTranslations?: GameLabelTranslations;
    destinationMapId: string;
    destination: GamePoint;
    doorId?: string;
  }[];
  revision: number;
}
export interface RoundIntent {
  revision: number;
  action: GameAction;
  ready: boolean;
}
export interface GameEncounter {
  id: string;
  policy?: { maxRounds: number; planningMs: number };
  pendingJoinIds?: string[];
  endVotes?: string[];
  coordinatorId?: string;
  mapId: string;
  generation: number;
  round: number;
  phase: 'planning' | 'completed';
  participants: string[];
  area: { x: number; y: number; width: number; height: number };
  deadlineMs: number;
  intents: Record<string, RoundIntent>;
}
export const objectiveConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('party_owns_item'), itemId: gameIdSchema }).strict(),
  z.object({ kind: z.literal('door_open'), doorId: gameIdSchema }).strict(),
  z.object({ kind: z.literal('door_unlocked'), doorId: gameIdSchema }).strict(),
  z.object({ kind: z.literal('party_reaches_map'), mapId: gameIdSchema }).strict(),
]);
export type ObjectiveCondition = z.infer<typeof objectiveConditionSchema>;
const objectiveCopySchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1000),
    epilogue: z.string().trim().min(1).max(2000),
  })
  .strict();
const objectiveLocalesSchema = z
  .object({
    uk: objectiveCopySchema.optional(),
    en: objectiveCopySchema.optional(),
    ru: objectiveCopySchema.optional(),
  })
  .strict();
export const objectiveDefinitionSchema = objectiveCopySchema
  .extend({
    id: gameIdSchema,
    translations: objectiveLocalesSchema.optional(),
    completion: z
      .object({
        mode: z.enum(['all', 'any']),
        conditions: z.array(objectiveConditionSchema).min(1).max(8),
      })
      .strict(),
  })
  .strict();
export const objectiveDefinitionsSchema = z
  .array(objectiveDefinitionSchema)
  .max(8)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    'Duplicate objective ID',
  );
export type ObjectiveDefinition = z.infer<typeof objectiveDefinitionSchema>;
const publicObjectiveCopySchema = objectiveCopySchema
  .omit({ epilogue: true })
  .extend({ epilogue: z.string().max(2000).optional() })
  .strict();
export const objectiveProjectionSchema = publicObjectiveCopySchema
  .extend({
    id: gameIdSchema,
    status: z.enum(['active', 'achieved']),
    achievedTick: z.number().int().nonnegative().safe().optional(),
    translations: z
      .object({
        uk: publicObjectiveCopySchema.optional(),
        en: publicObjectiveCopySchema.optional(),
        ru: publicObjectiveCopySchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.status === 'achieved'
        ? value.achievedTick !== undefined && value.epilogue !== undefined
        : value.achievedTick === undefined &&
          value.epilogue === undefined &&
          Object.values(value.translations ?? {}).every((copy) => copy.epilogue === undefined),
    'Invalid objective progress projection',
  );
export type ObjectiveProjection = z.infer<typeof objectiveProjectionSchema>;

export interface GameState {
  narrativePremise?: NarrativePremise;
  narrativeSource?: { versionId: string; checksum: string };
  narrativeConstraints?: NarrativeConstraints;
  narrativeCanon?: NarrativeCanon;
  supportingNpcPolicy?: SupportingNpcPolicy;
  supportingNpcAdmissions?: Record<string, { npcId: string; actorId: string; requestHash: string }>;
  objectives?: ObjectiveDefinition[];
  objectiveProgress?: Record<string, { achievedTick: number }>;
  artBindings?: FrozenArtBinding[];
  assetManifest?: typeof bundledGameAssetManifest;
  schemaVersion: 1;
  rulesetVersion: 'observatory-v1' | 'hybrid-v2' | 'hybrid-v3';
  startMapId?: string;
  npcBrains?: Record<string, NpcBrain>;
  npcNotices?: PrivateNpcNotice[];
  npcUtterances?: PrivateNpcUtterance[];
  roundPolicy?: { maxRounds: number; planningMs: number };
  seed: number;
  tick: number;
  revision: number;
  maps: Record<string, GameMap>;
  entities: Record<string, GameEntity>;
  encounters: Record<string, GameEncounter>;
}
export interface GameEvent {
  kind: string;
  actorId?: string;
  targetId?: string;
  mapId?: string;
  code?: GameError;
  itemId?: string;
}
export interface GameResult {
  state: GameState;
  events: GameEvent[];
  error?: GameError;
}
export interface GameProjection {
  narrative?: { revision: number; turns: NarrativePublicTurn[] };
  objectives?: ObjectiveProjection[];
  artBindings?: FrozenArtBinding[];
  assetManifest?: typeof bundledGameAssetManifest;
  schemaVersion: 1;
  rulesetVersion: string;
  tick: number;
  revision: number;
  actorId: string;
  map: GameMap;
  entities: GameEntity[];
  inventory: GameEntity[];
  encounter?: GameEncounter;
  npcNotices?: NpcNotice[];
  npcUtterances?: NpcUtterance[];
  npcFactTopics?: { npcId: string; id: string; title: string }[];
  npcObligations?: {
    id: string;
    npcId: string;
    itemId?: string;
    promisedAction?: import('./living').NpcPromisedAction;
    status: 'proposed' | 'accepted' | 'fulfilled' | 'broken' | 'cancelled';
    remainingTicks: number;
  }[];
  nearbyEncounters?: {
    id: string;
    mapId: string;
    area: GameEncounter['area'];
    round: number;
    phase: 'planning';
    participantCount: number;
  }[];
}
export const npcProposalSchema = z
  .object({
    contextRevision: z.number().int().nonnegative(),
    mapRevision: z.number().int().nonnegative(),
    entityRevision: z.number().int().nonnegative(),
    deadlineTick: z.number().int().nonnegative(),
    targetRevision: z.number().int().nonnegative().optional(),
    encounterGeneration: z.number().int().nonnegative().optional(),
    round: z.number().int().positive().optional(),
    action: gameActionSchema,
  })
  .strict();
export type NpcProposal = z.infer<typeof npcProposalSchema>;
export const gameMapSchema = z
  .object({
    id: gameIdSchema,
    label: z.string().trim().min(1).max(120).optional(),
    labelTranslations: gameLabelTranslationsSchema.optional(),
    sceneProfile: z.enum(['observatory-interior-v1', 'observatory-roof-v1']).optional(),
    width: z.number().int().min(1).max(64),
    height: z.number().int().min(1).max(64),
    blocked: z.array(gamePointSchema).max(4096),
    spawns: z.array(gamePointSchema).min(1).max(4),
    exits: z
      .array(
        z
          .object({
            id: gameIdSchema,
            x: z.number().int().min(0).max(63),
            y: z.number().int().min(0).max(63),
            label: z.string().trim().min(1).max(120).optional(),
            labelTranslations: gameLabelTranslationsSchema.optional(),
            destinationMapId: gameIdSchema,
            destination: gamePointSchema,
            doorId: gameIdSchema.optional(),
          })
          .strict(),
      )
      .max(32),
    revision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((m, ctx) => {
    for (const p of [...m.blocked, ...m.spawns, ...m.exits])
      if (p.x >= m.width || p.y >= m.height)
        ctx.addIssue({ code: 'custom', message: 'Coordinate outside map' });
  });
export const playableVersionSchema = z
  .object({
    schemaVersion: z.literal(1),
    rulesetVersion: z.enum(['observatory-v1', 'hybrid-v2', 'hybrid-v3']),
    maps: z.array(gameMapSchema).min(1).max(16),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = new Set(v.maps.map((m) => m.id));
    if (ids.size !== v.maps.length) ctx.addIssue({ code: 'custom', message: 'Duplicate map id' });
    for (const m of v.maps)
      for (const e of m.exits)
        if (!ids.has(e.destinationMapId))
          ctx.addIssue({ code: 'custom', message: 'Unknown destination map' });
  });
/** Wire entities deliberately exclude server-only path, memory, and inventory fields. */
export const gamePublicEntitySchema = z
  .object({
    id: gameIdSchema,
    kind: z.enum(['player', 'npc', 'item', 'door']),
    supportingNpc: supportingNpcCardSchema.optional(),
    label: z.string().trim().min(1).max(120).optional(),
    labelTranslations: gameLabelTranslationsSchema.optional(),
    visual: z.enum(['key', 'token', 'journal', 'door', 'keeper', 'traveler']).optional(),
    mapId: gameIdSchema,
    x: z.number().int().min(0).max(63),
    y: z.number().int().min(0).max(63),
    revision: z.number().int().nonnegative(),
    ownerId: gameIdSchema.optional(),
    locked: z.boolean().optional(),
    open: z.boolean().optional(),
    keyId: gameIdSchema.optional(),
    movementGeneration: z.number().int().nonnegative().optional(),
    lastInputSeq: z.number().int().nonnegative().optional(),
    encounterId: gameIdSchema.optional(),
  })
  .strict();
export const gamePublicEncounterSchema = z
  .object({
    id: gameIdSchema,
    policy: z
      .object({
        maxRounds: z.number().int().min(2).max(10),
        planningMs: z.number().int().min(5000).max(120000),
      })
      .strict()
      .optional(),
    pendingJoinIds: z.array(gameIdSchema).max(4).optional(),
    endVotes: z.array(gameIdSchema).max(24).optional(),
    coordinatorId: gameIdSchema.optional(),
    mapId: gameIdSchema,
    generation: z.number().int().nonnegative(),
    round: z.number().int().positive(),
    phase: z.enum(['planning', 'completed']),
    participants: z.array(gameIdSchema).min(1).max(24),
    area: z
      .object({
        x: z.number().int().min(0).max(63),
        y: z.number().int().min(0).max(63),
        width: z.number().int().min(1).max(64),
        height: z.number().int().min(1).max(64),
      })
      .strict(),
    deadlineMs: z.number().int().nonnegative().safe(),
    intents: z
      .record(
        gameIdSchema,
        z
          .object({
            revision: z.number().int().positive(),
            action: gameActionSchema,
            ready: z.boolean(),
          })
          .strict(),
      )
      .refine((v) => Object.keys(v).length <= 24),
  })
  .strict();
export const gameProjectionSchema = z
  .object({
    narrative: z
      .object({
        revision: z.number().int().nonnegative(),
        turns: z.array(narrativePublicTurnSchema).max(16),
      })
      .strict()
      .optional(),
    objectives: z.array(objectiveProjectionSchema).max(8).optional(),
    assetManifest: gameAssetManifestSchema.optional(),
    artBindings: frozenArtBindingsSchema.optional(),
    schemaVersion: z.literal(1),
    rulesetVersion: z.enum(['observatory-v1', 'hybrid-v2', 'hybrid-v3']),
    tick: z.number().int().nonnegative().safe(),
    revision: z.number().int().nonnegative().safe(),
    actorId: gameIdSchema,
    map: gameMapSchema,
    entities: z.array(gamePublicEntitySchema).min(1).max(512),
    inventory: z.array(gamePublicEntitySchema).max(128),
    encounter: gamePublicEncounterSchema.optional(),
    npcUtterances: z.array(npcUtteranceSchema).max(32).optional(),
    npcFactTopics: z
      .array(
        z
          .object({ npcId: gameIdSchema, id: z.string().max(100), title: z.string().max(120) })
          .strict(),
      )
      .max(128)
      .optional(),
    npcNotices: z.array(npcNoticeSchema).max(32).optional(),
    npcObligations: z
      .array(
        z
          .object({
            id: z.string().max(100),
            npcId: gameIdSchema,
            itemId: gameIdSchema.optional(),
            promisedAction: npcPromisedActionSchema.optional(),
            status: z.enum(['proposed', 'accepted', 'fulfilled', 'broken', 'cancelled']),
            remainingTicks: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(128)
      .optional(),
    nearbyEncounters: z
      .array(
        z
          .object({
            id: gameIdSchema,
            mapId: gameIdSchema,
            area: z
              .object({
                x: z.number().int().min(0).max(63),
                y: z.number().int().min(0).max(63),
                width: z.number().int().min(1).max(64),
                height: z.number().int().min(1).max(64),
              })
              .strict(),
            round: z.number().int().positive(),
            phase: z.literal('planning'),
            participantCount: z.number().int().min(1).max(24),
          })
          .strict(),
      )
      .max(16)
      .optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
    const ids = new Set(p.entities.map((e) => e.id));
    if (ids.size !== p.entities.length || !ids.has(p.actorId))
      invalid('Missing actor or duplicate entities');
    for (const e of p.entities) {
      if (
        e.mapId !== p.map.id ||
        e.x >= p.map.width ||
        e.y >= p.map.height ||
        e.ownerId !== undefined
      )
        invalid('Invalid visible entity');
      if (
        e.id !== p.actorId &&
        (e.movementGeneration !== undefined || e.lastInputSeq !== undefined)
      )
        invalid('Private actor input state');
    }
    const itemIds = new Set<string>();
    for (const e of p.inventory) {
      if (
        e.kind !== 'item' ||
        e.ownerId !== p.actorId ||
        ids.has(e.id) ||
        itemIds.has(e.id) ||
        e.movementGeneration !== undefined ||
        e.lastInputSeq !== undefined
      )
        invalid('Invalid private inventory');
      itemIds.add(e.id);
    }
    if (p.encounter) {
      const e = p.encounter;
      if (
        e.mapId !== p.map.id ||
        !e.participants.includes(p.actorId) ||
        new Set(e.participants).size !== e.participants.length
      )
        invalid('Invalid encounter membership');
      for (const [id, intent] of Object.entries(e.intents)) {
        if (!e.participants.includes(id)) invalid('Intent outside encounter');
        if (id !== p.actorId && intent.action.kind !== 'wait') invalid('Private future intent');
      }
    }
  });
export const gameEnvelopeSchema = z
  .object({
    type: z.enum(['snapshot', 'delta']),
    campaign: z
      .object({
        title: z.string().max(120).nullable(),
        playableVersionId: z.string().uuid().nullable(),
        sourceRevision: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .optional(),
    paused: z.boolean().optional(),
    streamId: z.string().min(1).max(300),
    projectionRevision: z.number().int().nonnegative().safe(),
    baseProjectionRevision: z.number().int().nonnegative().safe().optional(),
    connectionEpoch: z.number().int().nonnegative().safe(),
    serverNowMs: z.number().int().nonnegative().safe().optional(),
    projection: gameProjectionSchema,
  })
  .strict()
  .superRefine((envelope, ctx) => {
    if (envelope.projectionRevision !== envelope.projection.revision)
      ctx.addIssue({ code: 'custom', message: 'Projection revision mismatch' });
    if (envelope.type === 'delta' && envelope.baseProjectionRevision === undefined)
      ctx.addIssue({ code: 'custom', message: 'Delta requires a base revision' });
  });
export type GameEnvelope = z.infer<typeof gameEnvelopeSchema>;
export const gameVisualSchema = z.enum(['key', 'token', 'journal', 'door', 'keeper', 'traveler']);
const authoredLabel = z.string().trim().min(1).max(120);
export const authoredGameDraftSchema = z
  .object({
    narrativeConstraints: narrativeConstraintsSchema.optional(),
    supportingNpcPolicy: supportingNpcPolicySchema.optional(),
    objectives: objectiveDefinitionsSchema.optional(),
    schemaVersion: z.literal(1),
    title: authoredLabel,
    npcBehavior: z.literal('reactive-v1').optional(),
    startMapId: gameIdSchema,
    maps: z
      .array(
        z
          .object({
            id: gameIdSchema,
            label: authoredLabel,
            labelTranslations: gameLabelTranslationsSchema.optional(),
            sceneProfile: z.enum(['observatory-interior-v1', 'observatory-roof-v1']).optional(),
            sourceLocationId: z.string().min(1).max(80).optional(),
            width: z.number().int().min(5).max(32),
            height: z.number().int().min(5).max(32),
            blocked: z.array(gamePointSchema).max(1024),
            spawns: z.array(gamePointSchema).min(1).max(4),
            exits: z
              .array(
                z
                  .object({
                    id: gameIdSchema,
                    label: authoredLabel.optional(),
                    labelTranslations: gameLabelTranslationsSchema.optional(),
                    x: z.number().int().min(0).max(31),
                    y: z.number().int().min(0).max(31),
                    destinationMapId: gameIdSchema,
                    destination: gamePointSchema,
                    doorId: gameIdSchema.optional(),
                  })
                  .strict(),
              )
              .max(16),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    objects: z
      .array(
        z
          .object({
            id: gameIdSchema,
            kind: z.enum(['item', 'door']),
            label: authoredLabel,
            labelTranslations: gameLabelTranslationsSchema.optional(),
            mapId: gameIdSchema,
            x: z.number().int().min(0).max(31),
            y: z.number().int().min(0).max(31),
            visual: z.enum(['key', 'token', 'journal', 'door']),
            locked: z.boolean().optional(),
            open: z.boolean().optional(),
            keyId: gameIdSchema.optional(),
            ownerNpcId: gameIdSchema.optional(),
          })
          .strict(),
      )
      .max(32),
    npcs: z
      .array(
        z
          .object({
            id: gameIdSchema,
            sourceNpcId: z.string().uuid().optional(),
            label: authoredLabel,
            labelTranslations: gameLabelTranslationsSchema.optional(),
            mapId: gameIdSchema,
            x: z.number().int().min(0).max(31),
            y: z.number().int().min(0).max(31),
            visual: z.enum(['keeper', 'traveler']),
            goal: z.enum(['patrol', 'help']),
            personality: npcPersonalitySchema.optional(),
            initialFacts: z.array(npcAuthoredFactSchema).max(16).optional(),
            initialGoals: z.array(npcGoalDefinitionSchema).max(4).optional(),
            promiseTemplates: z.array(npcPromiseTemplateSchema).max(4).optional(),
            initialKnowledge: z
              .array(
                z
                  .object({
                    entityId: gameIdSchema,
                    revealCondition: z.enum(['never', 'asked', 'trusted']),
                  })
                  .strict(),
              )
              .max(16)
              .optional(),
            patrolTarget: gamePointSchema.optional(),
          })
          .strict(),
      )
      .max(8),
    roundPolicy: z
      .object({
        maxRounds: z.number().int().min(2).max(10),
        planningMs: z.number().int().min(5000).max(120000),
      })
      .strict(),
  })
  .strict();
export type AuthoredGameDraft = z.infer<typeof authoredGameDraftSchema>;
export interface NpcMemoryFact {
  eventId: string;
  kind: 'item_taken' | 'actor_seen' | 'door_changed' | 'helped';
  targetId?: string;
  tick: number;
}
export interface NpcBrain {
  living?: LivingNpcMemory;
  waitingForPath?: boolean;
  planMapId?: string;
  movementGeneration?: number;
  traits: ('cautious' | 'helpful')[];
  goal: 'patrol' | 'help';
  patrolTarget: GamePoint;
  facts: NpcMemoryFact[];
  plan: GameAction[];
  cursor: number;
  nextDecisionTick: number;
  generation: number;
}
export interface PlayablePackage {
  narrativePremise?: NarrativePremise;
  narrativeConstraints?: NarrativeConstraints;
  supportingNpcPolicy?: SupportingNpcPolicy;
  objectives?: ObjectiveDefinition[];
  artBindings?: FrozenArtBinding[];
  assetManifest: typeof bundledGameAssetManifest;
  schemaVersion: 1;
  rulesetVersion: 'hybrid-v2' | 'hybrid-v3';
  title: string;
  startMapId: string;
  maps: Record<string, GameMap>;
  entities: Record<string, GameEntity>;
  npcBrains: Record<string, NpcBrain>;
  roundPolicy: { maxRounds: number; planningMs: number };
}

export const npcPlanProposalSchema = z
  .object({
    contextRevision: z.number().int().nonnegative(),
    mapRevision: z.number().int().nonnegative(),
    entityRevision: z.number().int().nonnegative(),
    brainGeneration: z.number().int().nonnegative(),
    deadlineTick: z.number().int().nonnegative(),
    actions: z.array(gameActionSchema).min(1).max(3),
    knowledgeRevision: z.number().int().nonnegative().optional(),
    beliefRevisions: z.array(npcBeliefRevisionSchema).max(4).optional(),
    targetRevisions: z
      .record(gameIdSchema, z.number().int().nonnegative())
      .refine((v) => Object.keys(v).length <= 3),
  })
  .strict();
export * from './story-turn';
