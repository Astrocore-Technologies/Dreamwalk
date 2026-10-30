import type { PoolClient } from 'pg';

/** Server-only DTOs. Never return context/proposal/provider credentials through public job status. */
export type AiPurpose = 'plan' | 'summary' | 'speech' | 'intent';
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
  generate(request: ProviderRequest): Promise<ProviderResult>;
  contextBudgetBytes?(maxCostMicros: number): number;
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
