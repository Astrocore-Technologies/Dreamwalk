export type StartPreparation = {
  id: string;
  status: string;
  reused: boolean;
  campaignId: string | null;
  directorProfileId?: string;
  jobs?: { status: string; error_code?: string; sparkStatus?: string | null }[];
};
export function startState(preparation: StartPreparation | null, dispatchUncertain = false) {
  if (preparation?.campaignId || preparation?.status === 'ready') return 'ready';
  const job = preparation?.jobs?.[0];
  if (!job) return dispatchUncertain ? 'checking' : 'estimate';
  if (['queued', 'dispatched', 'generated'].includes(job.status)) return 'running';
  if (job.status === 'unknown') return 'unknown';
  if (['failed', 'rejected', 'stale', 'cancelled'].includes(job.status)) {
    // A failed provider response does not imply a released payment reservation.
    return ['released', 'settled'].includes(job.sparkStatus ?? '') ? 'failed' : 'review';
  }
  return 'checking';
}
