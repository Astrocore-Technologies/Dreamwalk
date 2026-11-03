import { currentReleaseDeployment } from './release-deployment';
/** Server-controlled profile refresh. Never rewrites jobs, reservations or customer holds. */
import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { ReleaseGenerationConfig } from './config';
import { digest } from '../ai/context';
import { fail } from '../errors';

function snapshot(config: ReleaseGenerationConfig) {
  const { configFingerprint: _fingerprint, ...profile } = config;
  void _fingerprint;
  return structuredClone(profile);
}
/** Read-only prediction for quote-facing status. The mutation repeats these checks under locks. */
export async function releaseProfileProjection(
  c: Pick<PoolClient, 'query'>,
  row: QueryResultRow,
  scope: QueryResultRow,
  config: ReleaseGenerationConfig,
) {
  const epoch = await currentReleaseDeployment(c, config);
  if (row.policy_hash !== row.config_hash || Number(row.policy_revision) < 1)
    fail(409, 'GENERATION_POLICY_CHANGED', 'GENERATION_POLICY_CHANGED');
  const saved = (
    await c.query(
      'SELECT * FROM generation_policy_revisions WHERE authorization_id=$1 AND revision=$2 AND profile_hash=$3 AND config_fingerprint=$4',
      [row.id, row.policy_revision, row.policy_hash, row.config_hash],
    )
  ).rows[0];
  // The original release schema did not save revision one. Do not invent its profile.
  if (Number(row.policy_revision) > 1 && !saved)
    fail(409, 'GENERATION_POLICY_CHANGED', 'GENERATION_POLICY_CHANGED');
  const equalCap = (actual: unknown, expected: number | null) =>
    expected === null ? actual === null : actual !== null && String(actual) === String(expected);
  if (
    row.unlimited_allowance !== (config.allowance === 'unlimited') ||
    scope.unlimited_allowance !== (config.allowance === 'unlimited') ||
    !equalCap(row.cap_micros, config.totalCapMicros) ||
    !equalCap(scope.total_cap_micros, config.totalCapMicros) ||
    !equalCap(row.text_cap_micros, config.textCapMicros) ||
    !equalCap(scope.text_cap_micros, config.textCapMicros) ||
    !equalCap(row.image_cap_micros, config.imageCapMicros) ||
    !equalCap(scope.image_cap_micros, config.imageCapMicros) ||
    (saved && saved.profile_snapshot.aggregateCapMicros !== config.aggregateCapMicros)
  )
    fail(
      409,
      'GENERATION_RELEASE_LIMIT_CHANGE_UNSUPPORTED',
      'GENERATION_RELEASE_LIMIT_CHANGE_UNSUPPORTED',
    );
  return {
    revision:
      Number(row.policy_revision) +
      (row.config_hash === config.configFingerprint && String(row.release_profile_epoch) === epoch
        ? 0
        : 1),
    epoch,
    hash: config.configFingerprint,
    saved,
  };
}
/** Caller holds authorization, scope, admission fence and enabled wallet locks, in that order.
 * Active work is not a profile-refresh blocker: its immutable financial evidence stays pinned.
 * Dispatch still compares its own quote/job revision against the current one. */
export async function refreshReleaseProfile(
  c: PoolClient,
  row: QueryResultRow,
  scope: QueryResultRow,
  config: ReleaseGenerationConfig,
) {
  const next = await releaseProfileProjection(c, row, scope, config);
  if (next.revision === Number(row.policy_revision) && next.saved) return row;
  const changed = next.revision !== Number(row.policy_revision);
  const operationId = randomUUID();
  await c.query(
    `INSERT INTO generation_policy_revisions(id,authorization_id,scope_id,revision,profile_hash,config_fingerprint,previous_hash,profile_snapshot,operation_id,request_hash,release_profile_epoch)
     VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      row.id,
      row.scope_id,
      next.revision,
      next.hash,
      changed ? row.policy_hash : null,
      JSON.stringify(snapshot(config)),
      operationId,
      digest({
        authorizationId: row.id,
        revision: next.revision,
        fingerprint: next.hash,
        epoch: next.epoch,
      }),
      next.epoch,
    ],
  );
  if (changed) {
    await c.query(
      'UPDATE live_test_sessions SET config_hash=$2,policy_hash=$2,policy_revision=$3,release_profile_epoch=$4 WHERE id=$1',
      [row.id, next.hash, next.revision, next.epoch],
    );
    await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
      row.owner_id,
      'generation.release-policy.refresh',
      row.id,
      JSON.stringify({
        source: 'server_configuration',
        revision: next.revision,
        previousHash: row.policy_hash,
        hash: next.hash,
      }),
    ]);
  }
  return {
    ...row,
    config_hash: next.hash,
    policy_hash: next.hash,
    policy_revision: next.revision,
    release_profile_epoch: next.epoch,
  };
}
