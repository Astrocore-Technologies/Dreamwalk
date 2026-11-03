/** Explicit administrator-reviewed adoption. Never repairs historical financial rows. */
import { randomUUID } from 'node:crypto';
import type { ReleasePolicyReview, ReleasePolicyReceipt } from '@dreamwalk/contracts';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import type { Db } from '../db';
import { fail } from '../errors';
import { digest } from '../ai/context';
import { ReleaseAdmission, releaseScope } from './release';
import { policyLiabilities, policyWorkBlockers, revisionReceipt } from './policy-revisions';
import { fenceGenerationAdmission } from './scope-fence';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const adoptionSchema = z
  .object({
    operationId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    expectedHash: hash,
    candidateFingerprint: hash,
    consent: z.literal(true),
  })
  .strict();

async function admin(c: PoolClient, id: string, lock = true) {
  if (
    !(
      await c.query(
        "SELECT id FROM users WHERE id=$1 AND role='admin' AND deleted_at IS NULL AND (NOT COALESCE((to_jsonb(users)->>'email_verification_required')::boolean,false) OR email_verified)" +
          (lock ? ' FOR SHARE' : ''),
        [z.uuid().parse(id)],
      )
    ).rowCount
  )
    fail(403, 'FORBIDDEN', 'FORBIDDEN');
}
function snapshot(release: ReleaseAdmission) {
  const { configFingerprint: _fingerprint, ...profile } = release.config;
  void _fingerprint;
  // The validated configuration schema has no credentials, user input or account identifiers.
  return structuredClone(profile);
}
async function inspect(c: PoolClient, release: ReleaseAdmission, actorId: string, lock: boolean) {
  await release.actor(c, actorId, lock);
  const row = (
    await c.query(
      "SELECT * FROM live_test_sessions WHERE owner_id=$1 AND mode='release'" +
        (lock ? ' FOR NO KEY UPDATE' : ''),
      [actorId],
    )
  ).rows[0];
  if (!row || row.scope_id !== releaseScope(actorId)) fail(404, 'NOT_FOUND', 'NOT_FOUND');
  const scope = (
    await c.query(
      'SELECT * FROM generation_budget_scopes WHERE id=$1' + (lock ? ' FOR UPDATE' : ''),
      [row.scope_id],
    )
  ).rows[0];
  if (lock) await fenceGenerationAdmission(c);
  const wallet = (await c.query('SELECT enabled FROM spark_wallets WHERE owner_id=$1', [actorId]))
    .rows[0];
  const blockers: string[] = [];
  if (row.state !== 'active' || !scope?.approved || scope.blocked || !wallet?.enabled)
    blockers.push('GENERATION_ACCOUNT_REVIEW_REQUIRED');
  try {
    release.current();
  } catch {
    blockers.push('GENERATION_PRICING_EXPIRED');
  }
  if (row.policy_hash !== row.config_hash || Number(row.policy_revision) < 1)
    blockers.push('GENERATION_POLICY_CHANGED');
  const saved = (
    await c.query(
      'SELECT profile_snapshot FROM generation_policy_revisions WHERE authorization_id=$1 AND revision=$2 AND profile_hash=$3 AND config_fingerprint=$4',
      [row.id, row.policy_revision, row.policy_hash, row.config_hash],
    )
  ).rows[0];
  if (Number(row.policy_revision) > 1 && !saved) blockers.push('GENERATION_POLICY_CHANGED');
  const cfg = release.config;
  if (saved && saved.profile_snapshot.aggregateCapMicros !== cfg.aggregateCapMicros)
    blockers.push('GENERATION_RELEASE_LIMIT_CHANGE_UNSUPPORTED');
  const equalCap = (actual: unknown, expected: number | null) =>
    expected === null ? actual === null : actual !== null && String(actual) === String(expected);
  if (
    row.unlimited_allowance !== (cfg.allowance === 'unlimited') ||
    scope?.unlimited_allowance !== (cfg.allowance === 'unlimited') ||
    !equalCap(row.cap_micros, cfg.totalCapMicros) ||
    !equalCap(scope?.total_cap_micros, cfg.totalCapMicros) ||
    !equalCap(row.text_cap_micros, cfg.textCapMicros) ||
    !equalCap(scope?.text_cap_micros, cfg.textCapMicros) ||
    !equalCap(row.image_cap_micros, cfg.imageCapMicros) ||
    !equalCap(scope?.image_cap_micros, cfg.imageCapMicros)
  )
    blockers.push('GENERATION_RELEASE_LIMIT_CHANGE_UNSUPPORTED');
  blockers.push(...(await policyWorkBlockers(c, row.scope_id)));
  if (
    (
      await c.query(
        `SELECT 1 FROM npc_ai_jobs j JOIN live_test_sessions s ON s.id=j.generation_authorization_id WHERE s.scope_id=$1 AND j.provider_external IS DISTINCT FROM false AND j.provider_budget_status IN ('reserved','unknown') LIMIT 1`,
        [row.scope_id],
      )
    ).rowCount
  )
    blockers.push('LIVE_OUTCOME_UNRESOLVED');
  // Terminal customer holds are not an unknown provider execution. Leave them reserved
  // for their separate reconciliation. Orphaned/unsettled provider evidence is a blocker.
  const pending = (
    await c.query(
      `SELECT h.id,h.status,h.reserved_subunits,
    EXISTS(SELECT 1 FROM generation_budget_reservations r WHERE r.spark_quote_id=h.id AND r.scope_id=$1 AND r.actor_id=$2 AND r.status IN ('settled','released') AND (r.status='released' OR r.actual_micros IS NOT NULL)) AS provider_resolved
    FROM spark_holds h WHERE h.owner_id=$2 AND h.status IN ('held','pending')`,
      [row.scope_id, actorId],
    )
  ).rows;
  if (pending.some((h) => !h.provider_resolved))
    blockers.push('GENERATION_PRIOR_LIABILITY_UNRESOLVED');
  const liabilities = await policyLiabilities(c, row.scope_id);
  if (
    (cfg.totalCapMicros !== null && liabilities.totalAccountedMicros > cfg.totalCapMicros) ||
    (cfg.textCapMicros !== null &&
      liabilities.text.spentMicros + liabilities.text.heldMicros > cfg.textCapMicros) ||
    (cfg.imageCapMicros !== null &&
      liabilities.image.spentMicros + liabilities.image.heldMicros > cfg.imageCapMicros)
  )
    blockers.push('GENERATION_CAP_BELOW_HISTORICAL_SPEND');
  return { row, blockers: [...new Set(blockers)], liabilities, pending };
}
export async function reviewReleasePolicy(
  db: Db,
  release: ReleaseAdmission,
  adminId: string,
  actorId: string,
): Promise<ReleasePolicyReview> {
  z.uuid().parse(actorId);
  return db.tx(async (c) => {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await admin(c, adminId, false);
    const { row, blockers, liabilities, pending } = await inspect(c, release, actorId, false);
    const saved = (
      await c.query(
        'SELECT profile_snapshot FROM generation_policy_revisions WHERE authorization_id=$1 AND revision=$2 AND profile_hash=$3',
        [row.id, row.policy_revision, row.policy_hash],
      )
    ).rows[0];
    if (row.config_hash === release.config.configFingerprint)
      blockers.push('GENERATION_POLICY_UNCHANGED');
    return {
      authorizationId: row.id,
      scopeId: row.scope_id,
      active: {
        revision: Number(row.policy_revision),
        hash: row.policy_hash,
        profile: saved?.profile_snapshot ?? null,
      },
      proposed: {
        candidateFingerprint: release.config.configFingerprint,
        profile: snapshot(release),
        canApply: blockers.length === 0,
        blockers,
      },
      liabilities,
      pendingSparkHolds: pending.map((h) => ({
        id: h.id,
        status: h.status,
        reservedSubunits: String(h.reserved_subunits),
      })),
      legacyProfileStatus: saved ? ('available' as const) : ('unavailable' as const),
    };
  });
}
export async function adoptReleasePolicy(
  db: Db,
  release: ReleaseAdmission,
  adminId: string,
  actorId: string,
  input: unknown,
): Promise<ReleasePolicyReceipt> {
  z.uuid().parse(actorId);
  const body = adoptionSchema.parse(input),
    requestHash = digest({ adminId, actorId, ...body });
  return db.tx(async (c) => {
    await admin(c, adminId);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `release-admit:${actorId}`,
    ]);
    // Exact receipt replay is safe even after a later configuration or stop change.
    const previous = (
      await c.query(
        "SELECT r.* FROM generation_policy_revisions r JOIN live_test_sessions s ON s.id=r.authorization_id WHERE s.owner_id=$1 AND s.mode='release' AND r.operation_id=$2",
        [actorId, body.operationId],
      )
    ).rows[0];
    if (previous) {
      if (previous.request_hash !== requestHash)
        fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
      return revisionReceipt(previous);
    }
    const { row, blockers } = await inspect(c, release, actorId, true);
    if (
      Number(row.policy_revision) !== body.expectedRevision ||
      row.policy_hash !== body.expectedHash ||
      body.candidateFingerprint !== release.config.configFingerprint
    )
      fail(409, 'GENERATION_POLICY_STALE', 'GENERATION_POLICY_STALE');
    if (blockers.length) fail(409, blockers[0], blockers[0]);
    if (row.config_hash === release.config.configFingerprint)
      fail(409, 'GENERATION_POLICY_UNCHANGED', 'GENERATION_POLICY_UNCHANGED');
    const revision = (
      await c.query<QueryResultRow>(
        `INSERT INTO generation_policy_revisions(id,authorization_id,scope_id,revision,profile_hash,config_fingerprint,previous_hash,profile_snapshot,operation_id,request_hash)
      VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9) RETURNING *`,
        [
          randomUUID(),
          row.id,
          row.scope_id,
          Number(row.policy_revision) + 1,
          release.config.configFingerprint,
          row.policy_hash,
          JSON.stringify(snapshot(release)),
          body.operationId,
          requestHash,
        ],
      )
    ).rows[0];
    await c.query(
      'UPDATE live_test_sessions SET config_hash=$2,policy_hash=$2,policy_revision=$3 WHERE id=$1',
      [row.id, release.config.configFingerprint, revision.revision],
    );
    await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
      adminId,
      'generation.release-policy.adopt',
      row.id,
      JSON.stringify({
        actorId,
        operationId: body.operationId,
        revision: revision.revision,
        previousHash: row.policy_hash,
        hash: release.config.configFingerprint,
      }),
    ]);
    return revisionReceipt(revision);
  });
}
