import { currentReleaseDeployment } from './release-deployment';
/** Ordinary authenticated generation. No test grant, funding, or profile-derived allowance. */
import { refreshReleaseProfile } from './release-policy';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { fail } from '../errors';
import type { ReleaseGenerationConfig } from './config';
import { ownerPricingIsCurrent } from './config';
import { fenceGenerationAdmission } from './scope-fence';
import { defaultImagePolicy, type ImagePolicy } from '../image-generation/contracts';
export const releaseScope = (actorId: string) => `release:${actorId}`;
export class ReleaseAdmission {
  constructor(readonly config: ReleaseGenerationConfig) {}
  current() {
    if (
      !ownerPricingIsCurrent(this.config.text.pricing) ||
      !ownerPricingIsCurrent(this.config.image.pricing)
    )
      fail(409, 'GENERATION_PRICING_EXPIRED', 'GENERATION_PRICING_EXPIRED');
  }
  async actor(c: Pick<PoolClient, 'query'>, actorId: string, lock = false) {
    if (
      !(
        await c.query(
          `SELECT id FROM users u WHERE id=$1 AND deleted_at IS NULL AND (NOT COALESCE((to_jsonb(u)->>'email_verification_required')::boolean,false) OR u.email_verified)${lock ? ' FOR SHARE' : ''}`,
          [actorId],
        )
      ).rowCount
    )
      fail(403, 'FORBIDDEN', 'FORBIDDEN');
  }
  /** Called only from mutating quote/consent operations, before any external call. */
  async ensure(c: PoolClient, actorId: string, suppliedId?: string) {
    this.current();
    await this.actor(c, actorId);
    const scopeId = releaseScope(actorId);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `release-admit:${actorId}`,
    ]);
    let row = (
      await c.query("SELECT * FROM live_test_sessions WHERE scope_id=$1 AND mode='release'", [
        scopeId,
      ])
    ).rows[0];
    if (row && suppliedId && row.id !== suppliedId)
      fail(403, 'GENERATION_AUTHORIZATION_FORBIDDEN', 'GENERATION_AUTHORIZATION_FORBIDDEN');
    if (!row && suppliedId)
      fail(403, 'GENERATION_AUTHORIZATION_FORBIDDEN', 'GENERATION_AUTHORIZATION_FORBIDDEN');
    if (!row) {
      const epoch = await currentReleaseDeployment(c, this.config);
      await c.query(
        'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,text_cap_micros,image_cap_micros,serialize_outstanding,unlimited_allowance) VALUES($1,true,$2,$3,$4,true,$5) ON CONFLICT DO NOTHING',
        [
          scopeId,
          this.config.totalCapMicros,
          this.config.textCapMicros,
          this.config.imageCapMicros,
          this.config.allowance === 'unlimited',
        ],
      );
      const id = randomUUID();
      row = (
        await c.query(
          "INSERT INTO live_test_sessions(id,owner_id,scope_id,expires_at,cap_micros,state,mode,config_hash,text_cap_micros,image_cap_micros,policy_revision,policy_hash,unlimited_allowance,release_profile_epoch) VALUES($1,$2,$3,NULL,$4,'active','release',$5,$6,$7,1,$5,$8,$9) RETURNING *",
          [
            id,
            actorId,
            scopeId,
            this.config.totalCapMicros,
            this.config.configFingerprint,
            this.config.textCapMicros,
            this.config.imageCapMicros,
            this.config.allowance === 'unlimited',
            epoch,
          ],
        )
      ).rows[0];
    }
    await this.check(c, row.id, actorId);
    return row.id as string;
  }
  async check(c: PoolClient, id: string, actorId: string) {
    this.current();
    await this.actor(c, actorId, true);
    const row = (
      await c.query(
        "SELECT * FROM live_test_sessions WHERE id=$1 AND mode='release' FOR NO KEY UPDATE",
        [id],
      )
    ).rows[0];
    if (!row || row.owner_id !== actorId || row.scope_id !== releaseScope(actorId))
      fail(403, 'GENERATION_AUTHORIZATION_FORBIDDEN', 'GENERATION_AUTHORIZATION_FORBIDDEN');
    const scope = (
      await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [row.scope_id])
    ).rows[0];
    if (row.state !== 'active' || !scope?.approved || scope.blocked)
      fail(409, 'GENERATION_ACCOUNT_REVIEW_REQUIRED', 'GENERATION_ACCOUNT_REVIEW_REQUIRED');
    await fenceGenerationAdmission(c);
    const wallet = (
      await c.query('SELECT enabled FROM spark_wallets WHERE owner_id=$1 FOR UPDATE', [actorId])
    ).rows[0];
    if (wallet?.enabled !== true) fail(409, 'SPARK_WALLET_NOT_ENABLED', 'SPARK_WALLET_NOT_ENABLED');
    return refreshReleaseProfile(c, row, scope, this.config);
  }
  /** Completion of already-dispatched work uses its immutable admitted revision, not a new quote. */
  async result(c: PoolClient, id: string, actorId: string, revision: number, hash: string) {
    await this.actor(c, actorId, true);
    const row = (
      await c.query(
        "SELECT * FROM live_test_sessions WHERE id=$1 AND mode='release' FOR NO KEY UPDATE",
        [id],
      )
    ).rows[0];
    if (!row || row.owner_id !== actorId || row.scope_id !== releaseScope(actorId))
      fail(403, 'GENERATION_AUTHORIZATION_FORBIDDEN', 'GENERATION_AUTHORIZATION_FORBIDDEN');
    const scope = (
      await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [row.scope_id])
    ).rows[0];
    if (row.state !== 'active' || !scope?.approved || scope.blocked)
      fail(409, 'GENERATION_ACCOUNT_REVIEW_REQUIRED', 'GENERATION_ACCOUNT_REVIEW_REQUIRED');
    await fenceGenerationAdmission(c);
    const wallet = (
      await c.query('SELECT enabled FROM spark_wallets WHERE owner_id=$1 FOR UPDATE', [actorId])
    ).rows[0];
    if (!wallet?.enabled) fail(409, 'SPARK_WALLET_NOT_ENABLED', 'SPARK_WALLET_NOT_ENABLED');
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision > Number(row.policy_revision) ||
      !hash
    )
      fail(409, 'GENERATION_POLICY_CHANGED', 'GENERATION_POLICY_CHANGED');
    const admitted = (
      await c.query(
        `SELECT 1 FROM generation_policy_revisions WHERE authorization_id=$1 AND
       ((revision=$2 AND profile_hash=$3) OR ($2=1 AND revision=2 AND previous_hash=$3)) LIMIT 1`,
        [id, revision, hash],
      )
    ).rowCount;
    if (
      !admitted &&
      !(revision === 1 && Number(row.policy_revision) === 1 && row.policy_hash === hash)
    )
      fail(409, 'GENERATION_POLICY_CHANGED', 'GENERATION_POLICY_CHANGED');
  }
  async policy(c: PoolClient, actorId: string, id?: string): Promise<ImagePolicy> {
    const authorizationId = await this.ensure(c, actorId, id);
    const row = (
      await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1', [releaseScope(actorId)])
    ).rows[0];
    return {
      ...defaultImagePolicy,
      scopeId: releaseScope(actorId),
      approved: true,
      externalEnabled: true,
      verifiedUpperMicros: this.config.text.upperMicros,
      totalCapMicros:
        this.config.allowance === 'unlimited'
          ? null
          : Math.min(Number(row.total_cap_micros), this.config.totalCapMicros ?? 0),
      textCapMicros:
        this.config.allowance === 'unlimited'
          ? null
          : Math.min(Number(row.text_cap_micros), this.config.textCapMicros ?? 0),
      imageCapMicros:
        this.config.allowance === 'unlimited'
          ? null
          : Math.min(Number(row.image_cap_micros), this.config.imageCapMicros ?? 0),
      generationMode: 'release',
      ...(this.config.allowance === 'unlimited'
        ? { releaseUnlimitedAllowance: true as const }
        : {}),
      generationAuthorizationId: authorizationId,
      generationConfigFingerprint: this.config.configFingerprint,
      generationPolicyRevision: Number((await this.active(c, authorizationId)).revision),
      generationPolicyHash: this.config.configFingerprint,
      releaseAggregateCapMicros: this.config.aggregateCapMicros,
    };
  }
  async active(c: Pick<PoolClient, 'query'>, id?: string, fingerprint?: string) {
    this.current();
    const epoch = await currentReleaseDeployment(c, this.config);
    const row = (
      await c.query(
        "SELECT s.*,b.approved,b.blocked,b.unlimited_allowance AS scope_unlimited_allowance FROM live_test_sessions s JOIN generation_budget_scopes b ON b.id=s.scope_id JOIN users u ON u.id=s.owner_id AND u.deleted_at IS NULL AND (NOT COALESCE((to_jsonb(u)->>'email_verification_required')::boolean,false) OR u.email_verified) JOIN spark_wallets w ON w.owner_id=s.owner_id AND w.enabled WHERE s.id=$1 AND s.mode='release'",
        [id],
      )
    ).rows[0];
    if (
      !row ||
      row.scope_id !== releaseScope(row.owner_id) ||
      row.state !== 'active' ||
      !row.approved ||
      row.unlimited_allowance !== (this.config.allowance === 'unlimited') ||
      row.scope_unlimited_allowance !== (this.config.allowance === 'unlimited') ||
      row.blocked
    )
      fail(409, 'GENERATION_ACCOUNT_REVIEW_REQUIRED', 'GENERATION_ACCOUNT_REVIEW_REQUIRED');
    if (
      String(row.release_profile_epoch) !== epoch ||
      row.config_hash !== this.config.configFingerprint ||
      row.policy_hash !== this.config.configFingerprint ||
      (fingerprint && fingerprint !== this.config.configFingerprint)
    )
      fail(409, 'GENERATION_POLICY_CHANGED', 'GENERATION_POLICY_CHANGED');
    return {
      revision: Number(row.policy_revision),
      hash: this.config.configFingerprint,
      configFingerprint: this.config.configFingerprint,
    };
  }
}
