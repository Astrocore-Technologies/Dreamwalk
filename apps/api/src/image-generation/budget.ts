import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { fail } from '../errors';
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
    (!mock && (!policy.approved || !policy.externalEnabled || policy.verifiedUpperMicros === null))
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
  if (scope.blocked || (!mock && !scope.approved))
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
  const usage = (
    await c.query(
      "SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END),0) AS total,COALESCE(sum(CASE WHEN kind=$2 THEN CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END ELSE 0 END),0) AS purpose FROM generation_budget_reservations WHERE scope_id=$1",
      [policy.scopeId, kind],
    )
  ).rows[0];
  if (
    Number(usage.total) + upperMicros > Number(scope.total_cap_micros) ||
    Number(usage.purpose) + upperMicros > Number(scope[`${kind}_cap_micros`])
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
