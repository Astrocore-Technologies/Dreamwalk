import {
  autonomousSpeechBoundEntry,
  type AutonomousSpeechEvidence,
} from '../generation/autonomous-speech-envelope';
import {
  acceptedWorldKnownCostPolicyMatches,
  worldKnownCostPolicyRequired,
} from '../generation/known-cost-policy';
import type { QueryResultRow } from 'pg';
import { providerMicrosToSparkSubunits } from '@dreamwalk/contracts';
import { digest } from '../ai/context';
import { DREAMS_FIRST_POLICY, sparkQuoteRateVersion } from '../generation/sparks-accounting';

/** Reconstruct original admission, never a fresh permission from current campaign state. */
/** historicalSourceProof checks original consent, not authority to capture an old bill. */
export function automaticNpcAdmission(
  job: QueryResultRow,
  native: QueryResultRow | undefined,
  authorization: QueryResultRow,
  reservation: QueryResultRow,
  hold: QueryResultRow,
  quote: QueryResultRow,
  batch?: QueryResultRow,
  request?: QueryResultRow,
  dreams?: { hold: QueryResultRow; quote: QueryResultRow },
  historicalSourceProof = false,
  speechEvidence?: AutonomousSpeechEvidence,
): boolean {
  try {
    const p = job.request_snapshot;
    const admitted = quote.price_snapshot?.providerQuote;
    if (
      !native ||
      !p ||
      !admitted ||
      job.request_meta?.consent !== true ||
      job.request_meta.quoteId !== native.id ||
      job.quote_id !== native.id ||
      native.user_id !== job.payer_user_id ||
      native.spark_quote_id !== hold.id ||
      native.credits !== 0 ||
      quote.operation_id !== native.id ||
      [
        'campaign_id',
        'npc_id',
        'purpose',
        'context_hash',
        'provider_id',
        'provider_version',
        'policy_version',
      ].some((k) => native[k] !== job[k]) ||
      digest(native.request_snapshot) !== digest(p) ||
      digest(admitted) !==
        digest({
          ...p,
          policyVersion: job.policy_version,
          contextHash: job.context_hash,
          ...(admitted.automaticKnownCostPolicy
            ? { automaticKnownCostPolicy: admitted.automaticKnownCostPolicy }
            : {}),
        }) ||
      job.context?.contextHash !== job.context_hash ||
      job.context_hash === 'erased' ||
      !job.started_at ||
      !job.completed_at ||
      authorization.id !== job.generation_authorization_id ||
      reservation.id !== job.generation_reservation_id ||
      reservation.operation_key !== `release-npc:${job.id}` ||
      String(reservation.upper_micros) !== String(p.reserveMicros) ||
      String(native.upper_micros) !== String(p.reserveMicros) ||
      String(job.provider_upper_micros) !== String(p.reserveMicros) ||
      !Number.isSafeInteger(p.reserveMicros) ||
      p.reserveMicros < 0 ||
      BigInt(job.provider_actual_micros) > BigInt(p.reserveMicros) ||
      hold.status !== 'pending' ||
      hold.reason !== 'failure_policy_pending' ||
      hold.captured_subunits !== null ||
      hold.settlement_fingerprint !== null ||
      String(hold.reserved_subunits) !==
        providerMicrosToSparkSubunits(
          String(p.reserveMicros),
          sparkQuoteRateVersion(quote.price_snapshot),
        )
    )
      return false;
    const tariff = quote.price_snapshot.tariff;
    if (
      tariff.provider !== job.provider_id ||
      tariff.providerRateVersion !== p.providerFingerprint ||
      tariff.model !== p.model ||
      tariff.inputMicrosPerMillion !== String(p.inputMicrosPerMillion) ||
      tariff.outputMicrosPerMillion !== String(p.outputMicrosPerMillion) ||
      tariff.cachedInputMicrosPerMillion !==
        String(p.cachePricing?.cachedInputMicrosPerMillion ?? p.inputMicrosPerMillion) ||
      (p.cachePricing &&
        tariff.cacheWriteMicrosPerMillion !== String(p.cachePricing.cacheWrite30mMicrosPerMillion))
    )
      return false;
    // A new policy is never retroactive authorization for historical pending bills.
    const ordinary =
      (job.subject_kind === 'npc' ||
        (job.subject_kind === 'player' && job.purpose === 'story_turn')) &&
      batch?.quote?.ordinaryTurnConsentVersion === 'end-turn-v1' &&
      (batch.quote.generatedLocationImages ?? 0) === 0 &&
      batch.quote.estimateRiskConsentRequired !== true &&
      (batch.media_entries == null ||
        (Array.isArray(batch.media_entries) && batch.media_entries.length === 0));
    if (
      !(
        admitted.automaticKnownCostPolicy === 'known-cost-v1' &&
        job.request_meta.automaticKnownCostPolicy === 'known-cost-v1'
      ) &&
      !ordinary &&
      (!historicalSourceProof ||
        admitted.automaticKnownCostPolicy != null ||
        job.request_meta.automaticKnownCostPolicy != null)
    )
      return false;
    let acceptedWorldBatchId = job.request_meta.acceptedWorldBatchId ?? null;
    if (batch) {
      if (
        (job.request_meta.automaticKnownCostPolicy === 'known-cost-v1' ||
          worldKnownCostPolicyRequired(batch)) &&
        !acceptedWorldKnownCostPolicyMatches(batch)
      )
        return false;
      const accepted = new Date(batch.accepted_at).getTime();
      const entries = Array.isArray(batch.entries) ? batch.entries : [];
      const matching = entries.filter(
        (e: QueryResultRow) =>
          e.requestId === job.request_meta.runtimeRequestId && e.quote?.id === native.id,
      );
      if (matching.length === 0 && request && speechEvidence) {
        const child = autonomousSpeechBoundEntry(
          batch,
          speechEvidence.binding,
          request,
          native,
          speechEvidence.source,
        );
        if (child) matching.push(child);
      }
      if (
        !request ||
        !batch.accepted_at ||
        !Number.isFinite(accepted) ||
        !['accepted', 'stale'].includes(batch.state) ||
        batch.owner_id !== job.payer_user_id ||
        batch.campaign_id !== job.campaign_id ||
        accepted >= new Date(batch.expires_at).getTime() ||
        accepted >= new Date(native.expires_at).getTime() ||
        matching.length !== 1 ||
        matching[0].contextDigest !== digest(job.context) ||
        matching[0].npcId !== job.npc_id ||
        matching[0].purpose !== job.purpose ||
        request.id !== job.request_meta.runtimeRequestId ||
        request.job_id !== job.id ||
        request.requester_user_id !== job.payer_user_id ||
        ['campaign_id', 'npc_id', 'purpose'].some((k) => request[k] !== job[k]) ||
        digest(request.context) !== digest(job.context) ||
        (acceptedWorldBatchId && acceptedWorldBatchId !== batch.id)
      )
        return false;
      acceptedWorldBatchId = batch.id;
    } else if (
      acceptedWorldBatchId ||
      !(new Date(job.created_at).getTime() < new Date(native.expires_at).getTime())
    )
      return false;
    // Optional scope fields were omitted by some callers. Only these schema-equivalent
    // variants are allowed; the stored hash must match one exactly.
    const scopes = [true, false]
      .flatMap((subject) =>
        [true, false].map((purpose) => ({
          campaignId: job.campaign_id,
          npcId: job.npc_id,
          origin: job.origin,
          requesterUserId: job.requester_user_id,
          ...(subject ? { subjectKind: job.subject_kind } : {}),
          ...(purpose ? { purpose: job.purpose } : {}),
        })),
      )
      .filter(
        (s) =>
          ('subjectKind' in s || job.subject_kind === 'npc') &&
          ('purpose' in s || job.purpose === 'plan'),
      );
    // Before world batches existed, direct requests omitted this field entirely.
    // Accept that exact historical hash only for a legacy direct admission, never
    // by dropping a real batch identity or automatic-policy consent.
    const batchScopes: Array<{ acceptedWorldBatchId: unknown } | Record<string, never>> = [
      { acceptedWorldBatchId },
    ];
    if (
      historicalSourceProof &&
      !batch &&
      acceptedWorldBatchId === null &&
      !Object.hasOwn(job.request_meta, 'acceptedWorldBatchId') &&
      admitted.automaticKnownCostPolicy == null &&
      job.request_meta.automaticKnownCostPolicy == null
    )
      batchScopes.push({});
    if (
      !scopes.some((scope) =>
        batchScopes.some(
          (batchScope) =>
            digest({
              scope,
              context: job.context,
              quoteId: native.id,
              consent: true,
              requestKey: job.request_meta.requestKey ?? '',
              sponsorId: null,
              runtimeRequestId: job.request_meta.runtimeRequestId ?? null,
              ...batchScope,
              ...(job.request_meta.automaticKnownCostPolicy
                ? { automaticKnownCostPolicy: job.request_meta.automaticKnownCostPolicy }
                : {}),
            }) === job.request_hash,
        ),
      )
    )
      return false;
    const dreamReserve =
      BigInt(hold.reserved_subunits) -
      BigInt(hold.sparks_reserved_subunits ?? hold.reserved_subunits);
    if (dreamReserve > 0n) {
      const dh = dreams?.hold,
        dq = dreams?.quote;
      if (
        !dh ||
        !dq ||
        quote.price_snapshot.fundingPolicy !== DREAMS_FIRST_POLICY ||
        dh.id !== hold.dream_hold_id ||
        dq.id !== dh.id ||
        dh.owner_id !== hold.owner_id ||
        dq.owner_id !== hold.owner_id ||
        dh.source_kind !== 'npc' ||
        dq.source_kind !== 'npc' ||
        dh.source_id !== native.id ||
        dq.source_id !== native.id ||
        dq.operation_id !== hold.id ||
        String(dh.reserved_subunits) !== String(dreamReserve) ||
        String(dq.reserve_subunits) !== String(dreamReserve) ||
        dq.price_snapshot?.currency !== 'dreams' ||
        dq.price_snapshot?.policyVersion !== DREAMS_FIRST_POLICY ||
        dq.price_snapshot?.providerQuote?.sparkQuoteId !== hold.id ||
        digest(dq.price_snapshot?.providerQuote?.priceSnapshot) !== digest(quote.price_snapshot) ||
        dh.status !== 'pending' ||
        dh.reason !== 'unknown' ||
        dh.captured_subunits !== null ||
        dh.settlement_fingerprint !== null
      )
        return false;
    } else if (dreams || hold.dream_hold_id) return false;
    return true;
  } catch {
    return false;
  }
}
