import { Inject, Injectable, Optional } from '@nestjs/common';
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
import { LIVE_TEXT, readLiveTestConfig, type LiveTestConfig } from './config';
const fenceSchema = z
  .object({
    roundId: z.string().min(1),
    phaseEpoch: z.number().int().min(0),
    rulesetVersion: z.literal(1),
  })
  .strict();
const consentSchema = z
  .object({
    sessionId: z.uuid(),
    operationId: z.uuid(),
    turnFence: fenceSchema,
    consent: z.literal(true),
  })
  .strict();
@Injectable()
export class LiveTestService {
  readonly config: LiveTestConfig;
  constructor(
    @Inject(Db) readonly db: Db,
    @Optional() @Inject('LIVE_TEST_CONFIG') configuration?: LiveTestConfig,
  ) {
    this.config = configuration ?? readLiveTestConfig();
  }
  private owner(userId: string) {
    if (!this.config.enabled) fail(409, 'LIVE_TEST_DISABLED', 'LIVE_TEST_DISABLED');
    if (userId !== this.config.ownerId) fail(403, 'FORBIDDEN', 'FORBIDDEN');
  }
  private policy(): ImagePolicy {
    return {
      ...defaultImagePolicy,
      scopeId: LIVE_TEXT.scopeId,
      approved: true,
      externalEnabled: true,
      verifiedUpperMicros: LIVE_TEXT.upperMicros,
      totalCapMicros: LIVE_TEXT.capMicros,
      textCapMicros: LIVE_TEXT.capMicros,
      imageCapMicros: LIVE_TEXT.capMicros,
    };
  }
  private async enableExclusiveScope(c: PoolClient) {
    if (!this.config.estimateRiskApproved) return;
    const row = (
      await c.query(
        'SELECT serialize_outstanding FROM generation_budget_scopes WHERE id=$1 FOR UPDATE',
        [LIVE_TEXT.scopeId],
      )
    ).rows[0];
    if (!row || row.serialize_outstanding) return;
    const held = Number(
      (
        await c.query(
          "SELECT count(*) AS count FROM generation_budget_reservations WHERE scope_id=$1 AND status='held'",
          [LIVE_TEXT.scopeId],
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
      LIVE_TEXT.scopeId,
    ]);
  }
  async claim(userId: string, input: unknown) {
    this.owner(userId);
    z.object({ consent: z.literal(true) })
      .strict()
      .parse(input);
    if (this.config.expiresAt!.getTime() <= Date.now())
      fail(409, 'LIVE_TEST_EXPIRED', 'LIVE_TEST_EXPIRED');
    await this.db.tx(async (c) => {
      await c.query(
        'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,image_cap_micros,text_cap_micros) VALUES($1,true,1000000,1000000,1000000) ON CONFLICT DO NOTHING',
        [LIVE_TEXT.scopeId],
      );
      await c.query('SELECT id FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [
        LIVE_TEXT.scopeId,
      ]);
      await c.query(
        "INSERT INTO live_test_sessions(id,owner_id,scope_id,expires_at,cap_micros,state) VALUES($1,$2,$3,$4,1000000,'active') ON CONFLICT DO NOTHING",
        [this.config.sessionId, userId, LIVE_TEXT.scopeId, this.config.expiresAt],
      );
      await this.enableExclusiveScope(c);
      const s = (
        await c.query('SELECT * FROM live_test_sessions WHERE scope_id=$1', [LIVE_TEXT.scopeId])
      ).rows[0];
      if (
        s.id !== this.config.sessionId ||
        s.owner_id !== userId ||
        new Date(s.expires_at).getTime() !== this.config.expiresAt!.getTime()
      )
        fail(409, 'LIVE_GRANT_IMMUTABLE', 'LIVE_GRANT_IMMUTABLE');
    });
    return this.status(userId);
  }
  requireOwner(userId: string) {
    this.owner(userId);
  }
  async authorizeText(
    c: PoolClient,
    userId: string,
    sessionId: string,
    singleOutstanding = false,
  ): Promise<ImagePolicy> {
    this.owner(userId);
    if (
      !(
        await c.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [userId])
      ).rowCount
    )
      fail(403, 'FORBIDDEN', 'FORBIDDEN');
    await this.session(c, sessionId, userId);
    if (singleOutstanding) {
      const count = Number(
        (
          await c.query(
            "SELECT count(*) AS count FROM generation_budget_reservations WHERE scope_id=$1 AND status='held'",
            [LIVE_TEXT.scopeId],
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
        LIVE_TEXT.scopeId,
      ]);
    }
    return this.policy();
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
        'SELECT s.id,s.scope_id FROM live_test_sessions s JOIN generation_budget_reservations r ON r.scope_id=s.scope_id WHERE s.id=$1 AND r.id=$2 FOR UPDATE OF s',
        [sessionId, reservationId],
      )
    ).rows[0];
    if (!session) fail(409, 'LIVE_RESERVATION_MISMATCH', 'LIVE_RESERVATION_MISMATCH');
    await c.query('SELECT id FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [
      session.scope_id,
    ]);
    if (actualMicros !== null) await settleGenerationSpend(c, reservationId, actualMicros);
    const reserve = (
      await c.query('SELECT upper_micros FROM generation_budget_reservations WHERE id=$1', [
        reservationId,
      ])
    ).rows[0];
    if (
      actualMicros === null ||
      code === 'PROVIDER_HTTP_403' ||
      code === 'PROVIDER_LIMIT_VIOLATION' ||
      (actualMicros !== null && actualMicros > Number(reserve.upper_micros))
    ) {
      await c.query(
        "UPDATE live_test_sessions SET state='stopped',stop_code=COALESCE(stop_code,$2) WHERE id=$1",
        [sessionId, code],
      );
      await c.query('UPDATE generation_budget_scopes SET blocked=true WHERE id=$1', [
        session.scope_id,
      ]);
    }
  }
  async authorizeImage(c: PoolClient, userId: string, sessionId: string): Promise<ImagePolicy> {
    this.owner(userId);
    await this.session(c, sessionId, userId);
    // The grant supplies rights/caps only; an image factory must supply its own cost evidence.
    return { ...this.policy(), verifiedUpperMicros: null };
  }
  private async session(c: PoolClient, sessionId: string, userId: string) {
    const s = (
      await c.query(
        'SELECT s.*,b.blocked FROM live_test_sessions s JOIN generation_budget_scopes b ON b.id=s.scope_id WHERE s.id=$1 FOR UPDATE OF s,b',
        [sessionId],
      )
    ).rows[0];
    if (!s || sessionId !== this.config.sessionId || s.owner_id !== userId)
      fail(403, 'LIVE_SESSION_FORBIDDEN', 'LIVE_SESSION_FORBIDDEN');
    if (s.state !== 'active' || s.blocked)
      fail(409, 'LIVE_SESSION_STOPPED', 'LIVE_SESSION_STOPPED');
    const unknown = (
      await c.query(
        "SELECT 1 FROM generation_budget_reservations b JOIN image_generation_jobs j ON j.reservation_id=b.id WHERE b.scope_id=$1 AND (j.status='unknown' OR j.safe_diagnostic->>'httpStatus'='403' OR (j.status='dispatched' AND j.dispatch_deadline<=now())) UNION ALL SELECT 1 FROM live_test_text_permits p WHERE p.session_id=$2 AND (p.state='unknown' OR (p.state='dispatched' AND p.dispatched_at<=now()-interval '60 seconds')) LIMIT 1",
        [s.scope_id, sessionId],
      )
    ).rowCount;
    if (unknown) fail(409, 'LIVE_OUTCOME_UNRESOLVED', 'LIVE_OUTCOME_UNRESOLVED');
    if (
      (await c.query("SELECT to_regclass('live_authoring_text_jobs') AS present")).rows[0].present
    ) {
      const pending = (
        await c.query(
          "SELECT 1 FROM live_authoring_text_jobs WHERE session_id=$1 AND (status='unknown' OR (status='dispatched' AND deadline_at<=now())) LIMIT 1",
          [sessionId],
        )
      ).rowCount;
      if (pending) fail(409, 'LIVE_OUTCOME_UNRESOLVED', 'LIVE_OUTCOME_UNRESOLVED');
    }

    if (new Date(s.expires_at).getTime() <= Date.now())
      fail(409, 'LIVE_TEST_EXPIRED', 'LIVE_TEST_EXPIRED');
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
    this.owner(userId);
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
          upperMicros: LIVE_TEXT.upperMicros,
        })),
      };
    });
  }
  async consent(userId: string, campaignId: string, requestId: string, input: unknown) {
    this.owner(userId);
    z.uuid().parse(campaignId);
    z.uuid().parse(requestId);
    const v = consentSchema.parse(input);
    return this.db.tx(async (c) => {
      await this.session(c, v.sessionId, userId);
      const previous = (
        await c.query(
          'SELECT * FROM live_test_text_permits WHERE session_id=$1 AND operation_id=$2',
          [v.sessionId, v.operationId],
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
        this.policy(),
        userId,
        'text',
        `manual-text:${requestId}`,
        LIVE_TEXT.upperMicros,
      );
      const id = randomUUID();
      await c.query(
        "INSERT INTO live_test_text_permits(id,session_id,campaign_id,request_id,operation_id,context_hash,round_id,phase_epoch,reservation_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'authorized')",
        [
          id,
          v.sessionId,
          campaignId,
          requestId,
          v.operationId,
          digest(r.context),
          turn.roundId,
          turn.phaseEpoch,
          reservation,
        ],
      );
      return { id, state: 'authorized', upperMicros: LIVE_TEXT.upperMicros };
    });
  }
  async requestAuthorized(requestId: string, context?: unknown) {
    if (!this.config.enabled) return false;
    const rows = await this.db.query(
      "SELECT p.context_hash FROM live_test_text_permits p JOIN live_test_sessions s ON s.id=p.session_id JOIN generation_budget_scopes b ON b.id=s.scope_id WHERE p.request_id=$1 AND p.state='authorized' AND s.id=$2 AND s.state='active' AND s.expires_at>now() AND NOT b.blocked",
      [requestId, this.config.sessionId],
    );
    return !!rows.length && (context === undefined || rows[0].context_hash === digest(context));
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
      if (!this.config.sessionId) return false;
      const session = (
        await c.query('SELECT state,expires_at FROM live_test_sessions WHERE id=$1 FOR UPDATE', [
          this.config.sessionId,
        ])
      ).rows[0];
      const expired =
        (this.config.expiresAt?.getTime() ?? Infinity) <= Date.now() ||
        (session && new Date(session.expires_at).getTime() <= Date.now());
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
    await c.query('SELECT id FROM live_test_sessions WHERE id=$1 FOR UPDATE', [initial.session_id]);
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
      await this.session(c, peek.session_id, this.config.ownerId!);
      const p = (
        await c.query('SELECT * FROM live_test_text_permits WHERE request_id=$1 FOR UPDATE', [rId])
      ).rows[0];
      if (!p || p.state !== 'authorized')
        fail(403, 'MANUAL_LIVE_CONSENT_REQUIRED', 'MANUAL_LIVE_CONSENT_REQUIRED');
      await this.session(c, p.session_id, this.config.ownerId!);
      const turn = await this.campaign(c, p.campaign_id, this.config.ownerId!);
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
      await c.query('SELECT id FROM live_test_sessions WHERE id=$1 FOR UPDATE', [peek.session_id]);
      const p = (await c.query('SELECT * FROM live_test_text_permits WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!p) return;
      if (actual !== null) await settleGenerationSpend(c, p.reservation_id, actual);
      const stop =
        actual === null ||
        code === 'PROVIDER_HTTP_403' ||
        (actual !== null && actual > LIVE_TEXT.upperMicros);
      if (stop) {
        await c.query("UPDATE live_test_sessions SET state='stopped',stop_code=$2 WHERE id=$1", [
          p.session_id,
          code,
        ]);
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
    await c.query('SELECT id FROM live_test_sessions WHERE id=$1 FOR UPDATE', [peek.session_id]);
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
    this.owner(userId);
    const rows = await this.db.query(
      'SELECT * FROM live_test_sessions WHERE id=$1 AND owner_id=$2',
      [this.config.sessionId, userId],
    );
    const usage = (
      await this.db.query(
        "SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros WHEN status='settled' THEN actual_micros ELSE 0 END),0) AS used,COALESCE(sum(CASE WHEN status='held' THEN upper_micros ELSE 0 END),0) AS held FROM generation_budget_reservations WHERE scope_id=$1",
        [LIVE_TEXT.scopeId],
      )
    )[0];
    const prior = (
      await this.db.query(
        "SELECT count(*) AS unknown FROM generation_budget_reservations WHERE scope_id<>$1 AND status='held'",
        [LIVE_TEXT.scopeId],
      )
    )[0];
    const expired = this.config.expiresAt!.getTime() <= Date.now();
    let unsafe =
      (
        await this.db.query(
          "SELECT 1 FROM generation_budget_reservations b JOIN image_generation_jobs j ON j.reservation_id=b.id WHERE b.scope_id=$1 AND (j.status='unknown' OR j.safe_diagnostic->>'httpStatus'='403' OR (j.status='dispatched' AND j.dispatch_deadline<=now())) UNION ALL SELECT 1 FROM live_test_text_permits p WHERE p.session_id=$2 AND (p.state='unknown' OR (p.state='dispatched' AND p.dispatched_at<=now()-interval '60 seconds')) LIMIT 1",
          [LIVE_TEXT.scopeId, this.config.sessionId],
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
      enabled: !expired,
      sessionId: this.config.sessionId,
      state: expired || unsafe ? 'stopped' : (rows[0]?.state ?? 'unclaimed'),
      expiresAt: this.config.expiresAt!.toISOString(),
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
}
