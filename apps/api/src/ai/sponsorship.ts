import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { Db } from '../db';
import { fail } from '../errors';
import { digest } from './context';
import type { AiPolicy, AiPurpose, AiScope, NpcProvider } from './types';
const grantSchema = z
  .object({
    operationId: z.uuid(),
    consent: z.literal(true),
    totalCredits: z.number().int().min(0).max(1000000),
    perOperationCredits: z.number().int().min(0).max(100000),
    maxOperations: z.number().int().min(1).max(1000),
    totalProviderMicros: z.number().int().min(0).max(1000000000000),
    perOperationProviderMicros: z.number().int().min(0).max(100000000),
    expiresAt: z.iso.datetime(),
    purposes: z
      .array(z.enum(['plan', 'summary', 'speech', 'intent']))
      .min(1)
      .max(4),
  })
  .strict();
export type SponsorGrant = z.infer<typeof grantSchema>;
type Authorize = (c: PoolClient, scope: AiScope) => Promise<void>;
export class NpcSponsorship {
  constructor(
    private db: Db,
    private provider: NpcProvider,
    private policy: AiPolicy,
    private authorize: Authorize,
  ) {}
  private async lock(c: PoolClient, campaignId: string) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`npc-ai:${campaignId}`]);
  }
  async grant(campaignId: string, payerUserId: string, input: SponsorGrant) {
    const b = grantSchema.parse(input),
      expires = new Date(b.expiresAt);
    if (expires.getTime() <= Date.now() || expires.getTime() > Date.now() + 86400000)
      fail(400, 'INVALID_SPONSOR_EXPIRY', 'INVALID_SPONSOR_EXPIRY');
    if (
      b.perOperationCredits < this.policy.creditPrice ||
      b.totalCredits < b.perOperationCredits ||
      b.perOperationProviderMicros < this.policy.providerUpperMicros ||
      b.totalProviderMicros < b.perOperationProviderMicros
    )
      fail(400, 'SPONSOR_LIMIT_TOO_SMALL', 'SPONSOR_LIMIT_TOO_SMALL');
    return this.db.tx(async (c) => {
      await this.lock(c, campaignId);
      await this.authorize(c, {
        campaignId,
        npcId: 'sponsor',
        origin: 'user',
        requesterUserId: payerUserId,
      });
      if (
        !(
          await c.query('SELECT 1 FROM game_campaigns WHERE id=$1 AND owner_id=$2', [
            campaignId,
            payerUserId,
          ])
        ).rowCount
      )
        fail(403, 'FORBIDDEN', 'FORBIDDEN');
      const prior = (
        await c.query('SELECT * FROM npc_ai_sponsors WHERE campaign_id=$1 AND operation_id=$2', [
          campaignId,
          b.operationId,
        ])
      ).rows[0];
      const hash = digest({ payerUserId, ...b });
      if (prior) {
        if (prior.request_hash !== hash) fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return this.dto(c, prior.id);
      }
      // Only expired, unused consent can be replaced automatically; pending jobs are cancelled first.
      await c.query(
        "UPDATE npc_ai_jobs j SET cancel_requested=true,result_code='SPONSOR_EXPIRED' FROM npc_ai_sponsors s WHERE j.sponsor_id=s.id AND s.campaign_id=$1 AND s.expires_at<=now() AND j.status NOT IN ('committed','stale','cancelled','failed')",
        [campaignId],
      );
      await c.query(
        'UPDATE npc_ai_sponsors SET revoked_at=now() WHERE campaign_id=$1 AND revoked_at IS NULL AND expires_at<=now()',
        [campaignId],
      );
      if (
        (
          await c.query(
            'SELECT 1 FROM npc_ai_sponsors WHERE campaign_id=$1 AND revoked_at IS NULL',
            [campaignId],
          )
        ).rowCount
      )
        fail(409, 'SPONSOR_EXISTS', 'SPONSOR_EXISTS');
      const id = randomUUID();
      await c.query(
        `INSERT INTO npc_ai_sponsors(id,campaign_id,payer_user_id,operation_id,request_hash,total_credits,per_operation_credits,max_operations,total_provider_micros,per_operation_provider_micros,purposes,provider_id,provider_version,policy_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id,
          campaignId,
          payerUserId,
          b.operationId,
          hash,
          b.totalCredits,
          b.perOperationCredits,
          b.maxOperations,
          b.totalProviderMicros,
          b.perOperationProviderMicros,
          [...new Set(b.purposes)],
          this.provider.id,
          this.provider.version,
          this.policy.version,
          expires,
        ],
      );
      return this.dto(c, id);
    });
  }
  private async dto(c: PoolClient, id: string) {
    const s = (
      await c.query(
        `SELECT s.*,count(j.id)::int AS operations,COALESCE(sum(j.provider_upper_micros),0) AS attempted_micros,COALESCE(sum(CASE WHEN j.reservation_status IN ('held','captured') THEN j.credits ELSE 0 END),0) AS used_credits FROM npc_ai_sponsors s LEFT JOIN npc_ai_jobs j ON j.sponsor_id=s.id WHERE s.id=$1 GROUP BY s.id`,
        [id],
      )
    ).rows[0];
    return {
      id: s.id,
      expiresAt: s.expires_at.toISOString(),
      revoked: s.revoked_at !== null,
      totalCredits: s.total_credits,
      perOperationCredits: s.per_operation_credits,
      remainingCredits: s.total_credits - Number(s.used_credits),
      maxOperations: s.max_operations,
      remainingOperations: s.max_operations - s.operations,
      totalProviderMicros: Number(s.total_provider_micros),
      perOperationProviderMicros: Number(s.per_operation_provider_micros),
      remainingProviderMicros: Number(s.total_provider_micros) - Number(s.attempted_micros),
      purposes: s.purposes,
      provider: s.provider_id,
      demo: true,
    };
  }
  async list(campaignId: string, payerUserId: string) {
    return this.db.tx(async (c) => {
      await this.authorize(c, {
        campaignId,
        npcId: 'sponsor',
        origin: 'user',
        requesterUserId: payerUserId,
      });
      const rows = (
        await c.query(
          'SELECT id FROM npc_ai_sponsors WHERE campaign_id=$1 AND payer_user_id=$2 ORDER BY created_at DESC LIMIT 20',
          [campaignId, payerUserId],
        )
      ).rows;
      return Promise.all(rows.map((r) => this.dto(c, r.id)));
    });
  }
  async revoke(campaignId: string, payerUserId: string, id: string) {
    return this.db.tx(async (c) => {
      await this.lock(c, campaignId);
      await this.authorize(c, {
        campaignId,
        npcId: 'sponsor',
        origin: 'user',
        requesterUserId: payerUserId,
      });
      if (
        !(
          await c.query(
            'SELECT 1 FROM npc_ai_sponsors WHERE id=$1 AND campaign_id=$2 AND payer_user_id=$3',
            [id, campaignId, payerUserId],
          )
        ).rowCount
      )
        fail(404, 'NOT_FOUND', 'NOT_FOUND');
      await c.query(
        "UPDATE npc_ai_jobs SET cancel_requested=true,result_code='SPONSOR_REVOKED' WHERE sponsor_id=$1 AND status NOT IN ('committed','stale','cancelled','failed')",
        [id],
      );
      await c.query(
        'UPDATE npc_ai_sponsors SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1',
        [id],
      );
      return this.dto(c, id);
    });
  }
  async active(campaignId: string, purpose: AiPurpose) {
    const rows = await this.db.query(
      'SELECT id FROM npc_ai_sponsors WHERE campaign_id=$1 AND revoked_at IS NULL AND expires_at>now() AND $2=ANY(purposes) ORDER BY created_at LIMIT 1',
      [campaignId, purpose],
    );
    return rows[0]?.id as string | undefined;
  }
  async validate(
    c: PoolClient,
    id: string,
    campaignId: string,
    purpose: AiPurpose,
    queue: boolean,
  ) {
    const s = (await c.query('SELECT * FROM npc_ai_sponsors WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (
      !s ||
      s.campaign_id !== campaignId ||
      s.revoked_at ||
      s.expires_at.getTime() <= Date.now() ||
      !s.purposes.includes(purpose) ||
      s.provider_id !== this.provider.id ||
      s.provider_version !== this.provider.version ||
      s.policy_version !== this.policy.version
    )
      fail(409, 'SPONSOR_UNAVAILABLE', 'SPONSOR_UNAVAILABLE');
    await this.authorize(c, {
      campaignId,
      npcId: 'sponsor',
      origin: 'user',
      requesterUserId: s.payer_user_id,
    });
    if (
      !(
        await c.query('SELECT 1 FROM game_campaigns WHERE id=$1 AND owner_id=$2', [
          campaignId,
          s.payer_user_id,
        ])
      ).rowCount
    )
      fail(403, 'FORBIDDEN', 'FORBIDDEN');
    if (queue) {
      const totals = (
        await c.query(
          "SELECT count(*)::int AS operations,COALESCE(sum(provider_upper_micros),0) AS attempts,COALESCE(sum(CASE WHEN reservation_status IN ('held','captured') THEN credits ELSE 0 END),0) AS credits FROM npc_ai_jobs WHERE sponsor_id=$1",
          [id],
        )
      ).rows[0];
      if (
        this.policy.creditPrice > s.per_operation_credits ||
        Number(totals.credits) + this.policy.creditPrice > s.total_credits ||
        totals.operations >= s.max_operations ||
        this.policy.providerUpperMicros > Number(s.per_operation_provider_micros) ||
        Number(totals.attempts) + this.policy.providerUpperMicros > Number(s.total_provider_micros)
      )
        fail(409, 'SPONSOR_BUDGET_EXCEEDED', 'SPONSOR_BUDGET_EXCEEDED');
    }
    return s.payer_user_id as string;
  }
}
