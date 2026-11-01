import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { fail } from '../errors';
import { retainedModelRejectionAdmission } from './retained-rejections';
import { fenceGenerationAdmission } from '../generation/scope-fence';
import type { ImagePolicy } from './contracts';
/** Shared total+purpose ledger. Any future live text caller must use this same authorization scope. */
export async function reserveGenerationSpend(
  c: PoolClient,
  policy: ImagePolicy,
  actorId: string,
  kind: 'text' | 'image',
  operationKey: string,
  upperMicros: number,
  mock = false,
) {
  if (
    !Number.isSafeInteger(upperMicros) ||
    upperMicros < 0 ||
    (!mock &&
      (!policy.approved ||
        !policy.externalEnabled ||
        (policy.verifiedUpperMicros === null &&
          !(
            policy.costBasis === 'approved_estimate' &&
            policy.operationalReserveMicros === upperMicros
          ))))
  )
    fail(409, 'LIVE_COST_BOUND_REQUIRED', 'LIVE_COST_BOUND_REQUIRED');
  await c.query(
    'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,image_cap_micros,text_cap_micros) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [
      policy.scopeId,
      policy.approved,
      policy.totalCapMicros,
      policy.imageCapMicros,
      policy.textCapMicros,
    ],
  );
  const scope = (
    await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [policy.scopeId])
  ).rows[0];
  if (!mock) {
    await fenceGenerationAdmission(c);
    // A pre-existing ordinary authority prevents reviving a legacy allowance under
    // another scope, actor or provider mode. This read takes no foreign row locks.
    const owner = (
      await c.query("SELECT * FROM live_test_sessions WHERE mode='owner' ORDER BY id LIMIT 1")
    ).rows[0];
    if (
      owner &&
      (owner.scope_id !== policy.scopeId ||
        owner.owner_id !== actorId ||
        policy.generationMode !== 'owner' ||
        policy.generationAuthorizationId !== owner.id)
    )
      fail(409, 'GENERATION_AUTHORITY_IMMUTABLE', 'GENERATION_AUTHORITY_IMMUTABLE');
  }
  let retainedIds: string[] = [];
  if (
    !mock &&
    kind === 'image' &&
    policy.generationMode === 'owner' &&
    policy.preserveModelRejectionHolds === true
  ) {
    const owner = (
      await c.query(
        'SELECT * FROM live_test_sessions WHERE id=$1 AND scope_id=$2 AND owner_id=$3',
        [policy.generationAuthorizationId, policy.scopeId, actorId],
      )
    ).rows[0];
    if (
      owner &&
      Number(owner.policy_revision) === policy.generationPolicyRevision &&
      owner.policy_hash === policy.generationPolicyHash
    ) {
      const admission = await retainedModelRejectionAdmission(c, owner, scope);
      if (admission.eligible) retainedIds = admission.reservationIds;
    }
  }
  if ((scope.blocked && !retainedIds.length) || (!mock && !scope.approved))
    fail(409, 'GENERATION_BUDGET_BLOCKED', 'GENERATION_BUDGET_BLOCKED');
  const prior = (
    await c.query(
      'SELECT * FROM generation_budget_reservations WHERE scope_id=$1 AND operation_key=$2',
      [policy.scopeId, operationKey],
    )
  ).rows[0];
  if (prior) {
    if (
      prior.actor_id !== actorId ||
      prior.kind !== kind ||
      Number(prior.upper_micros) !== upperMicros
    )
      fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
    return prior.id as string;
  }
  if (policy.costBasis === 'approved_estimate' && !scope.serialize_outstanding) {
    await c.query('UPDATE generation_budget_scopes SET serialize_outstanding=true WHERE id=$1', [
      policy.scopeId,
    ]);
    scope.serialize_outstanding = true;
  }
  if (
    scope.serialize_outstanding &&
    (
      await c.query(
        "SELECT 1 FROM generation_budget_reservations WHERE scope_id=$1 AND status='held' AND NOT(id=ANY($2::uuid[])) LIMIT 1",
        [policy.scopeId, retainedIds],
      )
    ).rowCount
  )
    fail(409, 'GENERATION_OUTSTANDING_REQUEST', 'GENERATION_OUTSTANDING_REQUEST');
  const usage = (
    await c.query(
      "SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END),0) AS total,COALESCE(sum(CASE WHEN kind=$2 THEN CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END ELSE 0 END),0) AS purpose FROM generation_budget_reservations WHERE scope_id=$1",
      [policy.scopeId, kind],
    )
  ).rows[0];
  if (
    Number(usage.total) + upperMicros >
      Math.min(Number(scope.total_cap_micros), policy.totalCapMicros) ||
    Number(usage.purpose) + upperMicros >
      Math.min(
        Number(scope[`${kind}_cap_micros`]),
        kind === 'image' ? policy.imageCapMicros : policy.textCapMicros,
      )
  )
    fail(409, 'GENERATION_BUDGET_EXCEEDED', 'GENERATION_BUDGET_EXCEEDED');
  const id = randomUUID();
  await c.query(
    "INSERT INTO generation_budget_reservations(id,scope_id,actor_id,kind,operation_key,upper_micros,status) VALUES($1,$2,$3,$4,$5,$6,'held')",
    [id, policy.scopeId, actorId, kind, operationKey, upperMicros],
  );
  return id;
}
export async function settleGenerationSpend(c: PoolClient, id: string, actualMicros: number) {
  const initial = (
    await c.query('SELECT scope_id FROM generation_budget_reservations WHERE id=$1', [id])
  ).rows[0];
  if (!initial) return;
  await c.query('SELECT id FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [
    initial.scope_id,
  ]);
  const row = (
    await c.query('SELECT * FROM generation_budget_reservations WHERE id=$1 FOR UPDATE', [id])
  ).rows[0];
  if (!Number.isSafeInteger(actualMicros) || actualMicros < 0)
    fail(400, 'INVALID_COST', 'INVALID_COST');
  if (row.status === 'settled') {
    if (Number(row.actual_micros) !== actualMicros) fail(409, 'COST_CONFLICT', 'COST_CONFLICT');
    return;
  }
  // A late actual bill is never discarded merely because a prior release was recorded.
  await c.query(
    "UPDATE generation_budget_reservations SET status='settled',actual_micros=$2 WHERE id=$1",
    [id, actualMicros],
  );
  if (actualMicros > Number(row.upper_micros) || (row.status === 'released' && actualMicros > 0))
    await c.query('UPDATE generation_budget_scopes SET blocked=true WHERE id=$1', [row.scope_id]);
}
export async function releaseUndispatchedGenerationSpend(c: PoolClient, id: string) {
  const initial = (
    await c.query('SELECT scope_id FROM generation_budget_reservations WHERE id=$1', [id])
  ).rows[0];
  if (!initial) return;
  await c.query('SELECT id FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [
    initial.scope_id,
  ]);
  const row = (
    await c.query('SELECT * FROM generation_budget_reservations WHERE id=$1 FOR UPDATE', [id])
  ).rows[0];
  if (
    (
      await c.query(
        'SELECT 1 FROM image_generation_attempts a JOIN image_generation_jobs j ON j.id=a.job_id WHERE j.reservation_id=$1',
        [id],
      )
    ).rowCount
  )
    fail(409, 'DISPATCHED_RESERVE_MUST_REMAIN', 'DISPATCHED_RESERVE_MUST_REMAIN');
  if (row.status === 'held')
    await c.query(
      "UPDATE generation_budget_reservations SET status='released' WHERE id=$1 AND status='held'",
      [id],
    );
}
