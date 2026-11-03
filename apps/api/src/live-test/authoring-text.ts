import { providerMicrosToSparkSubunits } from '@dreamwalk/contracts';
import {
  quoteSparks,
  reserveSparks,
  settleReservationSparks,
  sparkTariff,
  sparkQuoteView,
} from '../generation/sparks-hooks';
import { assertBoundedTextSource } from '../generation/bounded-test';
import { textUsageCostMicros } from '../generation/text-pricing';
import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { Db } from '../db';
import { fail } from '../errors';
import { digest } from '../ai/context';
import { ProviderFailure } from '../ai/types';
import { reserveGenerationSpend } from '../image-generation/budget';
import type { TextReserveSnapshot } from '../generation/estimates';
import { GenerationAuthority } from '../generation/service';
import {
  BoundedAuthoringTextProvider,
  type AuthoringTextDefinition,
  type AuthoringTextProvider,
  type AuthoringTextResult,
} from './authoring-provider';
const bindingSchema = z
  .object({
    sessionId: z.uuid(),
    projectId: z.uuid(),
    projectRevision: z.number().int().positive(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    readsetHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AuthoringTextBinding = z.infer<typeof bindingSchema>;
export type AuthoringTextFence = (c: PoolClient, binding: AuthoringTextBinding) => Promise<void>;
export type AuthoringTextCommit = (
  c: PoolClient,
  binding: AuthoringTextBinding,
  proposal: unknown,
) => Promise<unknown>;
interface AuthoringJob extends QueryResultRow {
  id: string;
  actor_id: string;
  session_id: string;
  project_id: string | null;
  project_revision: number;
  source_hash: string;
  readset_hash: string;
  context_hash: string;
  context: unknown;
  provider_version: string;
  reservation_id: string;
  budget_upper_micros: string;
  request_snapshot: TextReserveSnapshot | null;
  generation_policy_revision: number | null;
  generation_policy_hash: string | null;
  status: string;
  proposal: unknown;
  result: unknown;
  cancel_requested: boolean;
  deadline_at: Date | null;
  dispatched_at: Date | null;
  completed_at: Date | null;
  actual_micros: string | null;
  error_code: string | null;
  created_at: Date;
}
const safeCode = (error: unknown, fallback: string) =>
  error instanceof ProviderFailure && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : fallback;
/** Durable manual private-authoring jobs. Nothing here is a scheduler or a world/NPC command. */
export class AuthoringTextEngine {
  constructor(
    readonly db: Db,
    readonly live: GenerationAuthority,
    readonly provider: AuthoringTextProvider,
    readonly definition: AuthoringTextDefinition,
    readonly timeoutMs = 60000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000)
      throw new Error('INVALID_AUTHORING_TIMEOUT');
  }
  private async lockSource(c: PoolClient, ownerId: string) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`art-owner:${ownerId}`]);
  }
  private binding(row: QueryResultRow): AuthoringTextBinding {
    return bindingSchema.parse({
      sessionId: row.session_id,
      projectId: row.project_id,
      projectRevision: Number(row.project_revision),
      sourceHash: row.source_hash,
      readsetHash: row.readset_hash,
    });
  }
  private dto(row: AuthoringJob) {
    const status =
      row.status === 'dispatched' && row.deadline_at && row.deadline_at.getTime() <= Date.now()
        ? 'unknown'
        : row.status;
    return {
      id: row.id,
      ...(row.spark_quote_id
        ? {
            sparkHoldId: row.spark_quote_id,
            sparkStatus: row.spark_status,
            sparkReservedSubunits: row.spark_reserved_subunits,
            sparkCapturedSubunits: row.spark_captured_subunits,
          }
        : {}),
      projectId: row.project_id,
      policyRevision: row.generation_policy_revision ?? null,
      policyHash: row.generation_policy_hash ?? null,
      status,
      canCancel: !row.cancel_requested && ['queued', 'dispatched', 'generated'].includes(status),
      canRetry: false,
      upperMicros: row.request_snapshot ? null : Number(row.budget_upper_micros),
      reserveMicros: Number(row.budget_upper_micros),
      ...(row.request_snapshot
        ? {
            estimateSnapshot: row.request_snapshot,
            estimatedTotalMicros: row.request_snapshot.estimatedTotalMicros,
            costBasis: row.request_snapshot.costBasis,
            providerEnforcesQuotedCap: false,
          }
        : {}),
      actualMicros: row.actual_micros === null ? null : Number(row.actual_micros),
      costStatus:
        status === 'unknown' ? 'unknown' : row.actual_micros !== null ? 'settled' : 'reserved',
      errorCode: row.error_code,
      createdAt: row.created_at.toISOString(),
      dispatchedAt: row.dispatched_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
      result: row.status === 'committed' ? row.result : null,
      proposal: row.status === 'committed' ? row.proposal : null,
    };
  }
  private async quoteDto(c: PoolClient, row: QueryResultRow) {
    return {
      id: row.id,
      ...(await sparkQuoteView(c, row.spark_quote_id)),
      policyRevision: row.generation_policy_revision ?? null,
      policyHash: row.generation_policy_hash ?? null,
      upperMicros: row.request_snapshot ? null : Number(row.upper_micros),
      reserveMicros: Number(row.upper_micros),
      ...(row.request_snapshot
        ? {
            estimateSnapshot: row.request_snapshot,
            estimatedTotalMicros: row.request_snapshot.estimatedTotalMicros,
            costBasis: row.request_snapshot.costBasis,
            providerEnforcesQuotedCap: false,
          }
        : {}),
      expiresAt: new Date(row.expires_at).toISOString(),
      requiresConsent: true,
      model: row.request_snapshot?.model ?? this.live.textProfile().model,
      costEvidence: row.request_snapshot ? 'operator_estimate' : 'conservative_configured_rates',
    };
  }
  private verifySnapshot(
    context: unknown,
    snapshot: TextReserveSnapshot | null | undefined,
    reserve?: number,
  ) {
    const current = this.provider.prepareTextRequest?.(context)?.snapshot;
    if (snapshot) {
      if (
        !current ||
        digest(snapshot) !== digest(current) ||
        (reserve !== undefined && reserve !== snapshot.reserveMicros)
      )
        throw new ProviderFailure('AUTHORING_REQUEST_SNAPSHOT_CHANGED', false);
    } else if (current) throw new ProviderFailure('AUTHORING_REQUEST_SNAPSHOT_REQUIRED', false);
  }
  private policyMatches(row: QueryResultRow, active: { revision: number; hash: string } | null) {
    if (!active) return true;
    const revision = Number(row.generation_policy_revision ?? 0);
    return (
      revision === active.revision &&
      (row.generation_policy_hash === active.hash ||
        (revision === 0 && row.generation_policy_hash == null))
    );
  }
  private async activePolicy(c: PoolClient, authorizationId: string) {
    if (this.live.mode === 'owner' || this.live.mode === 'release')
      return this.live.assertActivePolicy(c, authorizationId);
    return null;
  }
  async quote(
    ownerId: string,
    input: Omit<AuthoringTextBinding, 'sessionId'> & {
      sessionId?: string;
      operationId: string;
      context: unknown;
    },
    validateFence: AuthoringTextFence,
  ) {
    await this.live.requireOwner(ownerId);
    z.uuid().parse(input.operationId);
    const candidateBinding = bindingSchema
      .extend({ sessionId: z.uuid().optional() })
      .parse(
        Object.fromEntries(
          Object.entries(input).filter(([k]) => !['operationId', 'context'].includes(k)),
        ),
      );
    const context = JSON.parse(JSON.stringify(input.context));
    if (Buffer.byteLength(JSON.stringify(context)) > 32000)
      fail(400, 'AUTHORING_CONTEXT_TOO_LARGE', 'AUTHORING_CONTEXT_TOO_LARGE');
    const snapshot = this.provider.prepareTextRequest?.(context)?.snapshot ?? null;
    return this.db.tx(async (c) => {
      await this.lockSource(c, ownerId);
      const sessionId =
        this.live.mode === 'release'
          ? await this.live.resolveAuthorizationId(c, ownerId, candidateBinding.sessionId)
          : candidateBinding.sessionId;
      const binding = bindingSchema.parse({ ...candidateBinding, sessionId });
      const requestHash = digest({
        binding,
        context,
        provider: this.provider.version,
        ...(snapshot ? { requestSnapshot: snapshot } : {}),
      });
      await assertBoundedTextSource(c, binding.sessionId, binding.projectId);
      await this.live.authorizeText(c, ownerId, binding.sessionId);
      const activePolicy = await this.activePolicy(c, binding.sessionId);
      await validateFence(c, binding);
      const prior = (
        await c.query(
          'SELECT * FROM live_authoring_text_quotes WHERE actor_id=$1 AND operation_id=$2',
          [ownerId, input.operationId],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return this.quoteDto(c, prior);
      }
      const id = randomUUID(),
        expiresAt = new Date(
          Math.min(Date.now() + 60000, this.live.config.expiresAt?.getTime() ?? Infinity),
        );
      const row = (
        await c.query(
          'INSERT INTO live_authoring_text_quotes(id,actor_id,session_id,project_id,operation_id,request_hash,project_revision,source_hash,readset_hash,context_hash,context,provider_version,upper_micros,expires_at,request_snapshot,generation_policy_revision,generation_policy_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *',
          [
            id,
            ownerId,
            binding.sessionId,
            binding.projectId,
            input.operationId,
            requestHash,
            binding.projectRevision,
            binding.sourceHash,
            binding.readsetHash,
            digest(context),
            JSON.stringify(context),
            this.provider.version,
            snapshot?.reserveMicros ?? this.live.textUpperMicros(),
            expiresAt,
            snapshot ? JSON.stringify(snapshot) : null,
            activePolicy?.revision ?? null,
            activePolicy?.hash ?? null,
          ],
        )
      ).rows[0];
      const sparkQuoteId = await quoteSparks(
        c,
        {
          ownerId,
          operationId: id,
          sourceKind: 'text',
          sourceId: id,
          reserveSubunits: providerMicrosToSparkSubunits(String(row.upper_micros)),
          expiresAt: expiresAt.toISOString(),
          tariff: sparkTariff(
            snapshot ?? this.provider.profile ?? this.live.textProfile(),
            'openai',
            this.provider.version,
          ),
          providerQuote: {
            quoteId: id,
            providerVersion: this.provider.version,
            requestHash,
            profile: this.provider.profile ?? this.live.textProfile(),
            requestSnapshot: snapshot,
          },
        },
        { required: this.live.mode === 'release' },
      );
      await c.query('UPDATE live_authoring_text_quotes SET spark_quote_id=$2 WHERE id=$1', [
        id,
        sparkQuoteId,
      ]);
      row.spark_quote_id = sparkQuoteId;
      return this.quoteDto(c, row);
    });
  }
  async enqueue(
    ownerId: string,
    input: { quoteId: string; operationId: string; consent: true },
    validateFence: AuthoringTextFence,
  ) {
    await this.live.requireOwner(ownerId);
    const value = z
      .object({ quoteId: z.uuid(), operationId: z.uuid(), consent: z.literal(true) })
      .strict()
      .parse(input);
    const requestHash = digest(value);
    return this.db.tx(async (c) => {
      const previous = (
        await c.query<AuthoringJob>(
          'SELECT j.*,(SELECT status FROM spark_holds WHERE id=j.spark_quote_id) AS spark_status,(SELECT reserved_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_reserved_subunits,(SELECT captured_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_captured_subunits,r.upper_micros AS budget_upper_micros FROM live_authoring_text_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.actor_id=$1 AND j.operation_id=$2',
          [ownerId, value.operationId],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return this.dto(previous);
      }
      const quote = (
        await c.query('SELECT * FROM live_authoring_text_quotes WHERE id=$1 AND actor_id=$2', [
          value.quoteId,
          ownerId,
        ])
      ).rows[0];
      if (!quote) fail(403, 'FORBIDDEN', 'FORBIDDEN');
      const binding = this.binding(quote);
      await this.lockSource(c, ownerId);
      // A concurrent identical request may have committed while this transaction waited for the owner lock.
      const serializedPrevious = (
        await c.query<AuthoringJob>(
          'SELECT j.*,(SELECT status FROM spark_holds WHERE id=j.spark_quote_id) AS spark_status,(SELECT reserved_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_reserved_subunits,(SELECT captured_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_captured_subunits,r.upper_micros AS budget_upper_micros FROM live_authoring_text_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.actor_id=$1 AND j.operation_id=$2',
          [ownerId, value.operationId],
        )
      ).rows[0];
      if (serializedPrevious) {
        if (serializedPrevious.request_hash !== requestHash)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return this.dto(serializedPrevious);
      }
      await assertBoundedTextSource(c, binding.sessionId, binding.projectId);
      const policy = await this.live.authorizeText(c, ownerId, binding.sessionId, true);
      const activePolicy = await this.activePolicy(c, binding.sessionId);
      await validateFence(c, binding);
      const locked = (
        await c.query('SELECT * FROM live_authoring_text_quotes WHERE id=$1 FOR UPDATE', [quote.id])
      ).rows[0];
      if (
        new Date(locked.expires_at).getTime() <= Date.now() ||
        locked.provider_version !== this.provider.version ||
        locked.context_hash !== digest(locked.context)
      )
        fail(409, 'AUTHORING_QUOTE_EXPIRED', 'AUTHORING_QUOTE_EXPIRED');
      if (
        (await c.query('SELECT 1 FROM live_authoring_text_jobs WHERE quote_id=$1', [quote.id]))
          .rowCount
      )
        fail(409, 'QUOTE_CONSUMED', 'QUOTE_CONSUMED');
      if (!this.policyMatches(locked, activePolicy))
        fail(409, 'GENERATION_POLICY_CHANGED', 'GENERATION_POLICY_CHANGED');
      this.verifySnapshot(locked.context, locked.request_snapshot, Number(locked.upper_micros));
      const id = randomUUID();
      const reservation = await reserveGenerationSpend(
        c,
        this.live.mode === 'release' && locked.request_snapshot?.costBasis === 'operator_estimate'
          ? {
              ...policy,
              verifiedUpperMicros: null,
              costBasis: 'approved_estimate',
              estimatedTotalMicros: locked.request_snapshot.estimatedTotalMicros,
              operationalReserveMicros: Number(locked.upper_micros),
            }
          : policy,
        ownerId,
        'text',
        `manual-authoring-text:${id}`,
        Number(locked.upper_micros),
      );
      await reserveSparks(c, ownerId, locked.spark_quote_id, reservation, {
        required: this.live.mode === 'release',
      });
      const job = (
        await c.query<AuthoringJob>(
          "INSERT INTO live_authoring_text_jobs(id,actor_id,session_id,project_id,operation_id,quote_id,request_hash,project_revision,source_hash,readset_hash,context_hash,context,provider_version,reservation_id,status,request_snapshot,generation_policy_revision,generation_policy_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'queued',$15,$16,$17) RETURNING *",
          [
            id,
            ownerId,
            binding.sessionId,
            binding.projectId,
            value.operationId,
            quote.id,
            requestHash,
            binding.projectRevision,
            binding.sourceHash,
            binding.readsetHash,
            quote.context_hash,
            JSON.stringify(quote.context),
            this.provider.version,
            reservation,
            locked.request_snapshot ? JSON.stringify(locked.request_snapshot) : null,
            locked.generation_policy_revision ?? null,
            locked.generation_policy_hash ?? null,
          ],
        )
      ).rows[0];
      await c.query('UPDATE live_authoring_text_jobs SET spark_quote_id=$2 WHERE id=$1', [
        id,
        locked.spark_quote_id ?? null,
      ]);
      return this.dto({
        ...job,
        spark_quote_id: locked.spark_quote_id,
        spark_status: locked.spark_quote_id ? 'held' : undefined,
        spark_reserved_subunits: (await sparkQuoteView(c, locked.spark_quote_id)).sparks
          ?.reserveSubunits,
        budget_upper_micros: String(quote.upper_micros),
      });
    });
  }
  async get(ownerId: string, id: string) {
    await this.live.requireOwner(ownerId);
    z.uuid().parse(id);
    const row = (
      await this.db.query<AuthoringJob>(
        'SELECT j.*,(SELECT status FROM spark_holds WHERE id=j.spark_quote_id) AS spark_status,(SELECT reserved_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_reserved_subunits,(SELECT captured_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_captured_subunits,r.upper_micros AS budget_upper_micros FROM live_authoring_text_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.id=$1 AND j.actor_id=$2',
        [id, ownerId],
      )
    )[0];
    if (!row) fail(403, 'FORBIDDEN', 'FORBIDDEN');
    return this.dto(row);
  }
  async list(ownerId: string, projectId: string) {
    await this.live.requireOwner(ownerId);
    z.uuid().parse(projectId);
    return (
      await this.db.query<AuthoringJob>(
        'SELECT j.*,(SELECT status FROM spark_holds WHERE id=j.spark_quote_id) AS spark_status,(SELECT reserved_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_reserved_subunits,(SELECT captured_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_captured_subunits,r.upper_micros AS budget_upper_micros FROM live_authoring_text_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.actor_id=$1 AND j.project_id=$2 ORDER BY j.created_at DESC LIMIT 20',
        [ownerId, projectId],
      )
    ).map((j) => this.dto(j));
  }
  private async failure(id: string, error: unknown, undispatchedOnly = false, ownerId?: string) {
    const row = (
      await this.db.query<AuthoringJob>('SELECT * FROM live_authoring_text_jobs WHERE id=$1', [id])
    )[0];
    if (!row || (ownerId && row.actor_id !== ownerId)) return;
    await this.db.tx(async (c) => {
      const known = error instanceof ProviderFailure && !error.uncertain;
      const actual = known ? 0 : null;
      const code = safeCode(error, 'AUTHORING_OUTCOME_UNKNOWN');
      // Accounting locks precede the job lock, matching dispatch/cancel ordering.
      await this.live.lockAuthorization(c, row.session_id);
      const job = (
        await c.query<AuthoringJob>(
          'SELECT * FROM live_authoring_text_jobs WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!['queued', 'dispatched', 'unknown'].includes(job.status)) return;
      if (undispatchedOnly && (job.status !== 'queued' || job.dispatched_at !== null)) return;
      await this.live.settleLiveSpend(c, job.session_id, job.reservation_id, actual, code);
      await settleReservationSparks(c, job.reservation_id, {
        outcome:
          job.status === 'queued' && !job.dispatched_at
            ? 'not_dispatched'
            : known
              ? 'failure_policy_pending'
              : 'unknown',
        receiptId: `authoring:${id}`,
      });
      const erased = job.error_code === 'DATA_ERASED' || job.context_hash === 'erased';
      const requestId =
        error instanceof ProviderFailure &&
        error.requestId &&
        /^[A-Za-z0-9._:-]{1,200}$/.test(error.requestId)
          ? error.requestId
          : null;
      await c.query(
        'UPDATE live_authoring_text_jobs SET status=$2,actual_micros=$3,error_code=$4,provider_request_id=CASE WHEN $5::boolean THEN NULL ELSE COALESCE($6,provider_request_id) END,completed_at=now(),updated_at=now() WHERE id=$1',
        [
          id,
          known ? 'failed' : 'unknown',
          actual,
          erased ? 'DATA_ERASED' : code,
          erased,
          requestId,
        ],
      );
    });
  }
  async cancel(ownerId: string, id: string) {
    await this.live.requireOwner(ownerId);
    z.uuid().parse(id);
    const row = (
      await this.db.query<AuthoringJob>(
        'SELECT j.*,(SELECT status FROM spark_holds WHERE id=j.spark_quote_id) AS spark_status,(SELECT reserved_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_reserved_subunits,(SELECT captured_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_captured_subunits,r.upper_micros AS budget_upper_micros FROM live_authoring_text_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.id=$1 AND j.actor_id=$2',
        [id, ownerId],
      )
    )[0];
    if (!row) fail(403, 'FORBIDDEN', 'FORBIDDEN');
    await this.db.tx(async (c) => {
      await this.live.lockAuthorization(c, row.session_id);
      const job = (
        await c.query<AuthoringJob>(
          'SELECT * FROM live_authoring_text_jobs WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!['queued', 'dispatched', 'generated'].includes(job.status)) return;
      if (job.status === 'queued')
        await this.live.settleLiveSpend(
          c,
          job.session_id,
          job.reservation_id,
          0,
          'AUTHORING_CANCELLED_UNDISPATCHED',
        );
      if (job.status === 'queued')
        await settleReservationSparks(c, job.reservation_id, {
          outcome: 'not_dispatched',
          receiptId: `authoring:${id}`,
        });
      if (job.status === 'generated' || job.status === 'dispatched')
        await settleReservationSparks(c, job.reservation_id, {
          outcome: job.status === 'dispatched' ? 'unknown' : 'failure_policy_pending',
          receiptId: `authoring:${id}`,
        });
      await c.query(
        "UPDATE live_authoring_text_jobs SET cancel_requested=true,status=CASE WHEN status='dispatched' THEN status ELSE 'cancelled' END,actual_micros=CASE WHEN status='queued' THEN 0 ELSE actual_micros END,error_code='AUTHORING_CANCELLED',updated_at=now() WHERE id=$1",
        [id],
      );
    });
    return this.get(ownerId, id);
  }
  async run(
    ownerId: string,
    id: string,
    validateFence: AuthoringTextFence,
    commit: AuthoringTextCommit,
  ) {
    await this.live.requireOwner(ownerId);
    z.uuid().parse(id);
    let claimed: AuthoringJob | null = null;
    try {
      claimed = await this.db.tx(async (c) => {
        const row = (
          await c.query<AuthoringJob>(
            'SELECT j.*,(SELECT status FROM spark_holds WHERE id=j.spark_quote_id) AS spark_status,(SELECT reserved_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_reserved_subunits,(SELECT captured_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_captured_subunits,r.upper_micros AS budget_upper_micros FROM live_authoring_text_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.id=$1 AND j.actor_id=$2',
            [id, ownerId],
          )
        ).rows[0];
        if (!row) fail(403, 'FORBIDDEN', 'FORBIDDEN');
        if (row.status !== 'queued') return null;
        await this.lockSource(c, ownerId);
        const serialized = (
          await c.query<AuthoringJob>(
            'SELECT j.*,(SELECT status FROM spark_holds WHERE id=j.spark_quote_id) AS spark_status,(SELECT reserved_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_reserved_subunits,(SELECT captured_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_captured_subunits,r.upper_micros AS budget_upper_micros FROM live_authoring_text_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.id=$1 AND j.actor_id=$2',
            [id, ownerId],
          )
        ).rows[0];
        if (!serialized || serialized.status !== 'queued') return null;
        await assertBoundedTextSource(c, row.session_id, row.project_id);
        await this.live.authorizeText(c, ownerId, row.session_id, true);
        const activePolicy = await this.activePolicy(c, row.session_id);
        await validateFence(c, this.binding(row));
        const job = (
          await c.query<AuthoringJob>(
            'SELECT * FROM live_authoring_text_jobs WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if (job.status !== 'queued') return null;
        if (
          job.cancel_requested ||
          job.provider_version !== this.provider.version ||
          job.context_hash !== digest(job.context)
        )
          throw new ProviderFailure('AUTHORING_STALE', false);
        if (!this.policyMatches(job, activePolicy))
          throw new ProviderFailure('GENERATION_POLICY_CHANGED', false);
        this.verifySnapshot(
          job.context,
          job.request_snapshot,
          Number(serialized.budget_upper_micros),
        );
        await c.query(
          "UPDATE live_authoring_text_jobs SET status='dispatched',dispatched_at=now(),deadline_at=$2,updated_at=now() WHERE id=$1",
          [id, new Date(Date.now() + this.timeoutMs)],
        );
        return job;
      });
    } catch (error) {
      const response = (error as { getResponse?: () => unknown })?.getResponse?.();
      const policyCode =
        (error instanceof ProviderFailure && error.code === 'GENERATION_POLICY_CHANGED') ||
        (response &&
          typeof response === 'object' &&
          'code' in response &&
          ['GENERATION_POLICY_CHANGED', 'GENERATION_RELEASE_PROFILE_NOT_ACTIVE'].includes(
            String(response.code),
          ))
          ? 'GENERATION_POLICY_CHANGED'
          : 'AUTHORING_STALE';
      await this.failure(id, new ProviderFailure(policyCode, false), true, ownerId);
      return this.get(ownerId, id);
    }
    if (!claimed) {
      await this.resumeGenerated(ownerId, id, validateFence, commit);
      return this.get(ownerId, id);
    }
    const currentClaim = claimed;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve()
      .then(() =>
        this.provider.generate({
          jobId: id,
          context: currentClaim.context,
          signal: abort.signal,
          ...(currentClaim.request_snapshot
            ? {
                textReservationSnapshot: currentClaim.request_snapshot,
                maxCostMicros: currentClaim.request_snapshot.reserveMicros,
              }
            : {}),
        }),
      )
      .then((result) => this.receive(id, result, validateFence, commit));
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new ProviderFailure('PROVIDER_TIMEOUT', true));
          }, this.timeoutMs);
        }),
      ]);
    } catch (error) {
      await this.failure(id, error);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // If a timed-out provider later supplies known usage, receive() settles it, never applies a late proposal.
    void work.catch(() => {});
    return this.get(ownerId, id);
  }
  private async receive(
    id: string,
    result: AuthoringTextResult,
    validateFence: AuthoringTextFence,
    commit: AuthoringTextCommit,
  ) {
    if (!Number.isSafeInteger(result.usage.costMicros) || result.usage.costMicros < 0)
      throw new ProviderFailure('PROVIDER_USAGE_UNKNOWN', true);
    let proposal: unknown = null;
    let errorCode = result.failureCode ?? null;
    if (!errorCode)
      try {
        proposal = this.definition.validateProposal(result.proposal);
      } catch {
        errorCode = 'AUTHORING_PROPOSAL_INVALID';
      }
    const current = (
      await this.db.query<AuthoringJob>('SELECT * FROM live_authoring_text_jobs WHERE id=$1', [id])
    )[0];
    if (!current) return;
    let cacheCostVerified = true;
    if (
      (result.usage.cachedInputTokens ?? 0) > 0 ||
      (result.usage.cacheWriteInputTokens ?? 0) > 0
    ) {
      try {
        cacheCostVerified =
          !!current.request_snapshot?.cachePricing &&
          result.usage.costVerifiedForSparks === true &&
          textUsageCostMicros(current.request_snapshot, result.usage).costMicros ===
            result.usage.costMicros;
      } catch {
        cacheCostVerified = false;
      }
    }
    const generated = await this.db.tx(async (c) => {
      await this.live.settleLiveSpend(
        c,
        current.session_id,
        current.reservation_id,
        result.usage.costMicros,
        errorCode ?? 'AUTHORING_RESULT',
      );
      const row = (
        await c.query<AuthoringJob>(
          'SELECT * FROM live_authoring_text_jobs WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (['committed', 'generated'].includes(row.status)) return false;
      const erased = row.error_code === 'DATA_ERASED' || row.context_hash === 'erased';
      const late =
        row.status === 'unknown' ||
        row.deadline_at === null ||
        row.deadline_at.getTime() <= Date.now();
      if (
        late ||
        errorCode ||
        erased ||
        row.cancel_requested ||
        (result.usage as { costVerifiedForSparks?: boolean }).costVerifiedForSparks === false ||
        !cacheCostVerified
      )
        await settleReservationSparks(c, row.reservation_id, {
          outcome: late ? 'unknown' : 'failure_policy_pending',
          receiptId: `authoring:${id}`,
        });
      await c.query(
        'UPDATE live_authoring_text_jobs SET spark_cost_evidence=$2,provider_usage=COALESCE(provider_usage,$3::jsonb) WHERE id=$1',
        [id, result.usage.costEvidence, JSON.stringify(result.usage)],
      );
      const status =
        erased || row.cancel_requested
          ? 'cancelled'
          : late
            ? 'stale'
            : errorCode
              ? 'failed'
              : 'generated';
      await c.query(
        'UPDATE live_authoring_text_jobs SET status=$2,proposal=$3,actual_micros=$4,provider_request_id=$5,error_code=$6,completed_at=now(),updated_at=now() WHERE id=$1',
        [
          id,
          status,
          status === 'generated' ? JSON.stringify(proposal) : null,
          result.usage.costMicros,
          erased ? null : result.requestId,
          erased ? 'DATA_ERASED' : (errorCode ?? (late ? 'AUTHORING_LATE_RESULT' : null)),
        ],
      );
      return status === 'generated';
    });
    if (!generated) return;
    await this.resumeGenerated(current.actor_id, id, validateFence, commit);
  }
  private async resumeGenerated(
    ownerId: string,
    id: string,
    validateFence: AuthoringTextFence,
    commit: AuthoringTextCommit,
  ) {
    const current = (
      await this.db.query<AuthoringJob>(
        'SELECT j.*,(SELECT status FROM spark_holds WHERE id=j.spark_quote_id) AS spark_status,(SELECT reserved_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_reserved_subunits,(SELECT captured_subunits FROM spark_holds WHERE id=j.spark_quote_id) AS spark_captured_subunits,r.upper_micros AS budget_upper_micros FROM live_authoring_text_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.id=$1 AND j.actor_id=$2',
        [id, ownerId],
      )
    )[0];
    if (!current || current.status !== 'generated') return;
    try {
      await this.db.tx(async (c) => {
        await this.lockSource(c, current.actor_id);
        await assertBoundedTextSource(c, current.session_id, current.project_id);
        if (this.live.mode === 'release')
          await this.live.authorizeReleaseResult(
            c,
            current.actor_id,
            current.session_id,
            Number(current.generation_policy_revision),
            current.generation_policy_hash ?? '',
          );
        else await this.live.authorizeText(c, current.actor_id, current.session_id);
        const activePolicy =
          this.live.mode === 'release' ? null : await this.activePolicy(c, current.session_id);
        await validateFence(c, this.binding(current));
        const row = (
          await c.query<AuthoringJob>(
            'SELECT * FROM live_authoring_text_jobs WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if (row.status !== 'generated' || row.cancel_requested) return;
        if (this.live.mode !== 'release' && !this.policyMatches(row, activePolicy))
          throw new ProviderFailure('GENERATION_POLICY_CHANGED', false);
        if (
          (this.live.mode !== 'release' && row.provider_version !== this.provider.version) ||
          row.deadline_at === null ||
          row.completed_at === null ||
          row.completed_at.getTime() > row.deadline_at.getTime() ||
          row.actual_micros === null
        )
          throw new Error('unverified persisted result');
        const spend = (
          await c.query(
            'SELECT status,actual_micros FROM generation_budget_reservations WHERE id=$1',
            [row.reservation_id],
          )
        ).rows[0];
        if (
          !spend ||
          spend.status !== 'settled' ||
          Number(spend.actual_micros) !== Number(row.actual_micros)
        )
          throw new Error('cost not settled');
        // Provider identity includes rates/model envelope. A restarted release process may
        // complete an admitted result only after its current bounded parser and source
        // validator accept it; the immutable old receipt still determines its cost.
        const proposal =
          this.live.mode === 'release'
            ? this.definition.validateProposal(row.proposal)
            : row.proposal;
        const applied = await commit(c, this.binding(row), proposal);
        await settleReservationSparks(c, row.reservation_id, {
          outcome: 'success',
          actualMicros: String(row.actual_micros),
          evidence: row.spark_cost_evidence === 'reported' ? 'reported' : 'configured_rates',
          receiptId: `authoring:${id}`,
        });
        await c.query(
          "UPDATE live_authoring_text_jobs SET status='committed',result=$2,updated_at=now() WHERE id=$1",
          [id, JSON.stringify(applied ?? null)],
        );
      });
    } catch (error) {
      // A stable public validation category only; never persist raw model/source details.
      const errorCode =
        error instanceof Error && error.message === 'STORY_MAP_INTENT_MISMATCH'
          ? 'STORY_MAP_INTENT_MISMATCH'
          : 'AUTHORING_STALE';
      await this.db.tx(async (c) => {
        await this.live.lockAuthorization(c, current.session_id);
        await c.query('SELECT id FROM live_authoring_text_jobs WHERE id=$1 FOR UPDATE', [id]);
        await settleReservationSparks(c, current.reservation_id, {
          outcome: 'failure_policy_pending',
          receiptId: `authoring:${id}`,
        });
        await c.query(
          "UPDATE live_authoring_text_jobs SET status='stale',proposal=NULL,result=NULL,error_code=$2,updated_at=now() WHERE id=$1 AND status='generated'",
          [id, errorCode],
        );
      });
    }
  }
}
export function createAuthoringTextEngine(
  db: Db,
  live: GenerationAuthority,
  definition: AuthoringTextDefinition,
) {
  return new AuthoringTextEngine(
    db,
    live,
    new BoundedAuthoringTextProvider(
      definition,
      live.mode === 'owner' || live.mode === 'release'
        ? (process.env.NPC_AI_API_KEY ?? process.env.OPENAI_API_KEY)
        : process.env.NPC_AI_API_KEY,
      fetch,
      live.textProfile(),
    ),
    definition,
  );
}
