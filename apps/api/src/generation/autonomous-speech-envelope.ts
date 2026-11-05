import type { StoryQuote } from '@dreamwalk/contracts';
import type { PoolClient, QueryResultRow } from 'pg';
import { digest } from '../ai/context';
import type { TextReserveSnapshot } from './estimates';
import { textInputReserveRate } from './text-pricing';

export const AUTONOMOUS_SPEECH_POLICY = 'bounded-npc-speech-v1' as const;
export function speechPricingIdentity(snapshot: TextReserveSnapshot) {
  return {
    model: snapshot.model,
    providerFingerprint: snapshot.providerFingerprint,
    inputMicrosPerMillion: snapshot.inputMicrosPerMillion,
    outputMicrosPerMillion: snapshot.outputMicrosPerMillion,
    cachePricing: snapshot.cachePricing ?? null,
    pricing: snapshot.pricing,
    assumptions: snapshot.assumptions,
    maxOutputTokens: snapshot.maxOutputTokens,
    contextTokens: snapshot.contextTokens,
    contextWindow: snapshot.contextWindow && {
      effectiveContextTokens: snapshot.contextWindow.effectiveContextTokens,
      requestedContextTokens: snapshot.contextWindow.requestedContextTokens,
      transportLimitBytes: snapshot.contextWindow.transportLimitBytes,
      counterId: snapshot.contextWindow.counterId,
      precision: snapshot.contextWindow.precision,
      protocolTokenAllowance: snapshot.contextWindow.protocolTokenAllowance,
    },
  };
}
export type AutonomousSpeechEnvelope = {
  version: typeof AUTONOMOUS_SPEECH_POLICY;
  maxRequests: 1;
  maxRetries: 0;
  maxImages: 0;
  maxOperationalCounts: 0;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxSerializedBytes: number;
  reserveMicros: number;
  estimatedTotalMicros: number;
  pricingHash: string;
  providerId: string;
  providerVersion: string;
  policyVersion: string;
  sourceVersionId: string;
  sourceRequestId: string;
  sourceContextDigest: string;
  npcId: string;
  turnFence: unknown;
  fingerprint: string;
};
export type AutonomousSpeechEntry = {
  envelope: AutonomousSpeechEnvelope;
  quote: StoryQuote;
};
/** A future text-only allowance, not an exact body or a provider-enforced invoice cap.
 * Uses the configured context/transport ceilings and reviewed tariff, never a guessed RP size. */
export function autonomousSpeechEnvelope(
  snapshot: TextReserveSnapshot,
  source: Pick<
    AutonomousSpeechEnvelope,
    | 'providerId'
    | 'providerVersion'
    | 'policyVersion'
    | 'sourceVersionId'
    | 'sourceRequestId'
    | 'sourceContextDigest'
    | 'npcId'
    | 'turnFence'
  >,
): AutonomousSpeechEnvelope {
  const window = snapshot.contextWindow;
  const now = Date.now();
  if (
    !window ||
    snapshot.costBasis !== 'operator_estimate' ||
    !snapshot.assumptions ||
    !snapshot.pricing ||
    !(
      Date.parse(snapshot.pricing.reviewedAt) <= now &&
      now < Date.parse(snapshot.pricing.validUntil)
    )
  )
    throw Error('SPARK_PRICE_UNVERIFIED');
  const maxInputTokens = Math.min(
    window.effectiveContextTokens - snapshot.maxOutputTokens,
    window.precision === 'conservative_estimate' &&
      window.counterId === 'utf8-envelope-plus-protocol-v1'
      ? window.transportLimitBytes + window.protocolTokenAllowance
      : window.effectiveContextTokens - snapshot.maxOutputTokens,
  );
  const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
  const estimated =
    ceil(BigInt(maxInputTokens) * BigInt(textInputReserveRate(snapshot)), 1000000n) +
    ceil(BigInt(snapshot.maxOutputTokens) * BigInt(snapshot.outputMicrosPerMillion), 1000000n);
  const reserve =
    estimated +
    ceil(estimated * BigInt(snapshot.marginBps), 10000n) +
    BigInt(snapshot.fixedMarginMicros);
  if (
    !Number.isSafeInteger(maxInputTokens) ||
    maxInputTokens <= 0 ||
    reserve <= 0n ||
    reserve > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw Error('SPARK_PRICE_UNVERIFIED');
  const body = {
    version: AUTONOMOUS_SPEECH_POLICY,
    maxRequests: 1 as const,
    maxRetries: 0 as const,
    maxImages: 0 as const,
    maxOperationalCounts: 0 as const,
    maxInputTokens,
    maxOutputTokens: snapshot.maxOutputTokens,
    maxSerializedBytes: window.transportLimitBytes,
    reserveMicros: Number(reserve),
    estimatedTotalMicros: Number(estimated),
    pricingHash: digest(speechPricingIdentity(snapshot)),
    providerId: source.providerId,
    providerVersion: source.providerVersion,
    policyVersion: source.policyVersion,
    sourceVersionId: source.sourceVersionId,
    sourceRequestId: source.sourceRequestId,
    sourceContextDigest: source.sourceContextDigest,
    npcId: source.npcId,
    turnFence: source.turnFence,
  };
  return { ...body, fingerprint: digest(body) };
}
export function autonomousSpeechConsentHash(
  entries: unknown[],
  mediaEntries: unknown[],
  speechEntries: unknown[],
) {
  return digest({ version: AUTONOMOUS_SPEECH_POLICY, entries, mediaEntries, speechEntries });
}
export function acceptedAutonomousSpeechMatches(batch: QueryResultRow) {
  return (
    Array.isArray(batch.autonomous_speech_entries) &&
    batch.autonomous_speech_entries.length > 0 &&
    batch.quote?.autonomousSpeechPolicy === AUTONOMOUS_SPEECH_POLICY &&
    batch.quote.autonomousSpeechPolicyHash ===
      autonomousSpeechConsentHash(
        batch.entries,
        batch.media_entries ?? [],
        batch.autonomous_speech_entries,
      )
  );
}
export function assertAutonomousSpeechSnapshot(
  envelope: AutonomousSpeechEnvelope,
  snapshot: TextReserveSnapshot,
) {
  const { fingerprint, ...body } = envelope;
  if (
    fingerprint !== digest(body) ||
    envelope.version !== AUTONOMOUS_SPEECH_POLICY ||
    envelope.maxRequests !== 1 ||
    envelope.maxRetries !== 0 ||
    envelope.maxImages !== 0 ||
    envelope.maxOperationalCounts !== 0 ||
    !snapshot ||
    digest(speechPricingIdentity(snapshot)) !== envelope.pricingHash ||
    snapshot.estimatedInputTokens > envelope.maxInputTokens ||
    snapshot.maxOutputTokens !== envelope.maxOutputTokens ||
    snapshot.serializedBytes > envelope.maxSerializedBytes ||
    snapshot.reserveMicros > envelope.reserveMicros ||
    snapshot.estimatedTotalMicros > envelope.estimatedTotalMicros
  )
    throw Error('AUTONOMOUS_SPEECH_ALLOWANCE_EXCEEDED');
}
export function autonomousSpeechPlanMatches(source: QueryResultRow, request: QueryResultRow) {
  const metadata = request.context?.worldPlanCommunication;
  const action = Number.isSafeInteger(metadata?.cursor)
    ? source.source_proposal?.actions?.[metadata.cursor]
    : undefined;
  return (
    !!metadata &&
    Number.isSafeInteger(metadata.brainGeneration) &&
    Number.isSafeInteger(metadata.cursor) &&
    metadata.cursor >= 0 &&
    metadata.sourceRequestId === source.id &&
    source.source_proposal?.brainGeneration + 1 === metadata.brainGeneration &&
    action?.kind === 'communicate' &&
    action.targetId === request.context.recipientId &&
    action.channel === request.context.channel &&
    Array.isArray(action.observationIds) &&
    Array.isArray(request.context.observationIds) &&
    digest([...action.observationIds].sort()) ===
      digest([...request.context.observationIds].sort()) &&
    request.cause_key ===
      `round:${metadata.roundId}:${request.npc_id}:communication:${metadata.brainGeneration}:${metadata.cursor}`
  );
}
/** Historical immutable child proof shared by admission and known-cost settlement.
 * It does not authorize another request, a retry, or a changed body after binding. */
export function autonomousSpeechBoundEntry(
  batch: QueryResultRow,
  binding: QueryResultRow | undefined,
  request: QueryResultRow,
  native: QueryResultRow,
  source: QueryResultRow | undefined,
) {
  if (!acceptedAutonomousSpeechMatches(batch) || !binding || !source) return undefined;
  const matches = (batch.autonomous_speech_entries as AutonomousSpeechEntry[]).filter(
    (entry) =>
      entry.envelope.sourceRequestId === binding.source_request_id &&
      entry.envelope.npcId === request.npc_id,
  );
  if (matches.length !== 1) return undefined;
  const allowed = matches[0],
    envelope = allowed.envelope;
  const parent = (batch.entries as QueryResultRow[]).filter(
    (entry) => entry.requestId === source.id,
  );
  const metadata = request.context?.worldPlanCommunication;
  if (
    binding.batch_id !== batch.id ||
    binding.request_id !== request.id ||
    binding.native_quote_id !== native.id ||
    binding.npc_id !== request.npc_id ||
    binding.context_digest !== digest(request.context) ||
    !(new Date(binding.created_at).getTime() >= new Date(batch.accepted_at).getTime()) ||
    !(new Date(binding.created_at).getTime() < new Date(native.expires_at).getTime()) ||
    binding.quote?.id !== native.id ||
    binding.quote.sparkRateVersion !== allowed.quote.sparkRateVersion ||
    request.purpose !== 'speech' ||
    request.context.runtimeMapImage ||
    request.context.textCountEvidence ||
    !autonomousSpeechPlanMatches(source, request) ||
    metadata.roundId !== batch.turn_fence?.roundId ||
    digest(request.context.turnFence) !== digest(batch.turn_fence) ||
    digest(envelope.turnFence) !== digest(batch.turn_fence) ||
    source.id !== envelope.sourceRequestId ||
    source.npc_id !== request.npc_id ||
    source.purpose !== 'plan' ||
    source.status !== 'scheduled' ||
    source.source_job_status !== 'committed' ||
    source.source_job_quote_id !== parent[0]?.quote?.id ||
    source.campaign_id !== batch.campaign_id ||
    digest(source.context) !== envelope.sourceContextDigest ||
    parent.length !== 1 ||
    parent[0].purpose !== 'plan' ||
    parent[0].npcId !== request.npc_id ||
    parent[0].contextDigest !== envelope.sourceContextDigest ||
    native.provider_id !== envelope.providerId ||
    native.provider_version !== envelope.providerVersion ||
    native.policy_version !== envelope.policyVersion ||
    String(native.upper_micros) !== String(native.request_snapshot?.reserveMicros) ||
    BigInt(binding.quote.sparkReservedSubunits ?? '-1') >
      BigInt(allowed.quote.sparkReservedSubunits ?? '-1')
  )
    return undefined;
  try {
    assertAutonomousSpeechSnapshot(envelope, native.request_snapshot);
  } catch {
    return undefined;
  }
  return {
    requestId: request.id,
    npcId: request.npc_id,
    purpose: 'speech',
    contextDigest: binding.context_digest,
    quote: binding.quote,
    sourceVersionId: envelope.sourceVersionId,
  };
}

export type AutonomousSpeechEvidence = {
  binding: QueryResultRow;
  source: QueryResultRow;
  native: QueryResultRow;
};
export async function loadAutonomousSpeechEvidence(
  c: Pick<PoolClient, 'query'>,
  batch: QueryResultRow,
  request: QueryResultRow,
): Promise<AutonomousSpeechEvidence | undefined> {
  if (!request.context?.worldPlanCommunication || !acceptedAutonomousSpeechMatches(batch))
    return undefined;
  const binding = (
    await c.query(
      'SELECT * FROM game_autonomous_speech_bindings WHERE batch_id=$1 AND request_id=$2',
      [batch.id, request.id],
    )
  ).rows[0];
  if (!binding) return undefined;
  const source = (
    await c.query(
      `SELECT r.*,j.status AS source_job_status,j.quote_id AS source_job_quote_id,j.proposal AS source_proposal
    FROM game_npc_decision_requests r JOIN npc_ai_jobs j ON j.id=r.job_id WHERE r.id=$1`,
      [binding.source_request_id],
    )
  ).rows[0];
  const native = (
    await c.query('SELECT * FROM npc_ai_quotes WHERE id=$1', [binding.native_quote_id])
  ).rows[0];
  return source && native ? { binding, source, native } : undefined;
}
export async function readAutonomousSpeechBoundEntry(
  c: Pick<PoolClient, 'query'>,
  batch: QueryResultRow,
  request: QueryResultRow,
  native: QueryResultRow,
) {
  const evidence = await loadAutonomousSpeechEvidence(c, batch, request);
  return (
    evidence &&
    autonomousSpeechBoundEntry(batch, evidence.binding, request, native, evidence.source)
  );
}
