/** Evidence formatting only. No model calls, keyword grading or semantic pass claims. */
export function qualityAssessment(fixture) {
  return {
    status: fixture ? 'not_evaluated_fixture' : 'pending_human_review',
    dimensions: [
      'intent_relevance',
      'attributed_public_recall',
      'world_fact_grounding',
      'causal_continuity',
      'actionable_next_step',
      'identity_and_language',
      'privacy',
    ],
    rule: 'Recalling that a player said or named something is not proof that the underlying world claim is true. Missing, private, contradicted or different-NPC evidence must not be invented.',
    limitation:
      'Offline fixtures verify evidence plumbing and instruction contracts, not live model quality. Mechanical acceptance does not imply semantic success.',
  };
}
export function newAuthorizedJob(before, after, purpose) {
  const prior = new Set(before.map((job) => job.id));
  const matches = after.filter((job) => job.purpose === purpose && !prior.has(job.id));
  return {
    jobId: matches.length === 1 ? matches[0].id : null,
    jobCorrelation:
      matches.length === 1 ? 'single_new_authorized_job_in_serial_turn_window' : 'unresolved',
    candidateJobIds: matches.map((job) => job.id),
  };
}
export function speechQualityTurn({
  input,
  npc,
  before,
  after,
  decisionRequestId,
  operationId,
  job,
}) {
  const prior = new Set(before.map((u) => u.id));
  return {
    kind: 'npc',
    input,
    npcId: npc.id,
    name: npc.label,
    role: npc.supportingNpc?.roleLabel ?? null,
    decisionRequestId,
    operationId,
    ...job,
    evidenceAvailability:
      'player-visible utterance IDs only; private NPC claims/context not exported',
    priorVisibleUtteranceIds: before.map((u) => u.id),
    outputs: after
      .filter((u) => u.speakerId === npc.id && !prior.has(u.id))
      .map((u) => ({ id: u.id, tick: u.tick, text: u.text ?? null, code: u.code ?? null })),
    outputCorrelation:
      'new_visible_utterances_from_target_in_serial_turn_window_not_private_provenance',
    semanticGrade: 'unreviewed',
  };
}
export function narrativeQualityTurn({ input, result, job }) {
  return {
    kind: 'narrative',
    input,
    text: result.narration ?? null,
    turnId: result.id,
    decisionRequestId: result.id,
    operationId: result.operationId ?? null,
    sceneId: result.sceneId ?? null,
    npcId: result.npcId ?? null,
    ...job,
    semanticGrade: 'unreviewed',
  };
}
export function linkQualityReceipts(turns, receipts) {
  return turns.map((turn) => {
    const matches = turn.jobId ? receipts.filter((receipt) => receipt.jobId === turn.jobId) : [];
    const receipt = matches.length === 1 ? matches[0] : null;
    return {
      ...turn,
      receipt: receipt
        ? {
            jobId: receipt.jobId,
            state: receipt.state,
            requestHash: receipt.requestHash ?? null,
            contextHash: receipt.contextHash ?? null,
            responseId: receipt.responseId ?? null,
            httpRequestId: receipt.httpRequestId ?? null,
            costMicros: receipt.costMicros ?? null,
          }
        : null,
      receiptLink: receipt ? 'exact_job_id' : 'unresolved',
    };
  });
}
