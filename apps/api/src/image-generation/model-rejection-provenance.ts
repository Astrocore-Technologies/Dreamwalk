import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { normalizeSafeImageDiagnostic } from './error-diagnostics';

export const MODEL_REJECTION_STOP = 'IMAGE_MODEL_ACCESS_REJECTION';
/** Binds only safe native identity and the bounded provider-reported rejection.
 * This is NOT billing evidence and never authorizes automatic recovery. */
export function modelRejectionEvidenceHash(
  job: QueryResultRow,
  dispatchId: string,
  diagnostic: unknown,
): string | undefined {
  const d = normalizeSafeImageDiagnostic(diagnostic);
  if (
    !d ||
    d.httpStatus !== 403 ||
    d.category !== 'model_access' ||
    !['model_not_found', 'model_access_denied'].includes(d.providerCode ?? '') ||
    !d.requestId ||
    !dispatchId ||
    !job.id ||
    !job.actor_id ||
    !job.reservation_id ||
    !job.request_hash
  )
    return undefined;
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 'image-model-rejection-v1',
        jobId: job.id,
        actorId: job.actor_id,
        reservationId: job.reservation_id,
        dispatchId,
        requestHash: job.request_hash,
        diagnostic: {
          httpStatus: d.httpStatus,
          category: d.category,
          providerCode: d.providerCode,
          providerType: d.providerType ?? null,
          requestId: d.requestId,
          evidence: d.evidence,
          billing: d.billing,
        },
      }),
    )
    .digest('hex');
}

export function exactModelRejectionEpoch(
  epoch: QueryResultRow | undefined,
  events: QueryResultRow[],
  kind: 'scope' | 'authorization',
  targetId: string,
  owner: QueryResultRow,
  jobId: string,
  evidenceHash: string,
) {
  return (
    !!epoch &&
    epoch.baseline_unknown === false &&
    epoch.target_kind === kind &&
    epoch.target_id === targetId &&
    events.length > 0 &&
    events.length <= 500 &&
    events.every(
      (event) =>
        String(event.epoch_id) === String(epoch.id) &&
        event.reason === MODEL_REJECTION_STOP &&
        event.cause_code === MODEL_REJECTION_STOP &&
        event.stop_class === 'authorization' &&
        event.recoverable === false &&
        event.source_kind === 'image' &&
        event.source_id === jobId &&
        event.authorization_id === owner.id &&
        event.scope_id === owner.scope_id &&
        event.policy_revision === owner.policy_revision &&
        event.policy_hash === owner.policy_hash &&
        event.config_hash === owner.config_hash &&
        event.evidence_hash === evidenceHash,
    )
  );
}

/** Complete current gate history, shared by explicit recovery and retained-hold
 * admission. Neither caller can reinterpret generic HTTP or unrelated stops. */
export async function modelRejectionGateHistory(
  c: import('pg').PoolClient,
  owner: QueryResultRow,
  scope: QueryResultRow,
  sources: Map<string, string>,
): Promise<
  { evidenceHash: string; history: { epochId: string; eventIds: string[] }[] } | undefined
> {
  if (!owner.stop_epoch_id || !scope.stop_epoch_id || owner.expires_at !== null || !sources.size)
    return undefined;
  const history = [];
  for (const [kind, target, epochId] of [
    ['authorization', owner.id, owner.stop_epoch_id],
    ['scope', scope.id, scope.stop_epoch_id],
  ] as const) {
    const epoch = (await c.query('SELECT * FROM generation_stop_epochs WHERE id=$1', [epochId]))
      .rows[0];
    const events = (
      await c.query(
        'SELECT * FROM generation_stop_events WHERE epoch_id=$1 ORDER BY id LIMIT 501',
        [epochId],
      )
    ).rows;
    if (!events.length || events.length > 500 || events.some((e) => !sources.has(e.source_id)))
      return undefined;
    for (const [jobId, hash] of sources) {
      if (
        !exactModelRejectionEpoch(
          epoch,
          events.filter((e) => e.source_id === jobId),
          kind,
          target,
          owner,
          jobId,
          hash,
        )
      )
        return undefined;
    }
    history.push({ epochId, eventIds: events.map((e) => e.id) });
  }
  const others = (
    await c.query(
      'SELECT * FROM live_test_sessions WHERE scope_id=$1 AND id<>$2 ORDER BY id LIMIT 501',
      [scope.id, owner.id],
    )
  ).rows;
  if (others.length > 500) return undefined;
  for (const other of others) {
    if (
      other.owner_id !== owner.owner_id ||
      other.mode !== 'manual' ||
      other.state !== 'stopped' ||
      other.stop_code !== 'OWNER_GENERATION_MODE_ACTIVE'
    )
      return undefined;
    if (other.stop_epoch_id == null) continue;
    const epoch = (
      await c.query('SELECT * FROM generation_stop_epochs WHERE id=$1', [other.stop_epoch_id])
    ).rows[0];
    const events = (
      await c.query(
        'SELECT * FROM generation_stop_events WHERE epoch_id=$1 ORDER BY id LIMIT 501',
        [other.stop_epoch_id],
      )
    ).rows;
    if (
      !epoch ||
      epoch.baseline_unknown !== false ||
      epoch.target_kind !== 'authorization' ||
      epoch.target_id !== other.id ||
      !events.length ||
      events.length > 500 ||
      events.some(
        (e) =>
          e.reason !== 'OWNER_GENERATION_MODE_ACTIVE' ||
          e.source_kind !== 'policy' ||
          e.authorization_id !== other.id ||
          e.scope_id !== scope.id,
      )
    )
      return undefined;
  }
  return {
    evidenceHash: createHash('sha256')
      .update(JSON.stringify([...sources].sort()))
      .digest('hex'),
    history,
  };
}
