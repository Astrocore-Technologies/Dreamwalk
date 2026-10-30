/** Process-local operational counters. No actor IDs, text, prompts or persistent game state. */
const counters = {
  knowledgeRejected: 0,
  summaryRejected: 0,
  retrievalCalls: 0,
  retrievalCandidates: 0,
  retrievalSelected: 0,
  retrievalDurationMs: 0,
  causeSamples: 0,
  causeDelayTicks: 0,
  retentionRuns: 0,
  retentionRemovedEpisodes: 0,
  retentionCompactedStates: 0,
  retentionRedactedReplays: 0,
};
export type NpcMetric = keyof typeof counters;
export function recordNpcMetric(name: NpcMetric, amount = 1) {
  if (!Number.isFinite(amount) || amount < 0) return;
  counters[name] = Math.min(Number.MAX_SAFE_INTEGER, counters[name] + amount);
}
export function npcTelemetrySnapshot() {
  return {
    scope: 'current-process',
    ...counters,
    meanRetrievalMs: counters.retrievalCalls
      ? counters.retrievalDurationMs / counters.retrievalCalls
      : 0,
    selectedPerCandidate: counters.retrievalCandidates
      ? counters.retrievalSelected / counters.retrievalCandidates
      : 0,
    meanCauseDelayTicks: counters.causeSamples
      ? counters.causeDelayTicks / counters.causeSamples
      : 0,
  };
}
