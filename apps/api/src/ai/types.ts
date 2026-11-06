import type { PoolClient } from 'pg';
import type { TextReserveSnapshot } from '../generation/estimates';
export interface PreparedTextRequest {
  body: string;
  snapshot: TextReserveSnapshot;
}

/** Server-only DTOs. Never return context/proposal/provider credentials through public job status. */
export type AiPurpose =
  'plan' | 'summary' | 'speech' | 'intent' | 'supporting_npc' | 'narrative' | 'story_turn';
export interface AiScope {
  campaignId: string;
  npcId: string;
  origin: 'user' | 'system';
  subjectKind?: 'npc' | 'player';
  purpose?: AiPurpose;
  requesterUserId?: string;
}
export interface DecisionContext {
  contextHash: string;
  [key: string]: unknown;
}
export interface QueueDecision {
  scope: AiScope;
  operationId: string;
  context: DecisionContext;
  requesterUserId?: string;
  quoteId?: string;
  consent?: boolean;
  automaticKnownCostPolicy?: 'known-cost-v1';
  requestKey?: string;
  sponsorId?: string;
  runtimeRequestId?: string;
  /** Server-side immutable deferred quote binding, rechecked under the request row lock. */
  expectedRuntimeContextDigest?: string;
  /** Server-only finite batch consent, verified from locked DB records, never a client flag. */
  acceptedWorldBatchId?: string;
}
export type AiJobStatus =
  | 'queued'
  | 'reserved'
  | 'running'
  | 'result_received'
  | 'validated'
  | 'committed'
  | 'stale'
  | 'cancelled'
  | 'failed'
  | 'reconciling';
export interface ReadyDecision {
  id: string;
  campaignId: string;
  npcId: string;
  origin: 'user' | 'system';
  subjectKind?: 'npc' | 'player';
  requesterUserId: string | null;
  purpose: AiPurpose;
  contextHash: string;
  context: DecisionContext;
  proposal: unknown;
  createdAt: string;
}
export interface ProviderRequest {
  jobId: string;
  purpose: AiPurpose;
  context: DecisionContext;
  signal: AbortSignal;
  maxCostMicros: number;
  textReservationSnapshot?: TextReserveSnapshot;
}
/** Server-only shape evidence, never provider text, field names, paths or error messages. */
export interface ProviderOutputEnvelopeDiagnostic {
  reason: 'missing_output_text' | 'multiple_output_texts' | 'refusal';
  outputItems: '0' | '1' | '2+';
  messageItems: '0' | '1' | '2+';
  contentItems: '0' | '1' | '2+';
  outputTextItems: '0' | '1' | '2+';
  hasMalformedMessage: boolean;
  hasMalformedOutputText: boolean;
  hasOtherOutput: boolean;
  hasOtherContent: boolean;
}
export interface ProviderResult {
  proposal: unknown;
  requestId: string;
  failureCode?: string;
  /** Bounded adapter stage only. Never provider text, Zod messages, paths or private context. */
  failureStage?:
    | 'output_envelope'
    | 'json'
    | 'response_schema'
    | 'plan_actions'
    | 'plan_context'
    | 'plan_beliefs'
    | 'plan_proposal';
  /** Optional on output-envelope rejection only; older adapters/results omit it. */
  outputEnvelope?: ProviderOutputEnvelopeDiagnostic;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** Provider input-cache evidence, included within inputTokens, never extra tokens. */
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    cacheWriteInputTokensDetails?: { ttl30mTokens: number; ttl12hTokens: number };
    /** False when a reported billing category lacks immutable matching pricing. */
    costVerifiedForSparks?: boolean;
    costMicros: number;
    costEvidence?: 'reported' | 'configured_rates';
  };
}
export interface NpcProvider {
  readonly id: string;
  readonly version: string;
  readonly external: boolean;
  readonly manualLive?: boolean;
  runtimeVisionEnabled?(): boolean;
  canDispatchJob?(id: string): Promise<boolean>;
  requestAuthorized?(id: string, context?: unknown): Promise<boolean>;
  generate(request: ProviderRequest): Promise<ProviderResult>;
  countBody?(purpose: AiPurpose, context: unknown): string;
  count?(purpose: AiPurpose, context: unknown, operationId: string): Promise<number>;
  contextBudgetBytes?(maxCostMicros: number): number;
  contextWindow?():
    | {
        requestedContextTokens: number;
        effectiveContextTokens: number;
        modelContextTokens: number;
        reservedOutputTokens: number;
        precision: string;
        counterId: string;
        transportLimitBytes: number;
      }
    | undefined;
  contextFits?(purpose: AiPurpose, context: unknown): boolean;
  prepareTextRequest?(
    purpose: AiPurpose,
    context: unknown,
    pinned?: TextReserveSnapshot,
  ): PreparedTextRequest | undefined;
}
export interface AiPolicy {
  creditPrice: number;
  providerUpperMicros: number;
  providerCapMicros: number | null;
  timeoutMs: number;
  quoteMs: number;
  reservationMs: number;
  cacheMs: number;
  maxQueuedPerCampaign: number;
  maxContextBytes: number;
  maxResultBytes: number;
  /** External calls require both this explicit boundary and an enabled adapter. */
  externalApproved: boolean;
  killSwitch: boolean;
  version: string;
}
export type FinalizeDecision = (
  client: PoolClient,
  id: string,
  status: 'committed' | 'stale' | 'cancelled',
) => Promise<void>;
export class ProviderFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly uncertain: boolean,
    public readonly requestId?: string,
  ) {
    super(code);
  }
}
