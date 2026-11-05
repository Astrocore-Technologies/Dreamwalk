import { ownerPricingIsCurrent } from '../generation/config';
import {
  MODEL_REJECTION_STOP,
  modelRejectionEvidenceHash,
  modelRejectionGateHistory,
} from './model-rejection-provenance';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { fail } from '../errors';
import type { ImagePolicy } from './contracts';
import { normalizeSafeImageDiagnostic } from './error-diagnostics';
import { settleGenerationSpend } from './budget';
import { fenceGenerationAdmission } from '../generation/scope-fence';

export const imageRecoverySchema = z
  .object({
    mode: z.enum(['review', 'apply']),
    operationId: z.uuid(),
    expectedFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    evidence: z
      .object({
        source: z.enum(['provider_usage', 'provider_support']),
        reference: z
          .string()
          .trim()
          .min(3)
          .max(160)
          .regex(/^[a-zA-Z0-9 _.:/#-]+$/)
          .refine((v) => !/sk[-_]|bearer|api.?key/i.test(v)),
        requestId: z.string().regex(/^req_[a-zA-Z0-9_-]{1,160}$/),
        actualMicros: z.number().int().min(0).max(1_000_000_000),
        chargeVerified: z.literal(true),
        modelAccessRestored: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .refine((v) => v.mode !== 'apply' || !!v.expectedFingerprint);

export function isRecoverableModelRejection(diagnostic: unknown) {
  const d = normalizeSafeImageDiagnostic(diagnostic);
  return (
    !!d &&
    d.httpStatus === 403 &&
    d.category === 'model_access' &&
    ['model_not_found', 'model_access_denied'].includes(d.providerCode ?? '') &&
    !!d.requestId
  );
}
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Owner-attested external billing evidence, never an inference that HTTP 403 is free.
 * No provider call and no retry. Authorization -> scope -> job -> reservation lock order. */
export async function recoverModelRejectionTx(
  c: PoolClient,
  actorId: string,
  jobId: string,
  body: unknown,
  policy: ImagePolicy,
) {
  z.uuid().parse(jobId);
  const input = imageRecoverySchema.parse(body),
    requestHash = fingerprint({ jobId, evidence: input.evidence });
  if (policy.generationMode !== 'owner')
    fail(409, 'IMAGE_RECOVERY_OWNER_REQUIRED', 'IMAGE_RECOVERY_OWNER_REQUIRED');
  const peek = (
    await c.query(
      'SELECT r.scope_id,j.actor_id FROM image_generation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.id=$1',
      [jobId],
    )
  ).rows[0];
  if (!peek || peek.actor_id !== actorId) fail(404, 'NOT_FOUND', 'NOT_FOUND');
  if (peek.scope_id !== policy.scopeId)
    fail(409, 'IMAGE_RECOVERY_SCOPE_MISMATCH', 'IMAGE_RECOVERY_SCOPE_MISMATCH');
  const authorizations = (
    await c.query(
      'SELECT * FROM live_test_sessions WHERE scope_id=$1 ORDER BY id FOR NO KEY UPDATE',
      [peek.scope_id],
    )
  ).rows;
  const owner = authorizations.find((a) => a.mode === 'owner' && a.owner_id === actorId);
  if (!owner || (owner.id !== policy.generationAuthorizationId && policy.generationAuthorizationId))
    fail(403, 'FORBIDDEN', 'FORBIDDEN');
  const scope = (
    await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [peek.scope_id])
  ).rows[0];
  await fenceGenerationAdmission(c);
  const prior = (
    await c.query(
      'SELECT * FROM image_generation_recoveries WHERE authorization_id=$1 AND operation_id=$2',
      [owner.id, input.operationId],
    )
  ).rows[0];
  if (prior) {
    if (prior.job_id !== jobId || prior.request_hash !== requestHash)
      fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
    return {
      status: 'recovered' as const,
      actualMicros: Number(prior.actual_micros),
      automaticRetry: false,
    };
  }
  const revision = (
    await c.query(
      'SELECT profile_hash,config_fingerprint FROM generation_policy_revisions WHERE authorization_id=$1 AND revision=$2',
      [owner.id, owner.policy_revision],
    )
  ).rows[0];
  if (
    !revision ||
    revision.config_fingerprint !== policy.generationConfigFingerprint ||
    revision.profile_hash !== owner.config_hash ||
    revision.profile_hash !== owner.policy_hash ||
    (policy.generationPolicyHash && owner.policy_hash !== policy.generationPolicyHash)
  )
    fail(409, 'STALE_STATE', 'STALE_STATE');
  const durable = scope?.stop_epoch_id != null || owner.stop_epoch_id != null;
  if (
    owner.state !== 'stopped' ||
    owner.stop_code !== (durable ? MODEL_REJECTION_STOP : 'IMAGE_RESULT_UNKNOWN') ||
    !scope?.blocked
  )
    fail(409, 'IMAGE_RECOVERY_STOP_MISMATCH', 'IMAGE_RECOVERY_STOP_MISMATCH');
  const job = (await c.query('SELECT * FROM image_generation_jobs WHERE id=$1 FOR UPDATE', [jobId]))
    .rows[0];
  const attempt = (
    await c.query('SELECT * FROM image_generation_attempts WHERE job_id=$1 FOR UPDATE', [jobId])
  ).rows[0];
  if (
    !attempt ||
    attempt.result_received_at !== null ||
    attempt.actual_micros !== null ||
    job.mode !== 'external' ||
    job.status !== 'unknown' ||
    job.actual_micros !== null ||
    !isRecoverableModelRejection(job.safe_diagnostic) ||
    job.safe_diagnostic.requestId !== input.evidence.requestId
  )
    fail(409, 'IMAGE_RECOVERY_EVIDENCE_REQUIRED', 'IMAGE_RECOVERY_EVIDENCE_REQUIRED');
  const reservation = (
    await c.query('SELECT * FROM generation_budget_reservations WHERE id=$1 FOR UPDATE', [
      job.reservation_id,
    ])
  ).rows[0];
  if (
    reservation.status !== 'held' ||
    reservation.actor_id !== actorId ||
    input.evidence.actualMicros > Number(reservation.upper_micros)
  )
    fail(409, 'IMAGE_RECOVERY_COST_REQUIRES_REVIEW', 'IMAGE_RECOVERY_COST_REQUIRES_REVIEW');
  let stopEvidence: unknown = null;
  if (durable) {
    const deny = () =>
      fail(
        409,
        'IMAGE_RECOVERY_DURABLE_STOP_REQUIRES_REVIEW',
        'IMAGE_RECOVERY_DURABLE_STOP_REQUIRES_REVIEW',
      );
    const evidenceHash = modelRejectionEvidenceHash(job, attempt.dispatch_id, job.safe_diagnostic);
    if (
      !evidenceHash ||
      !owner.stop_epoch_id ||
      !scope.stop_epoch_id ||
      owner.expires_at !== null ||
      !scope.approved ||
      !scope.serialize_outstanding ||
      !policy.ownerImageProfile ||
      !ownerPricingIsCurrent(policy.ownerImageProfile.pricing) ||
      !policy.approved ||
      !policy.externalEnabled ||
      (policy.externalExpiresAt && Date.parse(policy.externalExpiresAt) <= Date.now()) ||
      job.cancel_requested ||
      job.error_code !== 'DISPATCH_UNCERTAIN' ||
      job.provider_request_id !== input.evidence.requestId ||
      attempt.provider_request_id !== input.evidence.requestId ||
      attempt.request_hash !== job.request_hash ||
      reservation.kind !== 'image' ||
      reservation.scope_id !== scope.id ||
      String(job.upper_micros) !== String(reservation.upper_micros) ||
      job.generation_policy_revision !== owner.policy_revision ||
      job.generation_policy_hash !== owner.policy_hash ||
      String(owner.cap_micros) !== String(scope.total_cap_micros) ||
      String(owner.image_cap_micros) !== String(scope.image_cap_micros) ||
      String(owner.text_cap_micros) !== String(scope.text_cap_micros) ||
      ['total', 'image', 'text'].some(
        (kind) =>
          String(scope[`${kind}_cap_micros`]) !==
          String(
            policy[`${kind}CapMicros` as 'totalCapMicros' | 'imageCapMicros' | 'textCapMicros'],
          ),
      )
    )
      deny();
    // NOWAIT avoids inversion with erasure/source writers while freezing current access.
    const user = (
      await c.query('SELECT id,deleted_at,handle FROM users WHERE id=$1 FOR SHARE NOWAIT', [
        actorId,
      ])
    ).rows[0];
    const source = (
      await c.query(
        'SELECT id,owner_id,status,deleted_at FROM adventures WHERE id=$1 FOR SHARE NOWAIT',
        [job.adventure_id],
      )
    ).rows[0];
    const quote = (
      await c.query('SELECT * FROM image_generation_quotes WHERE id=$1 FOR SHARE NOWAIT', [
        job.quote_id,
      ])
    ).rows[0];
    if (
      !user ||
      user.deleted_at !== null ||
      user.handle !== owner.owner_handle ||
      !source ||
      source.owner_id !== actorId ||
      source.status === 'archived' ||
      source.deleted_at !== null ||
      !quote ||
      quote.actor_id !== actorId ||
      quote.adventure_id !== job.adventure_id ||
      quote.request_hash !== job.request_hash ||
      quote.mode !== 'external'
    )
      deny();
    stopEvidence = await modelRejectionGateHistory(
      c,
      owner,
      scope,
      new Map([[jobId, evidenceHash!]]),
    );
    if (!stopEvidence) deny();
  }
  const otherLiabilities = (
    await c.query(
      `SELECT 1 FROM generation_budget_reservations WHERE scope_id=$1 AND id<>$2 AND
    (status='held' OR (status='settled' AND (actual_micros IS NULL OR actual_micros>upper_micros)))
    UNION ALL SELECT 1 FROM live_test_sessions WHERE scope_id=$1 AND id<>$3 AND state='stopped'
      AND COALESCE(stop_code,'') NOT IN ('OWNER_GENERATION_MODE_ACTIVE')
    UNION ALL SELECT 1 FROM generation_text_counts WHERE status IN ('dispatched','unknown')
    UNION ALL SELECT 1 FROM live_test_text_permits p JOIN live_test_sessions a ON a.id=p.session_id
      WHERE a.scope_id=$1 AND (p.state IN ('authorized','dispatched','unknown') OR p.result_code='PROVIDER_HTTP_403')
    UNION ALL SELECT 1 FROM live_authoring_text_jobs j JOIN live_test_sessions a ON a.id=j.session_id
      WHERE a.scope_id=$1 AND (j.status IN ('queued','dispatched','generated','unknown') OR j.error_code='PROVIDER_HTTP_403')
    UNION ALL SELECT 1 FROM npc_ai_jobs n JOIN live_test_sessions a ON a.id=n.generation_authorization_id
      WHERE a.scope_id=$1 AND n.provider_external IS DISTINCT FROM false
      AND (n.provider_budget_status='unknown' OR n.result_code='PROVIDER_HTTP_403' OR
        n.status IN ('queued','reserved','running','result_received','validated','reconciling'))
    UNION ALL SELECT 1 FROM image_generation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id
      WHERE r.scope_id=$1 AND j.id<>$4 AND j.mode='external' AND j.status IN ('queued','dispatched','unknown','generated')
    LIMIT 1`,
      [scope.id, reservation.id, owner.id, jobId],
    )
  ).rowCount;
  if (otherLiabilities)
    fail(409, 'GENERATION_PRIOR_LIABILITY_UNRESOLVED', 'GENERATION_PRIOR_LIABILITY_UNRESOLVED');
  const usage = (
    await c.query(
      `SELECT COALESCE(sum(actual_micros),0) total,
    COALESCE(sum(CASE WHEN kind='image' THEN actual_micros ELSE 0 END),0) image
    FROM generation_budget_reservations WHERE scope_id=$1 AND status='settled'`,
      [scope.id],
    )
  ).rows[0];
  if (
    Number(usage.total) + input.evidence.actualMicros > Number(scope.total_cap_micros) ||
    Number(usage.image) + input.evidence.actualMicros > Number(scope.image_cap_micros)
  )
    fail(409, 'GENERATION_BUDGET_EXCEEDED', 'GENERATION_BUDGET_EXCEEDED');
  const currentFingerprint = fingerprint({
    jobId,
    requestHash,
    config: owner.config_hash,
    policy: owner.policy_hash,
    revision: owner.policy_revision,
    scope,
    usage,
    reservationId: reservation.id,
    hold: reservation.upper_micros,
    stopEvidence,
  });
  if (input.mode === 'review')
    return {
      status: 'reviewed' as const,
      fingerprint: currentFingerprint,
      heldMicros: Number(reservation.upper_micros),
      actualMicros: input.evidence.actualMicros,
      automaticRetry: false,
    };
  if (input.expectedFingerprint !== currentFingerprint) fail(409, 'STALE_STATE', 'STALE_STATE');
  await c.query(
    `INSERT INTO image_generation_recoveries(id,authorization_id,scope_id,job_id,operation_id,
    request_hash,actual_micros,evidence,original_job) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      randomUUID(),
      owner.id,
      scope.id,
      jobId,
      input.operationId,
      requestHash,
      input.evidence.actualMicros,
      input.evidence,
      {
        status: job.status,
        errorCode: job.error_code,
        safeDiagnostic: job.safe_diagnostic,
        providerRequestId: job.provider_request_id,
        stopEvidence,
      },
    ],
  );
  await settleGenerationSpend(c, reservation.id, input.evidence.actualMicros);
  // Retain original diagnostic/error and attempt. This is a confirmed rejection, never a generated image.
  await c.query(
    "UPDATE image_generation_jobs SET status='rejected',actual_micros=$2,quota_reserved_bytes=0,updated_at=now() WHERE id=$1",
    [jobId, input.evidence.actualMicros],
  );
  await c.query("UPDATE live_test_sessions SET state='active',stop_code=NULL WHERE id=$1", [
    owner.id,
  ]);
  await c.query('UPDATE generation_budget_scopes SET blocked=false WHERE id=$1', [scope.id]);
  await c.query(
    "INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,'image_rejection_recovered',$2,$3)",
    [
      actorId,
      jobId,
      {
        recovery: 'owner_attested_external_billing',
        actualMicros: input.evidence.actualMicros,
        scopeId: scope.id,
        automaticRetry: false,
      },
    ],
  );
  return {
    status: 'recovered' as const,
    actualMicros: input.evidence.actualMicros,
    automaticRetry: false,
  };
}
