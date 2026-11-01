import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../ai/context';
import type { ProviderRequest } from '../ai/types';
import { Db } from '../db';
import { fail } from '../errors';
import { reserveGenerationSpend, settleGenerationSpend } from '../image-generation/budget';
import { defaultImagePolicy, type ImagePolicy } from '../image-generation/contracts';
import { sourceAccessSql } from '../game/playable.service';
import { LIVE_TEXT, type LiveTestConfig } from '../live-test/config';
import { ownerPricingIsCurrent, type OwnerGenerationConfig } from './config';
import { fenceGenerationAdmission } from './scope-fence';
export const GENERATION_SCOPE_ID = LIVE_TEXT.scopeId;
const fenceSchema = z
  .object({
    roundId: z.string().min(1),
    phaseEpoch: z.number().int().min(0),
    rulesetVersion: z.literal(1),
  })
  .strict();
const consentSchema = z
  .object({
    sessionId: z.uuid().optional(),
    authorizationId: z.uuid().optional(),
    operationId: z.uuid(),
    turnFence: fenceSchema,
    consent: z.literal(true),
  })
  .strict()
  .refine((v) => !v.sessionId || !v.authorizationId || v.sessionId === v.authorizationId, {
    message: 'AUTHORIZATION_ID_MISMATCH',
  });
@Injectable()
export class GenerationAuthority {
  readonly config: LiveTestConfig & { mode: 'owner' | 'manual' };
  readonly ownerConfig?: OwnerGenerationConfig;
  constructor(
    readonly db: Db,
    configuration: LiveTestConfig | OwnerGenerationConfig,
  ) {
    if ('mode' in configuration && configuration.mode === 'owner') {
      this.ownerConfig = structuredClone(configuration);
      if (
        'scopeId' in configuration ||
        'scopeId' in configuration.text ||
        'scopeId' in configuration.image
      )
        fail(409, 'GENERATION_SCOPE_IMMUTABLE', 'GENERATION_SCOPE_IMMUTABLE');
      const caps = [
        configuration.totalCapMicros,
        configuration.textCapMicros,
        configuration.imageCapMicros,
        configuration.text.upperMicros,
      ];
      if (
        caps.some((n) => !Number.isSafeInteger(n) || n <= 0) ||
        !/^[a-z0-9_]{3,30}$/.test(configuration.ownerHandle) ||
        !/^[a-f0-9]{64}$/.test(configuration.configFingerprint)
      )
        fail(409, 'GENERATION_CONFIG_INVALID', 'GENERATION_CONFIG_INVALID');
      this.config = { enabled: true, mode: 'owner', estimateRiskApproved: true };
    } else this.config = { ...(configuration as LiveTestConfig), mode: 'manual' };
  }
  get mode() {
    return this.config.mode;
  }
  textProfile() {
    return this.ownerConfig?.text ?? LIVE_TEXT;
  }
  textUpperMicros() {
    return this.textProfile().upperMicros;
  }
  budgetCaps() {
    return this.ownerConfig
      ? {
          totalCapMicros: this.ownerConfig.totalCapMicros,
          textCapMicros: this.ownerConfig.textCapMicros,
          imageCapMicros: this.ownerConfig.imageCapMicros,
        }
      : {
          totalCapMicros: LIVE_TEXT.capMicros,
          textCapMicros: LIVE_TEXT.capMicros,
          imageCapMicros: LIVE_TEXT.capMicros,
        };
  }
  private identity() {
    return this.ownerConfig ? digest(this.ownerConfig) : null;
  }
  private pricingCurrent() {
    return (
      !this.ownerConfig ||
      (ownerPricingIsCurrent(this.ownerConfig.text.pricing) &&
        ownerPricingIsCurrent(this.ownerConfig.image.pricing))
    );
  }
  private async owner(userId: string) {
    if (!this.config.enabled) fail(409, 'LIVE_TEST_DISABLED', 'LIVE_TEST_DISABLED');
    if (!this.ownerConfig) {
      if (userId !== this.config.ownerId) fail(403, 'FORBIDDEN', 'FORBIDDEN');
      return;
    }
    const rows = await this.db.query(
      'SELECT id FROM users WHERE id=$1 AND handle=$2 AND deleted_at IS NULL',
      [userId, this.ownerConfig.ownerHandle],
    );
    if (!rows.length) fail(403, 'FORBIDDEN', 'FORBIDDEN');
    const pinned = await this.db.query(
      "SELECT owner_id FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'",
      [GENERATION_SCOPE_ID],
    );
    if (pinned[0] && pinned[0].owner_id !== userId)
      fail(403, 'GENERATION_OWNER_IMMUTABLE', 'GENERATION_OWNER_IMMUTABLE');
  }
  private async ownerTx(c: PoolClient, userId: string) {
    const row = (
      await c.query('SELECT id,handle FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [
        userId,
      ])
    ).rows[0];
    if (
      !row ||
      (this.ownerConfig
        ? row.handle !== this.ownerConfig.ownerHandle
        : userId !== this.config.ownerId)
    )
      fail(403, 'FORBIDDEN', 'FORBIDDEN');
  }
  private policy(): ImagePolicy {
    return {
      ...defaultImagePolicy,
      scopeId: GENERATION_SCOPE_ID,
      approved: true,
      externalEnabled: true,
      verifiedUpperMicros: this.textUpperMicros(),
      ...this.budgetCaps(),
    };
  }
  private async effectivePolicy(c: PoolClient): Promise<ImagePolicy> {
    const policy = this.policy();
    const scope = (
      await c.query(
        'SELECT total_cap_micros,text_cap_micros,image_cap_micros FROM generation_budget_scopes WHERE id=$1',
        [GENERATION_SCOPE_ID],
      )
    ).rows[0];
    if (!scope) fail(409, 'GENERATION_CONSENT_REQUIRED', 'GENERATION_CONSENT_REQUIRED');
    const owner = this.ownerConfig
      ? (
          await c.query("SELECT id FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'", [
            GENERATION_SCOPE_ID,
          ])
        ).rows[0]
      : null;
    return {
      ...policy,
      ...(owner
        ? {
            generationMode: 'owner' as const,
            generationAuthorizationId: owner.id,
            generationConfigFingerprint: this.ownerConfig!.configFingerprint,
          }
        : {}),
      totalCapMicros: Math.min(policy.totalCapMicros, Number(scope.total_cap_micros)),
      textCapMicros: Math.min(policy.textCapMicros, Number(scope.text_cap_micros)),
      imageCapMicros: Math.min(policy.imageCapMicros, Number(scope.image_cap_micros)),
    };
  }
  /** Existing financial identity is retained; this is not a new allowance or reconciliation. */
  private async historicalSafety(c: PoolClient, userId: string, firstClaim = false) {
    const unsafe = (
      await c.query(
        `SELECT 1 FROM generation_budget_reservations r JOIN generation_budget_scopes b ON b.id=r.scope_id
       WHERE ((r.scope_id<>$1 OR $2::boolean) AND r.status='held' AND r.upper_micros>0) OR (r.status='settled' AND r.actual_micros IS NULL)
       UNION ALL SELECT 1 FROM generation_budget_scopes b WHERE blocked AND (approved OR id=$1 OR EXISTS(SELECT 1 FROM generation_budget_reservations r WHERE r.scope_id=b.id AND (r.upper_micros>0 OR r.actual_micros>0)))
       UNION ALL SELECT 1 FROM live_test_sessions WHERE scope_id=$1 AND state='stopped' AND COALESCE(stop_code,'')<>'OWNER_GENERATION_MODE_ACTIVE'
       LIMIT 1`,
        [GENERATION_SCOPE_ID, firstClaim],
      )
    ).rowCount;
    if (unsafe)
      fail(409, 'GENERATION_PRIOR_LIABILITY_UNRESOLVED', 'GENERATION_PRIOR_LIABILITY_UNRESOLVED');
    const priorOwner = (
      await c.query('SELECT 1 FROM live_test_sessions WHERE scope_id=$1 AND owner_id<>$2 LIMIT 1', [
        GENERATION_SCOPE_ID,
        userId,
      ])
    ).rowCount;
    if (priorOwner) fail(403, 'GENERATION_OWNER_IMMUTABLE', 'GENERATION_OWNER_IMMUTABLE');
    const foreignOwner = (
      await c.query(
        'SELECT 1 FROM generation_budget_reservations WHERE scope_id=$1 AND (actor_id IS NULL OR actor_id<>$2) LIMIT 1',
        [GENERATION_SCOPE_ID, userId],
      )
    ).rowCount;
    if (foreignOwner) fail(403, 'GENERATION_OWNER_IMMUTABLE', 'GENERATION_OWNER_IMMUTABLE');
    // Unknown provider outcomes and permanent authorization denials survive mode/scope changes,
    // even when an old reservation was zero or later marked settled.
    const priorOutcome = (
      await c.query(
        `
      SELECT 1 FROM image_generation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id
      WHERE (r.scope_id<>$1 OR $2::boolean) AND j.mode='external' AND (j.status='unknown' OR j.safe_diagnostic->>'httpStatus'='403' OR (j.status='dispatched' AND j.dispatch_deadline<=now()))
      UNION ALL SELECT 1 FROM live_test_text_permits p JOIN live_test_sessions a ON a.id=p.session_id
      WHERE (a.scope_id<>$1 OR $2::boolean) AND (p.state='unknown' OR p.result_code='PROVIDER_HTTP_403' OR (p.state='dispatched' AND p.dispatched_at<=now()-interval '60 seconds'))
      UNION ALL SELECT 1 FROM live_authoring_text_jobs j JOIN live_test_sessions a ON a.id=j.session_id
      WHERE (a.scope_id<>$1 OR $2::boolean) AND (j.status='unknown' OR j.error_code='PROVIDER_HTTP_403' OR (j.status='dispatched' AND j.deadline_at<=now())) LIMIT 1`,
        [GENERATION_SCOPE_ID, firstClaim],
      )
    ).rowCount;
    if (priorOutcome)
      fail(409, 'GENERATION_PRIOR_LIABILITY_UNRESOLVED', 'GENERATION_PRIOR_LIABILITY_UNRESOLVED');
    // Older unwrapped NPC providers have their own ledger. Never discard or silently
    // remap it into the owner allowance; only jobs already linked to the shared ledger
    // (or explicitly recorded as free mocks) are accounted for here.
    const legacyNpc = (
      await c.query(`WITH accounted_jobs AS (
      SELECT j.id,j.provider_id,j.provider_budget_status,j.provider_upper_micros,j.provider_actual_micros FROM npc_ai_jobs j WHERE j.provider_external=false
      OR (j.generation_authorization_id IS NOT NULL AND j.status='reserved' AND j.started_at IS NULL
        AND j.deadline_at IS NULL AND j.provider_request_id IS NULL AND j.result_at IS NULL AND j.result_code IS NULL
        AND j.provider_budget_status='reserved' AND COALESCE(j.provider_actual_micros,0)=0
        AND NOT EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.job_id=j.id OR p.request_id::text=j.request_meta->>'runtimeRequestId'))
      OR EXISTS(
        SELECT 1 FROM live_test_text_permits p JOIN generation_budget_reservations r ON r.id=p.reservation_id
        WHERE (p.job_id=j.id OR p.request_id::text=j.request_meta->>'runtimeRequestId')
        AND ((j.provider_budget_status='reserved' AND r.status='held' AND r.upper_micros>=j.provider_upper_micros)
          OR (j.provider_budget_status='spent' AND r.status='settled' AND r.actual_micros=j.provider_actual_micros)
          OR (j.provider_budget_status='unknown' AND r.status='held' AND r.upper_micros>=j.provider_upper_micros)
          OR (j.provider_budget_status IN ('none','released') AND COALESCE(j.provider_actual_micros,0)=0))
      )
    ), accounted_budgets AS (
      SELECT provider_id,
      COALESCE(sum(CASE WHEN provider_budget_status='reserved' THEN provider_upper_micros ELSE 0 END),0) reserved,
      COALESCE(sum(CASE WHEN provider_budget_status='spent' THEN provider_actual_micros ELSE 0 END),0) spent,
      COALESCE(sum(CASE WHEN provider_budget_status='unknown' THEN provider_upper_micros ELSE 0 END),0) unknown
      FROM accounted_jobs GROUP BY provider_id
    ), provider_kind AS (SELECT provider_id,bool_and(provider_external IS FALSE) only_mock FROM npc_ai_jobs GROUP BY provider_id
    ) SELECT 1 FROM npc_ai_jobs j WHERE j.provider_external IS DISTINCT FROM false
      AND NOT EXISTS(SELECT 1 FROM accounted_jobs a WHERE a.id=j.id)
      AND (j.provider_budget_status='unknown' OR j.provider_actual_micros>0
        OR (j.provider_budget_status='reserved' AND j.provider_upper_micros>0)
        OR (j.status IN ('running','reconciling') AND (j.provider_upper_micros>0 OR j.provider_external=true))
        OR j.result_code='PROVIDER_HTTP_403')
    UNION ALL SELECT 1 FROM npc_ai_provider_budgets b LEFT JOIN accounted_budgets a ON a.provider_id=b.provider_id LEFT JOIN provider_kind k ON k.provider_id=b.provider_id
      WHERE b.reserved_micros>COALESCE(a.reserved,0) OR b.spent_micros>COALESCE(a.spent,0)
      OR b.unknown_micros>COALESCE(a.unknown,0) OR (b.overrun_micros>0 AND NOT COALESCE(k.only_mock,false))
      OR (b.blocked AND b.cap_micros>0 AND (NOT EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.provider_id=b.provider_id)
        OR EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.provider_id=b.provider_id AND j.provider_external IS DISTINCT FROM false)))
      LIMIT 1`)
    ).rowCount;
    if (legacyNpc)
      fail(
        409,
        'GENERATION_PRIOR_NPC_RECONCILIATION_REQUIRED',
        'GENERATION_PRIOR_NPC_RECONCILIATION_REQUIRED',
      );
    const foreignSpend = (
      await c.query(
        "SELECT 1 FROM generation_budget_reservations WHERE scope_id<>$1 AND (actor_id=$2 OR actor_id IS NULL) AND status='settled' AND actual_micros>0 LIMIT 1",
        [GENERATION_SCOPE_ID, userId],
      )
    ).rowCount;
    if (foreignSpend)
      fail(
        409,
        'GENERATION_PRIOR_SCOPE_RECONCILIATION_REQUIRED',
        'GENERATION_PRIOR_SCOPE_RECONCILIATION_REQUIRED',
      );
  }
  /** Row order is authorization then shared scope, also used by settlement paths. */
  async lockAuthorization(c: PoolClient, id: string) {
    const peek = (await c.query('SELECT scope_id FROM live_test_sessions WHERE id=$1', [id]))
      .rows[0];
    if (!peek) return undefined;
    // Migrated scopes retain a manual row as well as their owner row. Every path
    // locks that entire set in the same order before touching the scope.
    const rows = (
      await c.query('SELECT * FROM live_test_sessions WHERE scope_id=$1 ORDER BY id FOR UPDATE', [
        peek.scope_id,
      ])
    ).rows;
    await c.query('SELECT id FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [
      peek.scope_id,
    ]);
    return rows.find((row) => row.id === id);
  }
  /** Provenance only for an undispatched prepared job; never grants dispatch or reserves shared funds. */
  async preparedAuthorizationId(c: PoolClient): Promise<string | null> {
    if (!this.config.enabled) return null;
    const row = this.ownerConfig
      ? (
          await c.query(
            "SELECT id FROM live_test_sessions WHERE scope_id=$1 AND mode='owner' AND config_hash=$2 AND owner_handle=$3",
            [GENERATION_SCOPE_ID, this.identity(), this.ownerConfig.ownerHandle],
          )
        ).rows[0]
      : (
          await c.query(
            "SELECT id FROM live_test_sessions WHERE id=$1 AND owner_id=$2 AND mode='manual'",
            [this.config.sessionId, this.config.ownerId],
          )
        ).rows[0];
    return row?.id ?? null;
  }
  async authorizationId(userId: string): Promise<string | undefined> {
    await this.owner(userId);
    if (!this.ownerConfig) return this.config.sessionId;
    const row = (
      await this.db.query(
        "SELECT id,owner_id,config_hash FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'",
        [GENERATION_SCOPE_ID],
      )
    )[0];
    if (row && (row.owner_id !== userId || row.config_hash !== this.identity()))
      fail(409, 'GENERATION_CONFIG_IMMUTABLE', 'GENERATION_CONFIG_IMMUTABLE');
    return row?.id;
  }
  async resolveAuthorizationId(
    c: PoolClient,
    userId: string,
    suppliedId?: string,
  ): Promise<string> {
    await this.ownerTx(c, userId);
    let id = suppliedId;
    if (this.ownerConfig) {
      const row = (
        await c.query("SELECT id FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'", [
          GENERATION_SCOPE_ID,
        ])
      ).rows[0];
      if (!row) fail(409, 'GENERATION_CONSENT_REQUIRED', 'GENERATION_CONSENT_REQUIRED');
      if (id && id !== row.id)
        fail(403, 'GENERATION_AUTHORIZATION_FORBIDDEN', 'GENERATION_AUTHORIZATION_FORBIDDEN');
      id = row.id;
    }
    if (!id) fail(403, 'LIVE_SESSION_FORBIDDEN', 'LIVE_SESSION_FORBIDDEN');
    await this.session(c, id!, userId);
    return id!;
  }
  private async enableExclusiveScope(c: PoolClient) {
    if (!this.config.estimateRiskApproved) return;
    const row = (
      await c.query(
        'SELECT serialize_outstanding FROM generation_budget_scopes WHERE id=$1 FOR UPDATE',
        [GENERATION_SCOPE_ID],
      )
    ).rows[0];
    if (!row || row.serialize_outstanding) return;
    const held = Number(
      (
        await c.query(
          "SELECT count(*) AS count FROM generation_budget_reservations WHERE scope_id=$1 AND status='held'",
          [GENERATION_SCOPE_ID],
        )
      ).rows[0].count,
    );
    if (held > 1)
      fail(
        409,
        'LIVE_EXISTING_RESERVATIONS_REQUIRE_RESOLUTION',
        'LIVE_EXISTING_RESERVATIONS_REQUIRE_RESOLUTION',
      );
    await c.query('UPDATE generation_budget_scopes SET serialize_outstanding=true WHERE id=$1', [
      GENERATION_SCOPE_ID,
    ]);
  }
  async claim(userId: string, input: unknown) {
    await this.owner(userId);
    z.object({ consent: z.literal(true) })
      .strict()
      .parse(input);
    if (!this.pricingCurrent())
      fail(409, 'GENERATION_PRICING_EXPIRED', 'GENERATION_PRICING_EXPIRED');
    if (
      !this.ownerConfig &&
      (!this.config.expiresAt || this.config.expiresAt.getTime() <= Date.now())
    )
      fail(409, 'LIVE_TEST_EXPIRED', 'LIVE_TEST_EXPIRED');
    await this.db.tx(async (c) => {
      await this.ownerTx(c, userId);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `generation-claim:${GENERATION_SCOPE_ID}`,
      ]);
      const sessions = (
        await c.query('SELECT * FROM live_test_sessions WHERE scope_id=$1 ORDER BY id FOR UPDATE', [
          GENERATION_SCOPE_ID,
        ])
      ).rows;
      const owner = sessions.find((row) => row.mode === 'owner');
      if (!this.ownerConfig && owner)
        fail(409, 'GENERATION_MODE_IMMUTABLE', 'GENERATION_MODE_IMMUTABLE');
      if (this.ownerConfig && sessions.some((row) => row.owner_id !== userId))
        fail(403, 'GENERATION_OWNER_IMMUTABLE', 'GENERATION_OWNER_IMMUTABLE');
      const caps = this.budgetCaps();
      await c.query(
        'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,image_cap_micros,text_cap_micros) VALUES($1,true,$2,$3,$4) ON CONFLICT DO NOTHING',
        [GENERATION_SCOPE_ID, caps.totalCapMicros, caps.imageCapMicros, caps.textCapMicros],
      );
      const scope = (
        await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [
          GENERATION_SCOPE_ID,
        ])
      ).rows[0];
      if (this.ownerConfig) {
        await fenceGenerationAdmission(c);
        if (owner) {
          if (
            owner.config_hash !== this.identity() ||
            owner.owner_handle !== this.ownerConfig.ownerHandle ||
            Number(owner.cap_micros) !== Number(scope.total_cap_micros) ||
            Number(owner.text_cap_micros) !== Number(scope.text_cap_micros) ||
            Number(owner.image_cap_micros) !== Number(scope.image_cap_micros)
          )
            fail(409, 'GENERATION_CONFIG_IMMUTABLE', 'GENERATION_CONFIG_IMMUTABLE');
          if (owner.state !== 'active' || scope.blocked || !scope.approved)
            fail(409, 'LIVE_SESSION_STOPPED', 'LIVE_SESSION_STOPPED');
          return;
        }
        if (!scope.approved)
          fail(
            409,
            'GENERATION_PRIOR_AUTHORIZATION_REVOKED',
            'GENERATION_PRIOR_AUTHORIZATION_REVOKED',
          );
        await this.historicalSafety(c, userId, true);
        // A mode change cannot raise a historical ceiling. Explicit budget amendment is separate.
        caps.totalCapMicros = Math.min(caps.totalCapMicros, Number(scope.total_cap_micros));
        caps.textCapMicros = Math.min(caps.textCapMicros, Number(scope.text_cap_micros));
        caps.imageCapMicros = Math.min(caps.imageCapMicros, Number(scope.image_cap_micros));
        const usage = (
          await c.query(
            "SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END),0) total,COALESCE(sum(CASE WHEN kind='text' AND status='settled' THEN actual_micros ELSE 0 END),0) text,COALESCE(sum(CASE WHEN kind='image' AND status='settled' THEN actual_micros ELSE 0 END),0) image FROM generation_budget_reservations WHERE scope_id=$1",
            [GENERATION_SCOPE_ID],
          )
        ).rows[0];
        if (
          Number(usage.total) > caps.totalCapMicros ||
          Number(usage.text) > caps.textCapMicros ||
          Number(usage.image) > caps.imageCapMicros
        )
          fail(
            409,
            'GENERATION_CAP_BELOW_HISTORICAL_SPEND',
            'GENERATION_CAP_BELOW_HISTORICAL_SPEND',
          );
        await c.query(
          'UPDATE generation_budget_scopes SET total_cap_micros=$2,text_cap_micros=$3,image_cap_micros=$4,serialize_outstanding=true WHERE id=$1',
          [GENERATION_SCOPE_ID, caps.totalCapMicros, caps.textCapMicros, caps.imageCapMicros],
        );
        await c.query(
          "INSERT INTO live_test_sessions(id,owner_id,scope_id,expires_at,cap_micros,state,mode,config_hash,owner_handle,text_cap_micros,image_cap_micros) VALUES($1,$2,$3,NULL,$4,'active','owner',$5,$6,$7,$8)",
          [
            randomUUID(),
            userId,
            GENERATION_SCOPE_ID,
            caps.totalCapMicros,
            this.identity(),
            this.ownerConfig.ownerHandle,
            caps.textCapMicros,
            caps.imageCapMicros,
          ],
        );
        await c.query(
          "UPDATE live_test_sessions SET state='stopped',stop_code=COALESCE(stop_code,'OWNER_GENERATION_MODE_ACTIVE') WHERE scope_id=$1 AND mode='manual' AND state='active'",
          [GENERATION_SCOPE_ID],
        );
      } else {
        await c.query(
          "INSERT INTO live_test_sessions(id,owner_id,scope_id,expires_at,cap_micros,state) VALUES($1,$2,$3,$4,1000000,'active') ON CONFLICT DO NOTHING",
          [this.config.sessionId, userId, GENERATION_SCOPE_ID, this.config.expiresAt],
        );
        await this.enableExclusiveScope(c);
        const row = (
          await c.query("SELECT * FROM live_test_sessions WHERE scope_id=$1 AND mode='manual'", [
            GENERATION_SCOPE_ID,
          ])
        ).rows[0];
        if (
          !row ||
          row.id !== this.config.sessionId ||
          row.owner_id !== userId ||
          new Date(row.expires_at).getTime() !== this.config.expiresAt!.getTime()
        )
          fail(409, 'LIVE_GRANT_IMMUTABLE', 'LIVE_GRANT_IMMUTABLE');
      }
    });
    return this.status(userId);
  }
  async requireOwner(userId: string) {
    await this.owner(userId);
  }
  async authorizeText(
    c: PoolClient,
    userId: string,
    sessionId: string | undefined,
    singleOutstanding = false,
  ): Promise<ImagePolicy> {
    await this.owner(userId);
    if (
      !(
        await c.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [userId])
      ).rowCount
    )
      fail(403, 'FORBIDDEN', 'FORBIDDEN');
    await this.resolveAuthorizationId(c, userId, sessionId);
    if (singleOutstanding) {
      const count = Number(
        (
          await c.query(
            "SELECT count(*) AS count FROM generation_budget_reservations WHERE scope_id=$1 AND status='held'",
            [GENERATION_SCOPE_ID],
          )
        ).rows[0].count,
      );
      if (count > 1)
        fail(
          409,
          'LIVE_EXISTING_RESERVATIONS_REQUIRE_RESOLUTION',
          'LIVE_EXISTING_RESERVATIONS_REQUIRE_RESOLUTION',
        );
      await c.query('UPDATE generation_budget_scopes SET serialize_outstanding=true WHERE id=$1', [
        GENERATION_SCOPE_ID,
      ]);
    }
    return this.effectivePolicy(c);
  }
  private async overdueDispatch(c: PoolClient, reservationId: string) {
    return !!(
      await c.query(
        `SELECT 1 FROM live_test_text_permits WHERE reservation_id=$1
      AND (state='unknown' OR (state='dispatched' AND dispatched_at<=clock_timestamp()-interval '60 seconds'))
      UNION ALL SELECT 1 FROM live_authoring_text_jobs WHERE reservation_id=$1
      AND (status='unknown' OR (status='dispatched' AND deadline_at<=clock_timestamp())) LIMIT 1`,
        [reservationId],
      )
    ).rowCount;
  }
  async settleLiveSpend(
    c: PoolClient,
    sessionId: string,
    reservationId: string,
    actualMicros: number | null,
    code: string,
  ) {
    const session = (
      await c.query(
        'SELECT s.id,s.scope_id FROM live_test_sessions s JOIN generation_budget_reservations r ON r.scope_id=s.scope_id WHERE s.id=$1 AND r.id=$2',
        [sessionId, reservationId],
      )
    ).rows[0];
    if (!session) fail(409, 'LIVE_RESERVATION_MISMATCH', 'LIVE_RESERVATION_MISMATCH');
    await this.lockAuthorization(c, sessionId);
    const overdue = await this.overdueDispatch(c, reservationId);
    if (actualMicros !== null) await settleGenerationSpend(c, reservationId, actualMicros);
    const reserve = (
      await c.query('SELECT upper_micros FROM generation_budget_reservations WHERE id=$1', [
        reservationId,
      ])
    ).rows[0];
    if (
      overdue ||
      actualMicros === null ||
      code === 'PROVIDER_HTTP_403' ||
      code === 'PROVIDER_DEADLINE_EXCEEDED' ||
      code === 'PROVIDER_LIMIT_VIOLATION' ||
      (actualMicros !== null && actualMicros > Number(reserve.upper_micros))
    ) {
      await c.query(
        "UPDATE live_test_sessions SET state='stopped',stop_code=COALESCE(stop_code,$2) WHERE id=$1",
        [sessionId, overdue ? 'PROVIDER_DEADLINE_EXCEEDED' : code],
      );
      await c.query('UPDATE generation_budget_scopes SET blocked=true WHERE id=$1', [
        session.scope_id,
      ]);
    }
  }
  async authorizeImage(c: PoolClient, userId: string, sessionId?: string): Promise<ImagePolicy> {
    await this.owner(userId);
    const id = await this.resolveAuthorizationId(c, userId, sessionId);
    // The grant supplies rights/caps only; an image factory must supply its own cost evidence.
    return {
      ...(await this.effectivePolicy(c)),
      verifiedUpperMicros: null,
      ...(this.ownerConfig
        ? {
            generationMode: 'owner' as const,
            generationAuthorizationId: id,
            generationConfigFingerprint: this.ownerConfig.configFingerprint,
          }
        : {}),
    };
  }
  private async session(c: PoolClient, sessionId: string, userId: string) {
    if (!this.config.enabled) fail(409, 'LIVE_TEST_DISABLED', 'LIVE_TEST_DISABLED');
    await this.ownerTx(c, userId);
    const s = await this.lockAuthorization(c, sessionId);
    if (!s || s.owner_id !== userId || s.scope_id !== GENERATION_SCOPE_ID)
      fail(403, 'LIVE_SESSION_FORBIDDEN', 'LIVE_SESSION_FORBIDDEN');
    const scope = (
      await c.query('SELECT * FROM generation_budget_scopes WHERE id=$1', [s.scope_id])
    ).rows[0];
    if (this.ownerConfig) {
      if (
        s.mode !== 'owner' ||
        s.expires_at !== null ||
        s.config_hash !== this.identity() ||
        s.owner_handle !== this.ownerConfig.ownerHandle
      )
        fail(409, 'GENERATION_CONFIG_IMMUTABLE', 'GENERATION_CONFIG_IMMUTABLE');
      if (!this.pricingCurrent())
        fail(409, 'GENERATION_PRICING_EXPIRED', 'GENERATION_PRICING_EXPIRED');
      const caps = this.budgetCaps();
      if (
        Number(scope.total_cap_micros) !== Number(s.cap_micros) ||
        Number(scope.text_cap_micros) !== Number(s.text_cap_micros) ||
        Number(scope.image_cap_micros) !== Number(s.image_cap_micros) ||
        Number(s.cap_micros) > caps.totalCapMicros ||
        Number(s.text_cap_micros) > caps.textCapMicros ||
        Number(s.image_cap_micros) > caps.imageCapMicros ||
        !scope.serialize_outstanding
      )
        fail(409, 'GENERATION_CONFIG_IMMUTABLE', 'GENERATION_CONFIG_IMMUTABLE');
      await this.historicalSafety(c, userId);
    } else {
      if (s.mode !== 'manual' || !s.expires_at || sessionId !== this.config.sessionId)
        fail(403, 'LIVE_SESSION_FORBIDDEN', 'LIVE_SESSION_FORBIDDEN');
      if (
        (
          await c.query("SELECT 1 FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'", [
            GENERATION_SCOPE_ID,
          ])
        ).rowCount
      )
        fail(409, 'GENERATION_MODE_IMMUTABLE', 'GENERATION_MODE_IMMUTABLE');
      if (
        !this.config.expiresAt ||
        new Date(s.expires_at).getTime() !== this.config.expiresAt.getTime()
      )
        fail(409, 'LIVE_GRANT_IMMUTABLE', 'LIVE_GRANT_IMMUTABLE');
      if (new Date(s.expires_at).getTime() <= Date.now())
        fail(409, 'LIVE_TEST_EXPIRED', 'LIVE_TEST_EXPIRED');
    }
    if (s.state !== 'active' || scope.blocked || !scope.approved)
      fail(409, 'LIVE_SESSION_STOPPED', 'LIVE_SESSION_STOPPED');
    const unknown = (
      await c.query(
        "SELECT 1 FROM generation_budget_reservations b JOIN image_generation_jobs j ON j.reservation_id=b.id WHERE b.scope_id=$1 AND j.mode='external' AND (j.status='unknown' OR j.safe_diagnostic->>'httpStatus'='403' OR (j.status='dispatched' AND j.dispatch_deadline<=now())) UNION ALL SELECT 1 FROM live_test_text_permits p JOIN live_test_sessions a ON a.id=p.session_id WHERE a.scope_id=$1 AND (p.state='unknown' OR (p.state='dispatched' AND p.dispatched_at<=now()-interval '60 seconds')) LIMIT 1",
        [s.scope_id],
      )
    ).rowCount;
    if (unknown) fail(409, 'LIVE_OUTCOME_UNRESOLVED', 'LIVE_OUTCOME_UNRESOLVED');
    if (
      (await c.query("SELECT to_regclass('live_authoring_text_jobs') AS present")).rows[0].present
    ) {
      if (
        (
          await c.query(
            "SELECT 1 FROM live_authoring_text_jobs j JOIN live_test_sessions a ON a.id=j.session_id WHERE a.scope_id=$1 AND (j.status='unknown' OR (j.status='dispatched' AND j.deadline_at<=now())) LIMIT 1",
            [s.scope_id],
          )
        ).rowCount
      )
        fail(409, 'LIVE_OUTCOME_UNRESOLVED', 'LIVE_OUTCOME_UNRESOLVED');
    }
    await this.enableExclusiveScope(c);
    return s;
  }
  private async campaign(c: PoolClient, campaignId: string, userId: string) {
    const row = (
      await c.query(
        `SELECT c.state FROM game_campaigns c JOIN users u ON u.id=c.owner_id WHERE c.id=$1 AND c.owner_id=$2 AND c.status='active' AND u.deleted_at IS NULL AND EXISTS(SELECT 1 FROM game_members m WHERE m.campaign_id=c.id AND m.user_id=$2 AND m.status='accepted') AND ${sourceAccessSql('$2')} FOR SHARE OF c`,
        [campaignId, userId],
      )
    ).rows[0];
    if (!row) fail(403, 'FORBIDDEN', 'FORBIDDEN');
    const turn = row.state.turnController;
    if (!turn || turn.phase !== 'world')
      fail(409, 'LIVE_WORLD_PHASE_REQUIRED', 'LIVE_WORLD_PHASE_REQUIRED');
    return turn;
  }
  async pending(userId: string, campaignId: string) {
    await this.owner(userId);
    z.uuid().parse(campaignId);
    return this.db.tx(async (c) => {
      const turn = await this.campaign(c, campaignId, userId);
      const rows = (
        await c.query(
          "SELECT r.id,r.npc_id,r.purpose,r.result_code,p.state AS permit_state FROM game_npc_decision_requests r LEFT JOIN live_test_text_permits p ON p.request_id=r.id WHERE r.campaign_id=$1 AND r.status IN ('queued','scheduled') ORDER BY CASE WHEN r.context ? 'turnOrder' THEN (r.context->>'turnOrder')::bigint ELSE 9223372036854775807 END,r.created_at,r.id LIMIT 16",
          [campaignId],
        )
      ).rows;
      return {
        turnFence: { roundId: turn.roundId, phaseEpoch: turn.phaseEpoch, rulesetVersion: 1 },
        requests: rows.map((r) => ({
          id: r.id,
          subjectId: r.npc_id,
          purpose: r.purpose,
          errorCode: r.result_code ?? null,
          permitState: r.permit_state ?? null,
          upperMicros: this.textUpperMicros(),
        })),
      };
    });
  }
  async consent(userId: string, campaignId: string, requestId: string, input: unknown) {
    await this.owner(userId);
    z.uuid().parse(campaignId);
    z.uuid().parse(requestId);
    const v = consentSchema.parse(input);
    return this.db.tx(async (c) => {
      const sessionId = await this.resolveAuthorizationId(
        c,
        userId,
        v.authorizationId ?? v.sessionId,
      );
      const previous = (
        await c.query(
          'SELECT * FROM live_test_text_permits WHERE session_id=$1 AND operation_id=$2',
          [sessionId, v.operationId],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_id !== requestId || previous.campaign_id !== campaignId)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return { id: previous.id, state: previous.state };
      }
      if (
        (await c.query('SELECT 1 FROM live_test_text_permits WHERE request_id=$1', [requestId]))
          .rowCount
      )
        fail(409, 'MANUAL_REQUEST_ALREADY_AUTHORIZED', 'MANUAL_REQUEST_ALREADY_AUTHORIZED');
      const turn = await this.campaign(c, campaignId, userId);
      if (
        turn.roundId !== v.turnFence.roundId ||
        turn.phaseEpoch !== v.turnFence.phaseEpoch ||
        turn.ruleset.version !== v.turnFence.rulesetVersion
      )
        fail(409, 'TURN_PHASE_STALE', 'TURN_PHASE_STALE');
      const r = (
        await c.query(
          "SELECT * FROM game_npc_decision_requests WHERE id=$1 AND campaign_id=$2 AND status IN ('queued','scheduled') FOR UPDATE",
          [requestId, campaignId],
        )
      ).rows[0];
      if (r?.context?.budgetExceeded)
        fail(413, 'CONTEXT_BUDGET_EXCEEDED', 'CONTEXT_BUDGET_EXCEEDED');
      if (!r || !['speech', 'plan', 'story_turn', 'narrative'].includes(r.purpose))
        fail(409, 'LIVE_REQUEST_UNAVAILABLE', 'LIVE_REQUEST_UNAVAILABLE');
      if (
        r.status === 'scheduled' &&
        !(
          await c.query(
            "SELECT 1 FROM npc_ai_jobs WHERE id=$1 AND status='reserved' AND NOT cancel_requested",
            [r.job_id],
          )
        ).rowCount
      )
        fail(409, 'LIVE_REQUEST_UNAVAILABLE', 'LIVE_REQUEST_UNAVAILABLE');
      if (
        r.context.turnFence?.roundId !== turn.roundId ||
        r.context.turnFence?.phaseEpoch !== turn.phaseEpoch
      )
        fail(409, 'TURN_PHASE_STALE', 'TURN_PHASE_STALE');
      if (r.requester_user_id && r.requester_user_id !== userId)
        fail(403, 'FORBIDDEN', 'FORBIDDEN');
      const reservation = await reserveGenerationSpend(
        c,
        await this.effectivePolicy(c),
        userId,
        'text',
        `manual-text:${requestId}`,
        this.textUpperMicros(),
      );
      const id = randomUUID();
      await c.query(
        "INSERT INTO live_test_text_permits(id,session_id,campaign_id,request_id,operation_id,context_hash,round_id,phase_epoch,reservation_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'authorized')",
        [
          id,
          sessionId,
          campaignId,
          requestId,
          v.operationId,
          digest(r.context),
          turn.roundId,
          turn.phaseEpoch,
          reservation,
        ],
      );
      return { id, state: 'authorized', upperMicros: this.textUpperMicros() };
    });
  }
  async requestAuthorized(requestId: string, context?: unknown) {
    if (!this.config.enabled) return false;
    try {
      return await this.db.tx(async (c) => {
        const row = (
          await c.query(
            "SELECT p.session_id,p.context_hash,s.owner_id FROM live_test_text_permits p JOIN live_test_sessions s ON s.id=p.session_id WHERE p.request_id=$1 AND p.state='authorized'",
            [requestId],
          )
        ).rows[0];
        if (!row) return false;
        await this.session(c, row.session_id, row.owner_id);
        return context === undefined || row.context_hash === digest(context);
      });
    } catch {
      return false;
    }
  }
  /** Only the owning AI queue may release linked jobs. This path proves no job/dispatch ever existed. */
  async rejectUndispatchedRequest(c: PoolClient, requestId: string, code: string) {
    const source = (
      await c.query('SELECT campaign_id FROM game_npc_decision_requests WHERE id=$1', [requestId])
    ).rows[0];
    if (!source) return false;
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `npc-ai:${source.campaign_id}`,
    ]);
    const initial = (
      await c.query('SELECT session_id FROM live_test_text_permits WHERE request_id=$1', [
        requestId,
      ])
    ).rows[0];
    if (!initial) {
      // An active manual session deliberately waits for the owner's consent. Once
      // that immutable grant expires/stops, an entirely unapproved request must
      // not strand the world phase. Do not confuse "no permit" with free cost:
      // serialize with consent, then prove no permit, job or ledger record exists.
      const configuredId = this.ownerConfig
        ? (
            await c.query("SELECT id FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'", [
              GENERATION_SCOPE_ID,
            ])
          ).rows[0]?.id
        : this.config.sessionId;
      if (!configuredId) return false;
      const session = (
        await c.query('SELECT state,expires_at FROM live_test_sessions WHERE id=$1 FOR UPDATE', [
          configuredId,
        ])
      ).rows[0];
      const expired =
        (this.config.expiresAt?.getTime() ?? Infinity) <= Date.now() ||
        (session?.expires_at && new Date(session.expires_at).getTime() <= Date.now()) ||
        !this.pricingCurrent();
      if (!expired && session?.state !== 'stopped') return false;
      const request = (
        await c.query(
          'SELECT status,job_id FROM game_npc_decision_requests WHERE id=$1 FOR UPDATE',
          [requestId],
        )
      ).rows[0];
      if (!request || request.status !== 'queued' || request.job_id) return false;
      if (
        (await c.query('SELECT 1 FROM live_test_text_permits WHERE request_id=$1', [requestId]))
          .rowCount ||
        (
          await c.query(
            "SELECT 1 FROM npc_ai_jobs WHERE request_meta->>'runtimeRequestId'=$1 OR operation_id=$1::uuid LIMIT 1",
            [requestId],
          )
        ).rowCount ||
        (
          await c.query(
            'SELECT 1 FROM generation_budget_reservations WHERE operation_key=$1 LIMIT 1',
            [`manual-text:${requestId}`],
          )
        ).rowCount
      )
        return false;
      return true;
    }
    await this.lockAuthorization(c, initial.session_id);
    const permit = (
      await c.query('SELECT * FROM live_test_text_permits WHERE request_id=$1 FOR UPDATE', [
        requestId,
      ])
    ).rows[0];
    if (!permit || permit.state !== 'authorized' || permit.dispatched_at || permit.job_id)
      return false;
    if (
      (
        await c.query(
          "SELECT 1 FROM npc_ai_jobs WHERE request_meta->>'runtimeRequestId'=$1 LIMIT 1",
          [requestId],
        )
      ).rowCount
    )
      return false;
    await settleGenerationSpend(c, permit.reservation_id, 0);
    await c.query(
      "UPDATE live_test_text_permits SET state='cancelled',completed_at=now(),result_code=$2 WHERE id=$1",
      [permit.id, /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'MANUAL_REQUEST_UNAVAILABLE'],
    );
    return true;
  }
  async canDispatchJob(jobId: string) {
    const rows = await this.db.query('SELECT request_meta FROM npc_ai_jobs WHERE id=$1', [jobId]);
    return (
      !!rows[0]?.request_meta?.runtimeRequestId &&
      this.requestAuthorized(rows[0].request_meta.runtimeRequestId)
    );
  }
  async begin(request: ProviderRequest) {
    return this.db.tx(async (c) => {
      const j = (await c.query('SELECT * FROM npc_ai_jobs WHERE id=$1 FOR UPDATE', [request.jobId]))
        .rows[0];
      const rId = j?.request_meta?.runtimeRequestId;
      const peek = (
        await c.query('SELECT session_id FROM live_test_text_permits WHERE request_id=$1', [
          rId ?? null,
        ])
      ).rows[0];
      if (!peek) fail(403, 'MANUAL_LIVE_CONSENT_REQUIRED', 'MANUAL_LIVE_CONSENT_REQUIRED');
      const grant = (
        await c.query('SELECT owner_id FROM live_test_sessions WHERE id=$1', [peek.session_id])
      ).rows[0];
      if (!grant) fail(403, 'MANUAL_LIVE_CONSENT_REQUIRED', 'MANUAL_LIVE_CONSENT_REQUIRED');
      await this.session(c, peek.session_id, grant.owner_id);
      const p = (
        await c.query('SELECT * FROM live_test_text_permits WHERE request_id=$1 FOR UPDATE', [rId])
      ).rows[0];
      if (!p || p.state !== 'authorized')
        fail(403, 'MANUAL_LIVE_CONSENT_REQUIRED', 'MANUAL_LIVE_CONSENT_REQUIRED');
      await this.session(c, p.session_id, grant.owner_id);
      const turn = await this.campaign(c, p.campaign_id, grant.owner_id);
      if (
        turn.roundId !== p.round_id ||
        turn.phaseEpoch !== Number(p.phase_epoch) ||
        digest(request.context) !== p.context_hash
      )
        fail(409, 'TURN_PHASE_STALE', 'TURN_PHASE_STALE');
      // A dispatch already begun with no final cost is an unknown liability, never retried.
      const unresolved = (
        await c.query(
          "SELECT id FROM live_test_text_permits WHERE session_id=$1 AND state IN ('dispatched','unknown') LIMIT 1",
          [p.session_id],
        )
      ).rowCount;
      if (unresolved) fail(409, 'LIVE_OUTCOME_UNRESOLVED', 'LIVE_OUTCOME_UNRESOLVED');
      await c.query(
        "UPDATE live_test_text_permits SET state='dispatched',dispatched_at=now(),job_id=$2 WHERE id=$1",
        [p.id, request.jobId],
      );
      return p.id as string;
    });
  }
  async complete(id: string, actual: number | null, code: string, requestId?: string) {
    await this.db.tx(async (c) => {
      const peek = (
        await c.query('SELECT session_id FROM live_test_text_permits WHERE id=$1', [id])
      ).rows[0];
      if (!peek) return;
      await this.lockAuthorization(c, peek.session_id);
      const p = (await c.query('SELECT * FROM live_test_text_permits WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!p) return;
      const overdue = await this.overdueDispatch(c, p.reservation_id);
      if (actual !== null) await settleGenerationSpend(c, p.reservation_id, actual);
      const reserve = (
        await c.query('SELECT upper_micros FROM generation_budget_reservations WHERE id=$1', [
          p.reservation_id,
        ])
      ).rows[0];
      const stop =
        overdue ||
        actual === null ||
        code === 'PROVIDER_HTTP_403' ||
        code === 'PROVIDER_DEADLINE_EXCEEDED' ||
        (actual !== null && actual > Number(reserve.upper_micros));
      if (stop) {
        await c.query(
          "UPDATE live_test_sessions SET state='stopped',stop_code=COALESCE(stop_code,$2) WHERE id=$1",
          [p.session_id, overdue ? 'PROVIDER_DEADLINE_EXCEEDED' : code],
        );
        await c.query(
          'UPDATE generation_budget_scopes SET blocked=true WHERE id=(SELECT scope_id FROM live_test_sessions WHERE id=$1)',
          [p.session_id],
        );
      }
      const erased = p.context_hash === 'erased' || p.result_code === 'DATA_ERASED';
      await c.query(
        'UPDATE live_test_text_permits SET state=$2,completed_at=now(),result_code=$3,provider_request_id=$4 WHERE id=$1',
        [
          id,
          actual === null ? 'unknown' : 'settled',
          erased ? 'DATA_ERASED' : code,
          erased ? null : (requestId ?? null),
        ],
      );
    });
  }
  async settleJob(c: PoolClient, jobId: string, actual: number | null, unknown: boolean) {
    const peek = (
      await c.query(
        "SELECT p.id,p.session_id FROM live_test_text_permits p JOIN npc_ai_jobs j ON (j.id=p.job_id OR j.request_meta->>'runtimeRequestId'=p.request_id::text) WHERE j.id=$1",
        [jobId],
      )
    ).rows[0];
    if (!peek) return;
    await this.lockAuthorization(c, peek.session_id);
    const p = (
      await c.query('SELECT * FROM live_test_text_permits WHERE id=$1 FOR UPDATE', [peek.id])
    ).rows[0];
    if (p.state === 'authorized' && actual === 0 && !unknown) {
      await settleGenerationSpend(c, p.reservation_id, 0);
      await c.query(
        "UPDATE live_test_text_permits SET state='cancelled',completed_at=now(),result_code='UNDISPATCHED_OR_CACHE' WHERE id=$1",
        [p.id],
      );
    } else if (p.state === 'unknown' && !unknown && actual !== null) {
      await settleGenerationSpend(c, p.reservation_id, actual);
      await c.query(
        "UPDATE live_test_text_permits SET state='settled',completed_at=now(),result_code=CASE WHEN context_hash='erased' OR result_code='DATA_ERASED' THEN 'DATA_ERASED' ELSE 'LATE_COST_RECONCILED' END WHERE id=$1",
        [p.id],
      );
    } else if (p.state === 'dispatched' && unknown) {
      await c.query(
        "UPDATE live_test_text_permits SET state='unknown',result_code='PROVIDER_OUTCOME_UNKNOWN' WHERE id=$1",
        [p.id],
      );
      await c.query(
        "UPDATE live_test_sessions SET state='stopped',stop_code='PROVIDER_OUTCOME_UNKNOWN' WHERE id=$1",
        [peek.session_id],
      );
      await c.query(
        'UPDATE generation_budget_scopes SET blocked=true WHERE id=(SELECT scope_id FROM live_test_sessions WHERE id=$1)',
        [peek.session_id],
      );
    }
  }
  async status(userId: string) {
    await this.owner(userId);
    if (this.ownerConfig) return this.ownerStatus(userId);
    const rows = await this.db.query(
      'SELECT * FROM live_test_sessions WHERE id=$1 AND owner_id=$2',
      [this.config.sessionId, userId],
    );
    const usage = (
      await this.db.query(
        "SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END),0) AS used,COALESCE(sum(CASE WHEN status='held' THEN upper_micros ELSE 0 END),0) AS held FROM generation_budget_reservations WHERE scope_id=$1",
        [GENERATION_SCOPE_ID],
      )
    )[0];
    const prior = (
      await this.db.query(
        "SELECT count(*) AS unknown FROM generation_budget_reservations WHERE scope_id<>$1 AND status='held'",
        [GENERATION_SCOPE_ID],
      )
    )[0];
    const expired = !this.config.expiresAt || this.config.expiresAt.getTime() <= Date.now();
    let unsafe =
      (
        await this.db.query(
          "SELECT 1 FROM generation_budget_reservations b JOIN image_generation_jobs j ON j.reservation_id=b.id WHERE b.scope_id=$1 AND j.mode='external' AND (j.status='unknown' OR j.safe_diagnostic->>'httpStatus'='403' OR (j.status='dispatched' AND j.dispatch_deadline<=now())) UNION ALL SELECT 1 FROM live_test_text_permits p WHERE p.session_id=$2 AND (p.state='unknown' OR (p.state='dispatched' AND p.dispatched_at<=now()-interval '60 seconds')) LIMIT 1",
          [GENERATION_SCOPE_ID, this.config.sessionId],
        )
      ).length > 0;
    if (
      (await this.db.query("SELECT to_regclass('live_authoring_text_jobs') AS present"))[0].present
    ) {
      const authoringUnknown = await this.db.query(
        "SELECT 1 FROM live_authoring_text_jobs WHERE session_id=$1 AND (status='unknown' OR (status='dispatched' AND deadline_at<=now())) LIMIT 1",
        [this.config.sessionId],
      );
      unsafe = unsafe || authoringUnknown.length > 0;
    }
    return {
      mode: 'manual' as const,
      authorizationId: this.config.sessionId,
      pricingValidUntil: null,
      enabled: !expired,
      sessionId: this.config.sessionId,
      state: expired || unsafe ? 'stopped' : (rows[0]?.state ?? 'unclaimed'),
      expiresAt: this.config.expiresAt?.toISOString() ?? null,
      stopCode:
        rows[0]?.stop_code ??
        (expired ? 'LIVE_TEST_EXPIRED' : unsafe ? 'LIVE_OUTCOME_UNRESOLVED' : null),
      capMicros: LIVE_TEXT.capMicros,
      usedMicros: Number(usage.used),
      heldMicros: Number(usage.held),
      remainingMicros: Math.max(0, LIVE_TEXT.capMicros - Number(usage.used)),
      priorHeldReservations: Number(prior.unknown),
      text: {
        ...LIVE_TEXT,
        costEvidence: 'conservative_configured_rates',
        reasoningEffort: 'none',
        serviceTier: 'default',
        tools: [],
        store: false,
      },
      imagesEnabled: false,
      imageBlockCode: 'VERIFIED_IMAGE_UPPER_BOUND_REQUIRED',
    };
  }
  private async ownerStatus(userId: string) {
    const cfg = this.ownerConfig!;
    const row = (
      await this.db.query("SELECT * FROM live_test_sessions WHERE scope_id=$1 AND mode='owner'", [
        GENERATION_SCOPE_ID,
      ])
    )[0];
    const scope = (
      await this.db.query(
        'SELECT approved,total_cap_micros,text_cap_micros,image_cap_micros FROM generation_budget_scopes WHERE id=$1',
        [GENERATION_SCOPE_ID],
      )
    )[0];
    const effectiveCap = Math.min(
      cfg.totalCapMicros,
      Number(row?.cap_micros ?? scope?.total_cap_micros ?? cfg.totalCapMicros),
    );
    const effectiveTextCap = Math.min(
      cfg.textCapMicros,
      Number(row?.text_cap_micros ?? scope?.text_cap_micros ?? cfg.textCapMicros),
    );
    const effectiveImageCap = Math.min(
      cfg.imageCapMicros,
      Number(row?.image_cap_micros ?? scope?.image_cap_micros ?? cfg.imageCapMicros),
    );
    const usage = (
      await this.db.query(
        "SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END),0) used,COALESCE(sum(CASE WHEN status='held' THEN upper_micros ELSE 0 END),0) held,COALESCE(sum(CASE WHEN kind='text' THEN CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END ELSE 0 END),0) text_used,COALESCE(sum(CASE WHEN kind='image' THEN CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END ELSE 0 END),0) image_used FROM generation_budget_reservations WHERE scope_id=$1",
        [GENERATION_SCOPE_ID],
      )
    )[0];
    let stopCode: string | null = row?.stop_code ?? null;
    try {
      await this.db.tx(async (c) => {
        if (row) await this.session(c, row.id, userId);
        else {
          if (scope && !scope.approved)
            fail(
              409,
              'GENERATION_PRIOR_AUTHORIZATION_REVOKED',
              'GENERATION_PRIOR_AUTHORIZATION_REVOKED',
            );
          await this.historicalSafety(c, userId, true);
          if (!this.pricingCurrent())
            fail(409, 'GENERATION_PRICING_EXPIRED', 'GENERATION_PRICING_EXPIRED');
        }
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      stopCode ??= /^[A-Z0-9_]{1,100}$/.test(message)
        ? message
        : 'GENERATION_AUTHORIZATION_UNAVAILABLE';
    }
    return {
      mode: 'owner' as const,
      enabled: true,
      authorizationId: row?.id ?? null,
      sessionId: row?.id ?? null,
      expiresAt: null,
      pricingValidUntil: new Date(
        Math.min(Date.parse(cfg.text.pricing.validUntil), Date.parse(cfg.image.pricing.validUntil)),
      ).toISOString(),
      state: stopCode ? 'stopped' : (row?.state ?? 'unclaimed'),
      stopCode,
      capMicros: effectiveCap,
      textCapMicros: effectiveTextCap,
      imageCapMicros: effectiveImageCap,
      textUsedMicros: Number(usage.text_used),
      imageUsedMicros: Number(usage.image_used),
      textRemainingMicros: Math.max(
        0,
        Math.min(effectiveCap - Number(usage.used), effectiveTextCap - Number(usage.text_used)),
      ),
      imageRemainingMicros: Math.max(
        0,
        Math.min(effectiveCap - Number(usage.used), effectiveImageCap - Number(usage.image_used)),
      ),
      usedMicros: Number(usage.used),
      heldMicros: Number(usage.held),
      remainingMicros: Math.max(0, effectiveCap - Number(usage.used)),
      priorHeldReservations: Number(
        (
          await this.db.query(
            "SELECT count(*) n FROM generation_budget_reservations WHERE scope_id<>$1 AND status='held' AND upper_micros>0",
            [GENERATION_SCOPE_ID],
          )
        )[0].n,
      ),
      text: {
        ...cfg.text,
        scopeId: GENERATION_SCOPE_ID,
        capMicros: effectiveTextCap,
        costEvidence: 'conservative_configured_rates',
        reasoningEffort: 'none',
        serviceTier: 'default',
        tools: [],
        store: false,
      },
      imagesEnabled: false,
      imageBlockCode: 'OWNER_IMAGE_CONFIGURATION_REQUIRED',
    };
  }
}
