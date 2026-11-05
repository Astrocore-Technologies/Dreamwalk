import {
  MODEL_REJECTION_STOP,
  modelRejectionEvidenceHash,
  modelRejectionGateHistory,
} from './model-rejection-provenance';
import type { PoolClient } from 'pg';
import { normalizeSafeImageDiagnostic } from './error-diagnostics';
export type RetainedRejectionAdmission = {
  eligible: boolean;
  reservationIds: string[];
  retainedMicros: number;
  activeHeldMicros: number;
};
const denied = (): RetainedRejectionAdmission => ({
  eligible: false,
  reservationIds: [],
  retainedMicros: 0,
  activeHeldMicros: 0,
});
/** A confirmed model-access refusal is not a generated artifact or a billing receipt.
 * Its full hold is retained. Only a distinct consented image request may use the remaining cap.
 * Caller holds authorization -> scope locks for admission; read-only status may use a snapshot. */
export async function retainedModelRejectionAdmission(
  c: PoolClient,
  owner: Record<string, unknown> | undefined,
  scope: Record<string, unknown> | undefined,
): Promise<RetainedRejectionAdmission> {
  if (
    !owner ||
    !scope ||
    owner.mode !== 'owner' ||
    owner.state !== 'stopped' ||
    owner.stop_code !==
      (owner.stop_epoch_id != null || scope.stop_epoch_id != null
        ? MODEL_REJECTION_STOP
        : 'IMAGE_RESULT_UNKNOWN') ||
    !scope.blocked ||
    !scope.approved ||
    !scope.serialize_outstanding ||
    owner.scope_id !== scope.id
  )
    return denied();
  const others = (
    await c.query(
      `SELECT 1 FROM live_test_sessions WHERE scope_id=$1 AND id<>$2 AND state='stopped'
   AND COALESCE(stop_code,'')<>'OWNER_GENERATION_MODE_ACTIVE'
 UNION ALL SELECT 1 FROM live_test_text_permits p JOIN live_test_sessions a ON a.id=p.session_id
   WHERE a.scope_id=$1 AND (p.state IN ('authorized','dispatched','unknown') OR p.result_code='PROVIDER_HTTP_403')
 UNION ALL SELECT 1 FROM live_authoring_text_jobs j JOIN live_test_sessions a ON a.id=j.session_id
   WHERE a.scope_id=$1 AND (j.status IN ('queued','dispatched','unknown') OR j.error_code='PROVIDER_HTTP_403')
 UNION ALL SELECT 1 FROM generation_text_counts WHERE status IN ('dispatched','unknown')
 UNION ALL SELECT 1 FROM npc_ai_jobs n JOIN live_test_sessions a ON a.id=n.generation_authorization_id
   WHERE a.scope_id=$1 AND n.provider_external IS DISTINCT FROM false AND
   (n.provider_budget_status='unknown' OR n.result_code='PROVIDER_HTTP_403' OR n.status IN ('running','result_received','validated','reconciling'))
 LIMIT 1`,
      [scope.id, owner.id],
    )
  ).rowCount;
  if (others) return denied();
  const durable = owner.stop_epoch_id != null || scope.stop_epoch_id != null;
  const proven = new Map<string, string>();
  // The status projection runs in database-enforced READ ONLY repeatable-read.
  // Actual admission transactions always take the fail-fast source locks.
  const snapshotOnly =
    durable && (await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only === 'on';
  const lock = snapshotOnly ? '' : ' FOR SHARE NOWAIT';
  if (durable) {
    const user = (
      await c.query('SELECT handle,deleted_at FROM users WHERE id=$1' + lock, [owner.owner_id])
    ).rows[0];
    if (!user || user.deleted_at !== null || user.handle !== owner.owner_handle) return denied();
    const locked = (
      await c.query(
        'SELECT j.id FROM image_generation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE r.scope_id=$1 ORDER BY j.id LIMIT 501' +
          (snapshotOnly ? '' : ' FOR SHARE OF j NOWAIT'),
        [scope.id],
      )
    ).rows;
    if (locked.length > 500) return denied();
    await c.query(
      'SELECT job_id FROM image_generation_attempts WHERE job_id=ANY($1::uuid[]) ORDER BY job_id' +
        lock,
      [locked.map((j) => j.id)],
    );
  }

  const rows = (
    await c.query(
      `SELECT r.*,j.id job_id,j.status job_status,j.mode job_mode,j.safe_diagnostic,j.dispatch_deadline,
 a.job_id attempt_job_id,a.result_received_at,a.actual_micros attempt_actual,
 j.actor_id job_actor_id,j.reservation_id,j.request_hash,j.cancel_requested,j.error_code,j.quote_id,
 j.generation_policy_revision,j.generation_policy_hash,j.provider_request_id,j.adventure_id,
 a.dispatch_id,a.request_hash attempt_request_hash,a.provider_request_id attempt_request_id
 FROM generation_budget_reservations r LEFT JOIN image_generation_jobs j ON j.reservation_id=r.id
 LEFT JOIN image_generation_attempts a ON a.job_id=j.id WHERE r.scope_id=$1 ORDER BY r.id LIMIT 501`,
      [scope.id],
    )
  ).rows;
  if (rows.length > 500) return denied();
  const result: RetainedRejectionAdmission = {
    eligible: false,
    reservationIds: [],
    retainedMicros: 0,
    activeHeldMicros: 0,
  };
  let pending = 0,
    total = 0,
    image = 0;
  for (const row of rows) {
    if (row.actor_id !== owner.owner_id) return denied();
    const upper = Number(row.upper_micros),
      actual = row.actual_micros === null ? null : Number(row.actual_micros);
    if (
      !Number.isSafeInteger(upper) ||
      upper < 0 ||
      (actual !== null && (!Number.isSafeInteger(actual) || actual < 0 || actual > upper))
    )
      return denied();
    if (
      (row.status === 'settled' && actual === null) ||
      (row.status === 'released' && actual !== null && actual > 0)
    )
      return denied();
    const accounted = row.status === 'held' ? upper : row.status === 'settled' ? actual! : 0;
    total += accounted;
    if (row.kind === 'image') image += accounted;
    if (row.job_status === 'unknown' && row.status !== 'held') return denied();
    if (row.status !== 'held') continue;
    if (row.kind !== 'image' || row.job_mode !== 'external' || !row.job_id || actual !== null)
      return denied();
    if (row.job_status === 'unknown') {
      const d = normalizeSafeImageDiagnostic(row.safe_diagnostic);
      if (
        !d ||
        d.httpStatus !== 403 ||
        d.category !== 'model_access' ||
        !['model_not_found', 'model_access_denied'].includes(d.providerCode ?? '') ||
        !d.requestId ||
        !row.attempt_job_id ||
        row.result_received_at !== null ||
        row.attempt_actual !== null
      )
        return denied();
      if (durable) {
        const hash = modelRejectionEvidenceHash(
          { ...row, id: row.job_id, actor_id: row.job_actor_id },
          row.dispatch_id,
          row.safe_diagnostic,
        );
        if (
          !hash ||
          row.job_actor_id !== owner.owner_id ||
          row.cancel_requested ||
          row.error_code !== 'DISPATCH_UNCERTAIN' ||
          row.provider_request_id !== d.requestId ||
          row.attempt_request_id !== d.requestId ||
          row.attempt_request_hash !== row.request_hash ||
          row.generation_policy_revision !== owner.policy_revision ||
          row.generation_policy_hash !== owner.policy_hash
        )
          return denied();
        const source = (
          await c.query('SELECT owner_id,status,deleted_at FROM adventures WHERE id=$1' + lock, [
            row.adventure_id,
          ])
        ).rows[0];
        if (
          !source ||
          source.owner_id !== owner.owner_id ||
          source.status === 'archived' ||
          source.deleted_at !== null
        )
          return denied();
        const quote = (
          await c.query(
            'SELECT actor_id,adventure_id,request_hash,mode FROM image_generation_quotes WHERE id=$1' +
              lock,
            [row.quote_id],
          )
        ).rows[0];
        if (
          !quote ||
          quote.actor_id !== owner.owner_id ||
          quote.adventure_id !== row.adventure_id ||
          quote.request_hash !== row.request_hash ||
          quote.mode !== 'external'
        )
          return denied();
        proven.set(row.job_id, hash);
      }
      result.reservationIds.push(row.id);
      result.retainedMicros += upper;
    } else if (
      row.job_status === 'queued' ||
      (row.job_status === 'dispatched' &&
        row.dispatch_deadline &&
        new Date(row.dispatch_deadline).getTime() > Date.now())
    ) {
      pending++;
      result.activeHeldMicros += upper;
    } else return denied();
  }
  if (
    !result.reservationIds.length ||
    pending > 1 ||
    total > Math.min(Number(scope.total_cap_micros), Number(owner.cap_micros)) ||
    image > Math.min(Number(scope.image_cap_micros), Number(owner.image_cap_micros))
  )
    return denied();
  if (durable && !(await modelRejectionGateHistory(c, owner, scope, proven))) return denied();
  result.eligible = true;
  return result;
}
