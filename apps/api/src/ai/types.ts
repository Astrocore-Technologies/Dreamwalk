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
  requestKey?: string;
  sponsorId?: string;
  runtimeRequestId?: string;
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
export interface ProviderResult {
  proposal: unknown;
  requestId: string;
  failureCode?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    costEvidence?: 'reported' | 'configured_rates';
  };
}
export interface NpcProvider {
  readonly id: string;
  readonly version: string;
  readonly external: boolean;
  readonly manualLive?: boolean;
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
  prepareTextRequest?(purpose: AiPurpose, context: unknown): PreparedTextRequest | undefined;
}
export interface AiPolicy {
  creditPrice: number;
  providerUpperMicros: number;
  providerCapMicros: number;
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
