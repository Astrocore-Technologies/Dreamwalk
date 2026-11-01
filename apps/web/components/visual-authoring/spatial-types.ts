import type { AuthoredGameDraft, GameProjection } from '@dreamwalk/contracts';
export type SpatialQuote = {
  id: string;
  upperMicros: number;
  expiresAt: string;
  consumed: boolean;
};
export type SpatialJob = {
  id: string;
  projectId: string;
  status:
    | 'queued'
    | 'dispatched'
    | 'generated'
    | 'unknown'
    | 'committed'
    | 'cancelled'
    | 'stale'
    | 'failed';
  canCancel: boolean;
  canRetry: false;
  upperMicros: number;
  actualMicros: number | null;
  costStatus: 'unknown' | 'settled' | 'reserved';
  errorCode: string | null;
  createdAt: string;
  dispatchedAt?: string | null;
  completedAt?: string | null;
  result?: { proposalId?: string } | null;
};
export type SpatialProposal = {
  id: string;
  status: 'proposed' | 'applied' | 'cancelled';
  projectRevision: number;
  sourceHash: string;
  plan: AuthoredGameDraft;
  projection: GameProjection;
  validated: boolean;
};
export type SpatialState = {
  available: boolean;
  canQuote: boolean;
  manualDispatchOnly: true;
  model: string;
  maxOutputTokens: number;
  upperMicros: number;
  quotes: SpatialQuote[];
  jobs: SpatialJob[];
  currentProposal?: SpatialProposal | null;
  canApply: boolean;
  blockers: string[];
};
export type SpatialProject = { id: string; revision: number; sourceHash: string; status: string };
