import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { digest } from '../ai/context';
import type { OwnerGenerationConfig } from './config';
import type { TextEstimationPolicy, ImageEstimationPolicy } from './estimates';

/** Explicit safe allowlist: financial history never embeds an account handle or private input. */
export function safeOwnerProfile(config: OwnerGenerationConfig) {
  const pricing = (p: OwnerGenerationConfig['text']['pricing']) => ({
    source: p.source,
    reviewedAt: p.reviewedAt,
    validUntil: p.validUntil,
  });
  const estimation = (p: TextEstimationPolicy | ImageEstimationPolicy | undefined) =>
    p
      ? {
          kind: p.kind,
          textTokensPerKiBUtf8: p.textTokensPerKiBUtf8,
          textProtocolTokens: p.textProtocolTokens,
          marginBps: p.marginBps,
          fixedMarginMicros: p.fixedMarginMicros,
          ...('outputImageTokens' in p
            ? {
                outputImageTokens: p.outputImageTokens,
                referenceImageTokensPerImage: p.referenceImageTokensPerImage,
                referenceAllowanceMicros: p.referenceAllowanceMicros,
              }
            : {}),
        }
      : undefined;
  return {
    mode: 'owner' as const,
    totalCapMicros: config.totalCapMicros,
    textCapMicros: config.textCapMicros,
    imageCapMicros: config.imageCapMicros,
    text: {
      model: config.text.model,
      contextTokens: config.text.contextTokens,
      ...(config.text.contextBudgetTokens !== undefined
        ? { contextBudgetTokens: config.text.contextBudgetTokens }
        : {}),
      ...(config.text.counting ? { counting: config.text.counting } : {}),
      maxOutputTokens: config.text.maxOutputTokens,
      maxInputBytes: config.text.maxInputBytes,
      inputMicrosPerMillion: config.text.inputMicrosPerMillion,
      outputMicrosPerMillion: config.text.outputMicrosPerMillion,
      upperMicros: config.text.upperMicros,
      pricing: pricing(config.text.pricing),
      ...('estimation' in config.text ? { estimation: estimation(config.text.estimation) } : {}),
    },
    image: {
      model: config.image.model,
      size: config.image.size,
      quality: config.image.quality,
      outputs: config.image.outputs,
      format: config.image.format,
      maxPromptUtf8Bytes: config.image.maxPromptUtf8Bytes,
      maxReferenceImages: config.image.maxReferenceImages,
      inputTextMicrosPerMillion: config.image.inputTextMicrosPerMillion,
      inputImageMicrosPerMillion: config.image.inputImageMicrosPerMillion,
      outputImageMicrosPerMillion: config.image.outputImageMicrosPerMillion,
      estimatedTotalMicros: config.image.estimatedTotalMicros,
      reserveMicros: config.image.reserveMicros,
      estimateRiskAccepted: config.image.estimateRiskAccepted,
      pricing: pricing(config.image.pricing),
      maxReferenceBytes: config.image.maxReferenceBytes,
      maxReferencePixels: config.image.maxReferencePixels,
      costBasis: config.image.costBasis,
      providerEnforcesQuotedCap: false as const,
      ...('estimation' in config.image ? { estimation: estimation(config.image.estimation) } : {}),
    },
  };
}
export function revisionReceipt(row: QueryResultRow) {
  return {
    operationId: row.operation_id as string,
    status: 'applied' as const,
    revision: Number(row.revision),
    hash: row.profile_hash as string,
    candidateFingerprint: row.config_fingerprint as string,
    acknowledgedAt: new Date(row.acknowledged_at).toISOString(),
  };
}
export async function appendPolicyRevision(
  c: PoolClient,
  input: {
    authorizationId: string;
    scopeId: string;
    revision: number;
    hash: string;
    previousHash: string | null;
    config: OwnerGenerationConfig;
    operationId: string;
    requestHash: string;
  },
) {
  const row = (
    await c.query(
      'INSERT INTO generation_policy_revisions(id,authorization_id,scope_id,revision,profile_hash,config_fingerprint,previous_hash,profile_snapshot,operation_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [
        randomUUID(),
        input.authorizationId,
        input.scopeId,
        input.revision,
        input.hash,
        input.config.configFingerprint,
        input.previousHash,
        JSON.stringify(safeOwnerProfile(input.config)),
        input.operationId,
        input.requestHash,
      ],
    )
  ).rows[0];
  await c.query('UPDATE live_test_sessions SET policy_revision=$2,policy_hash=$3 WHERE id=$1', [
    input.authorizationId,
    input.revision,
    input.hash,
  ]);
  return row;
}
export async function policyLiabilities(c: PoolClient, scopeId: string) {
  const rows = (
    await c.query(
      `SELECT kind,COALESCE(sum(CASE WHEN status='settled' THEN actual_micros ELSE 0 END),0) spent,
      COALESCE(sum(CASE WHEN status='held' THEN upper_micros ELSE 0 END),0) held,
      COALESCE(sum(CASE WHEN status='held' AND (
        EXISTS(SELECT 1 FROM image_generation_jobs j WHERE j.reservation_id=r.id AND (j.status='unknown' OR (j.status='dispatched' AND j.dispatch_deadline<=clock_timestamp())))
        OR EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.reservation_id=r.id AND (p.state='unknown' OR (p.state='dispatched' AND p.dispatched_at<=clock_timestamp()-interval '60 seconds')))
        OR EXISTS(SELECT 1 FROM live_authoring_text_jobs j WHERE j.reservation_id=r.id AND (j.status='unknown' OR (j.status='dispatched' AND j.deadline_at<=clock_timestamp())))
        OR EXISTS(SELECT 1 FROM generation_text_counts t WHERE t.reservation_id=r.id AND (t.status='unknown' OR (t.status='dispatched' AND t.deadline_at<=clock_timestamp())))
      ) THEN upper_micros ELSE 0 END),0) unknown
    FROM generation_budget_reservations r WHERE scope_id=$1 GROUP BY kind`,
      [scopeId],
    )
  ).rows;
  const kind = (name: string) => {
    const row = rows.find((r) => r.kind === name);
    return {
      spentMicros: Number(row?.spent ?? 0),
      heldMicros: Number(row?.held ?? 0),
      unknownMicros: Number(row?.unknown ?? 0),
    };
  };
  const text = kind('text'),
    image = kind('image');
  const spentMicros = text.spentMicros + image.spentMicros,
    heldMicros = text.heldMicros + image.heldMicros;
  return {
    spentMicros,
    heldMicros,
    unknownMicros: text.unknownMicros + image.unknownMicros,
    totalAccountedMicros: spentMicros + heldMicros,
    text,
    image,
  };
}
/** Read-only inspection. Called under the existing authorization/scope locks when applying. */
export async function policyWorkBlockers(c: PoolClient, scopeId: string) {
  const result = (
    await c.query(
      `SELECT
      EXISTS(SELECT 1 FROM generation_budget_reservations WHERE scope_id=$1 AND status='held') OR
      EXISTS(SELECT 1 FROM image_generation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id
        WHERE r.scope_id=$1 AND j.mode='external' AND j.status IN ('queued','dispatched','generated','unknown')) OR
      EXISTS(SELECT 1 FROM live_test_text_permits p JOIN live_test_sessions s ON s.id=p.session_id
        WHERE s.scope_id=$1 AND p.state IN ('authorized','dispatched','unknown')) OR
      EXISTS(SELECT 1 FROM live_authoring_text_jobs j JOIN live_test_sessions s ON s.id=j.session_id
        WHERE s.scope_id=$1 AND j.status IN ('queued','dispatched','generated','unknown')) OR
      EXISTS(SELECT 1 FROM npc_ai_jobs j JOIN live_test_sessions s ON s.id=j.generation_authorization_id
        WHERE s.scope_id=$1 AND j.provider_external IS DISTINCT FROM false
          AND j.status IN ('queued','reserved','running','result_received','validated','reconciling')) AS busy,
      EXISTS(SELECT 1 FROM generation_text_counts WHERE scope_id=$1 AND (status='unknown' OR (status='dispatched' AND deadline_at<=clock_timestamp()))) OR
      EXISTS(SELECT 1 FROM image_generation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id
        WHERE r.scope_id=$1 AND j.mode='external' AND (j.status='unknown' OR j.safe_diagnostic->>'httpStatus'='403' OR (j.status='dispatched' AND j.dispatch_deadline<=clock_timestamp()))) OR
      EXISTS(SELECT 1 FROM live_test_text_permits p JOIN live_test_sessions s ON s.id=p.session_id
        WHERE s.scope_id=$1 AND (p.state='unknown' OR p.result_code='PROVIDER_HTTP_403' OR (p.state='dispatched' AND p.dispatched_at<=clock_timestamp()-interval '60 seconds'))) OR
      EXISTS(SELECT 1 FROM live_authoring_text_jobs j JOIN live_test_sessions s ON s.id=j.session_id
        WHERE s.scope_id=$1 AND (j.status='unknown' OR j.error_code='PROVIDER_HTTP_403' OR (j.status='dispatched' AND j.deadline_at<=clock_timestamp()))) AS unknown`,
      [scopeId],
    )
  ).rows[0];
  return [
    ...(result.unknown ? ['LIVE_OUTCOME_UNRESOLVED'] : []),
    ...(result.busy ? ['GENERATION_POLICY_BUSY'] : []),
  ];
}
export const policyRequestHash = (body: unknown) => digest(body);
