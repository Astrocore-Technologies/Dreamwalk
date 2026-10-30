import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { Db } from '../db';
import { config } from '../config';
import { fail } from '../errors';
import { AssetReuseService } from '../assets/reuse.service';
import { normalizeRaster, lockRasterQuota, MAX_RASTER_BYTES } from '../assets/raster';
import { admitGeneratedRaster } from '../assets/generated-admission';
import {
  generationRequestSchema,
  defaultImagePolicy,
  type ImagePolicy,
  type GenerationRequest,
} from './contracts';
import {
  FixtureImageProvider,
  type ImageProvider,
  type ImageReference,
  type ImageResult,
} from './provider';
import {
  reserveGenerationSpend,
  settleGenerationSpend,
  releaseUndispatchedGenerationSpend,
} from './budget';
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const hash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
interface Job extends QueryResultRow {
  id: string;
  actor_id: string;
  adventure_id: string;
  operation_id: string;
  quote_id: string;
  request_hash: string;
  input: GenerationRequest;
  reference_hashes: Record<string, string>;
  mode: 'mock' | 'external';
  policy_version: string;
  status: string;
  reservation_id: string;
  upper_micros: string;
  actual_micros: string | null;
  cancel_requested: boolean;
  expires_at: Date;
  dispatch_deadline: Date | null;
  upload_id: string;
  family_id: string;
  revision_id: string;
  admitted_revision_id: string | null;
  quarantine_filename: string | null;
  quarantine_sha256: string | null;
  quarantine_mime: string | null;
  provider_request_id: string | null;
  error_code: string | null;
  created_at: Date;
}
export class ImageGenerationEngine {
  constructor(
    protected db: Db,
    protected assets: AssetReuseService,
    protected provider: ImageProvider = new FixtureImageProvider(),
    protected policy: ImagePolicy = defaultImagePolicy,
  ) {}
  configuration() {
    return {
      mockAvailable: true,
      externalEnabled: false,
      externalBlockReasons: [
        'VERIFIED_TOTAL_COST_BOUND_REQUIRED',
        'EXPLICIT_PROVIDER_CONFIGURATION_REQUIRED',
      ],
      approvedImageMicros: 1000000,
      approvedTextMicros: 1000000,
    };
  }
  protected async authorize(
    c: PoolClient,
    actorId: string,
    input: GenerationRequest,
    expected?: Record<string, string>,
  ) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`art-owner:${actorId}`]);
    if (
      !(
        await c.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [
          actorId,
        ])
      ).rowCount
    )
      fail(401, 'UNAUTHORIZED', 'UNAUTHORIZED');
    if (
      !(
        await c.query(
          "SELECT id FROM adventures WHERE id=$1 AND owner_id=$2 AND status<>'archived' FOR SHARE",
          [input.adventureId, actorId],
        )
      ).rowCount
    )
      fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const refs = (
      await c.query(
        `SELECT r.id,r.sha256,a.filename,a.mime FROM art_asset_revisions r JOIN art_asset_families f ON f.id=r.family_id JOIN assets a ON a.id=r.upload_id WHERE r.id=ANY($1::uuid[]) AND f.owner_id=$2 AND f.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM art_asset_takedowns t WHERE t.revision_id=r.id) ORDER BY r.id FOR SHARE OF r,f,a`,
        [input.referenceRevisionIds, actorId],
      )
    ).rows;
    if (refs.length !== input.referenceRevisionIds.length)
      fail(403, 'DERIVATIVE_REFERENCE_FORBIDDEN', 'DERIVATIVE_REFERENCE_FORBIDDEN');
    const hashes = Object.fromEntries(refs.map((r) => [r.id, r.sha256]));
    if (expected && hash(hashes) !== hash(expected))
      fail(409, 'REFERENCE_CHANGED', 'REFERENCE_CHANGED');
    return { hashes, refs };
  }
  private liveGate(input: GenerationRequest) {
    if (
      input.mode === 'external' &&
      (!this.policy.externalEnabled ||
        !this.policy.approved ||
        this.policy.verifiedUpperMicros === null ||
        this.policy.verifiedUpperMicros <= 0 ||
        this.policy.verifiedUpperMicros > 1000000)
    )
      fail(409, 'LIVE_COST_BOUND_REQUIRED', 'LIVE_COST_BOUND_REQUIRED');
  }
  private assertQuotedProvider(row: {
    input: unknown;
    reference_hashes: unknown;
    policy_version: string;
    upper_micros: unknown;
    request_hash: string;
  }) {
    const expected = hash({
      input: row.input,
      refs: row.reference_hashes,
      policy: this.policy.version,
      provider: this.provider.id,
      upper: Number(row.upper_micros),
    });
    if (row.policy_version !== this.policy.version || expected !== row.request_hash)
      fail(409, 'QUOTE_PROVIDER_CHANGED', 'QUOTE_PROVIDER_CHANGED');
  }
  async quote(actorId: string, body: unknown) {
    const input = generationRequestSchema.parse(body);
    const authorization = await this.db.tx((c) => this.authorize(c, actorId, input));
    const matches = await this.assets.search(actorId, {
      kind: input.kind,
      style: 'drawn2D',
      camera: input.camera,
      tags: input.tags,
      minWidth: 1,
      minHeight: 1,
    });
    if (matches.length && !input.declineReuse)
      return { decision: 'reuse', matches, charge: 0, providerCalls: 0 };
    this.liveGate(input);
    return this.db.tx(async (c) => {
      await this.authorize(c, actorId, input, authorization.hashes);
      const n = (
        await c.query(
          "SELECT count(*)::int AS n FROM image_generation_quotes WHERE actor_id=$1 AND created_at>now()-interval '1 minute'",
          [actorId],
        )
      ).rows[0].n;
      if (n >= 30) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
      const id = randomUUID(),
        expiresAt = new Date(Date.now() + this.policy.quoteTtlMs),
        upper =
          input.mode === 'mock' ? this.policy.mockUpperMicros : this.policy.verifiedUpperMicros!;
      const requestHash = hash({
        input,
        refs: authorization.hashes,
        policy: this.policy.version,
        provider: this.provider.id,
        upper,
      });
      await c.query(
        'INSERT INTO image_generation_quotes(id,actor_id,adventure_id,request_hash,input,reference_hashes,mode,policy_version,upper_micros,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          id,
          actorId,
          input.adventureId,
          requestHash,
          input,
          authorization.hashes,
          input.mode,
          this.policy.version,
          upper,
          expiresAt,
        ],
      );
      return {
        decision: 'quote',
        quote: {
          id,
          mode: input.mode,
          upperMicros: upper,
          expiresAt: expiresAt.toISOString(),
          rightsAttestationRequired: true,
        },
        matches,
      };
    });
  }
  private dto(j: Job) {
    return {
      id: j.id,
      status: j.status,
      mode: j.mode,
      revisionId: j.admitted_revision_id ?? undefined,
      errorCode: j.error_code ?? undefined,
      heldMicros:
        j.actual_micros === null &&
        !['cancelled', 'expired', 'rejected', 'admitted'].includes(j.status)
          ? Number(j.upper_micros)
          : 0,
      actualMicros: j.actual_micros === null ? undefined : Number(j.actual_micros),
      createdAt: j.created_at.toISOString(),
      canCancel:
        ['queued', 'dispatched', 'unknown', 'generated'].includes(j.status) && !j.cancel_requested,
    };
  }
  async enqueue(actorId: string, body: unknown) {
    const b = z
      .object({ quoteId: z.uuid(), operationId: z.uuid(), consent: z.literal(true) })
      .strict()
      .parse(body);
    return this.db.tx(async (c) => {
      const q = (
        await c.query('SELECT * FROM image_generation_quotes WHERE id=$1 AND actor_id=$2', [
          b.quoteId,
          actorId,
        ])
      ).rows[0];
      if (!q) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const input = generationRequestSchema.parse(q.input);
      await this.authorize(c, actorId, input, q.reference_hashes);
      this.liveGate(input);
      const previous = (
        await c.query<Job>(
          'SELECT * FROM image_generation_jobs WHERE actor_id=$1 AND operation_id=$2',
          [actorId, b.operationId],
        )
      ).rows[0];
      if (previous) {
        if (previous.quote_id !== b.quoteId)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return this.dto(previous);
      }
      this.assertQuotedProvider(q);
      await lockRasterQuota(c, actorId, MAX_RASTER_BYTES);
      await c.query('SELECT id FROM image_generation_quotes WHERE id=$1 FOR UPDATE', [q.id]);
      if (
        q.policy_version !== this.policy.version ||
        new Date(q.expires_at).getTime() <= Date.now()
      )
        fail(409, 'QUOTE_EXPIRED', 'QUOTE_EXPIRED');
      if (
        (await c.query('SELECT id FROM image_generation_jobs WHERE quote_id=$1', [q.id])).rowCount
      )
        fail(409, 'QUOTE_CONSUMED', 'QUOTE_CONSUMED');
      const count = (
        await c.query(
          "SELECT count(*)::int AS n FROM image_generation_jobs WHERE actor_id=$1 AND status IN ('queued','dispatched','unknown','generated')",
          [actorId],
        )
      ).rows[0].n;
      if (count >= 4) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
      const id = randomUUID(),
        reservation = await reserveGenerationSpend(
          c,
          this.policy,
          actorId,
          'image',
          id,
          Number(q.upper_micros),
          input.mode === 'mock',
        );
      const job = (
        await c.query<Job>(
          "INSERT INTO image_generation_jobs(id,actor_id,adventure_id,operation_id,quote_id,request_hash,input,reference_hashes,mode,policy_version,status,reservation_id,upper_micros,expires_at,upload_id,family_id,revision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,$12,$13,$14,$15,$16) RETURNING *",
          [
            id,
            actorId,
            input.adventureId,
            b.operationId,
            q.id,
            q.request_hash,
            input,
            q.reference_hashes,
            input.mode,
            q.policy_version,
            reservation,
            q.upper_micros,
            q.expires_at,
            randomUUID(),
            randomUUID(),
            randomUUID(),
          ],
        )
      ).rows[0];
      return this.dto(job);
    });
  }
  async get(actorId: string, id: string) {
    z.uuid().parse(id);
    const j = (
      await this.db.query<Job>('SELECT * FROM image_generation_jobs WHERE id=$1 AND actor_id=$2', [
        id,
        actorId,
      ])
    )[0];
    if (!j) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    return this.dto(j);
  }
  async list(actorId: string, adventureId: string) {
    z.uuid().parse(adventureId);
    if (
      !(
        await this.db.query(
          "SELECT id FROM adventures WHERE id=$1 AND owner_id=$2 AND status<>'archived'",
          [adventureId, actorId],
        )
      ).length
    )
      fail(404, 'NOT_FOUND', 'NOT_FOUND');
    return {
      jobs: (
        await this.db.query<Job>(
          'SELECT * FROM image_generation_jobs WHERE actor_id=$1 AND adventure_id=$2 ORDER BY created_at DESC LIMIT 50',
          [actorId, adventureId],
        )
      ).map((j) => this.dto(j)),
    };
  }
  async cancel(actorId: string, id: string, body: unknown = { operationId: randomUUID() }) {
    z.uuid().parse(id);
    z.object({ operationId: z.uuid() }).strict().parse(body);
    await this.db.query(
      "UPDATE image_generation_jobs SET cancel_requested=true,quota_reserved_bytes=0,updated_at=now() WHERE id=$1 AND actor_id=$2 AND status IN ('queued','dispatched','unknown','generated')",
      [id, actorId],
    );
    await this.maintenance();
    return this.get(actorId, id);
  }
  private async lockBudget(c: PoolClient, job: Job) {
    await c.query(
      'SELECT id FROM generation_budget_scopes WHERE id=(SELECT scope_id FROM generation_budget_reservations WHERE id=$1) FOR UPDATE',
      [job.reservation_id],
    );
  }
  async maintenance() {
    const cleanup = await this.db.query(
      'SELECT filename FROM image_generation_cleanup ORDER BY created_at LIMIT 20',
    );
    for (const item of cleanup) {
      if (
        typeof item.filename !== 'string' ||
        !new RegExp('^[a-f0-9-]{36}\\.image-quarantine$').test(item.filename)
      )
        continue;
      try {
        await unlink(resolve(config.ASSET_DIR, item.filename));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }
      await this.db.query('DELETE FROM image_generation_cleanup WHERE filename=$1', [
        item.filename,
      ]);
    }
    const rows = await this.db.query<Job>(
      "SELECT * FROM image_generation_jobs WHERE (status='queued' AND (cancel_requested OR expires_at<=now())) OR (status='dispatched' AND dispatch_deadline<=now()) OR (status='generated' AND cancel_requested) OR (status='unknown' AND cancel_requested AND error_code IS DISTINCT FROM 'CANCELLED') LIMIT 50",
    );
    for (const row of rows)
      await this.db.tx(async (c) => {
        await this.lockBudget(c, row);
        const j = (
          await c.query<Job>('SELECT * FROM image_generation_jobs WHERE id=$1 FOR UPDATE', [row.id])
        ).rows[0];
        if (!j) return;
        if (j.status === 'queued' && (j.cancel_requested || j.expires_at.getTime() <= Date.now())) {
          await releaseUndispatchedGenerationSpend(c, j.reservation_id);
          await c.query(
            'UPDATE image_generation_jobs SET status=$2,quota_reserved_bytes=0,error_code=COALESCE(error_code,$3),updated_at=now() WHERE id=$1',
            [
              j.id,
              j.cancel_requested ? 'cancelled' : 'expired',
              j.cancel_requested ? 'CANCELLED' : 'QUOTE_EXPIRED',
            ],
          );
          await c.query(
            'INSERT INTO image_generation_cleanup(filename,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [`${j.id}.image-quarantine`, j.id],
          );
        } else if (
          j.status === 'dispatched' &&
          j.dispatch_deadline &&
          j.dispatch_deadline.getTime() <= Date.now()
        )
          await c.query(
            "UPDATE image_generation_jobs SET status='unknown',error_code='DISPATCH_UNCERTAIN',updated_at=now() WHERE id=$1",
            [j.id],
          );
        else if ((j.status === 'generated' || j.status === 'unknown') && j.cancel_requested) {
          await c.query(
            "UPDATE image_generation_jobs SET status=CASE WHEN actual_micros IS NULL THEN 'unknown' ELSE 'cancelled' END,quota_reserved_bytes=0,error_code='CANCELLED',updated_at=now() WHERE id=$1",
            [j.id],
          );
          await c.query(
            'INSERT INTO image_generation_cleanup(filename,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [`${j.id}.image-quarantine`, j.id],
          );
        }
      });
  }
  async workOnce() {
    await this.maintenance();
    const received = (
      await this.db.query<Job>(
        "SELECT * FROM image_generation_jobs WHERE status='generated' AND actual_micros IS NOT NULL AND NOT cancel_requested ORDER BY created_at LIMIT 1",
      )
    )[0];
    if (received) {
      await this.admit(received.id);
      return;
    }
    const candidate = (
      await this.db.query<Job>(
        "SELECT * FROM image_generation_jobs WHERE status='queued' AND NOT cancel_requested ORDER BY created_at LIMIT 1",
      )
    )[0];
    if (!candidate) return;
    let claimed: { job: Job; dispatchId: string; refs: QueryResultRow[] } | undefined;
    try {
      claimed = await this.db.tx(async (c) => {
        const input = generationRequestSchema.parse(candidate.input),
          auth = await this.authorize(c, candidate.actor_id, input, candidate.reference_hashes);
        this.liveGate(input);
        this.assertQuotedProvider(candidate);
        await this.lockBudget(c, candidate);
        const j = (
          await c.query<Job>(
            'SELECT * FROM image_generation_jobs WHERE id=$1 FOR UPDATE SKIP LOCKED',
            [candidate.id],
          )
        ).rows[0];
        if (!j || j.status !== 'queued' || j.cancel_requested) return undefined;
        if (j.expires_at.getTime() <= Date.now() || j.policy_version !== this.policy.version)
          fail(409, 'QUOTE_EXPIRED', 'QUOTE_EXPIRED');
        const dispatchId = randomUUID();
        await c.query(
          'INSERT INTO image_generation_attempts(job_id,dispatch_id,provider,request_hash) VALUES($1,$2,$3,$4)',
          [j.id, dispatchId, this.provider.id, j.request_hash],
        );
        const job = (
          await c.query<Job>(
            "UPDATE image_generation_jobs SET status='dispatched',dispatched_at=now(),dispatch_deadline=$2,updated_at=now() WHERE id=$1 RETURNING *",
            [j.id, new Date(Date.now() + this.policy.dispatchTimeoutMs)],
          )
        ).rows[0];
        return { job, dispatchId, refs: auth.refs };
      });
    } catch {
      await this.rejectUndispatched(candidate.id, 'AUTHORIZATION_OR_QUOTE_CHANGED');
      return;
    }
    if (!claimed) return;
    try {
      const refs: ImageReference[] = [];
      for (const r of claimed.refs) {
        if (basename(String(r.filename)) !== r.filename) throw new Error('INVALID_REFERENCE');
        const bytes = await readFile(resolve(config.ASSET_DIR, String(r.filename)));
        if (
          bytes.length > MAX_RASTER_BYTES ||
          createHash('sha256').update(bytes).digest('hex') !== r.sha256
        )
          throw new Error('REFERENCE_CHANGED');
        refs.push({ revisionId: r.id, sha256: r.sha256, bytes, mime: r.mime });
      }
      const result = await this.provider.generate(
        generationRequestSchema.parse(claimed.job.input),
        claimed.dispatchId,
        refs,
      );
      await this.recordResult(claimed.job.id, result);
      await this.admit(claimed.job.id);
    } catch {
      await this.db.query(
        "UPDATE image_generation_jobs SET status='unknown',error_code='DISPATCH_UNCERTAIN',updated_at=now() WHERE id=$1 AND status='dispatched'",
        [claimed.job.id],
      );
    }
  }
  private async rejectUndispatched(id: string, errorCode: string) {
    const row = (
      await this.db.query<Job>('SELECT * FROM image_generation_jobs WHERE id=$1', [id])
    )[0];
    if (!row) return;
    await this.db.tx(async (c) => {
      await this.lockBudget(c, row);
      const j = (
        await c.query<Job>('SELECT * FROM image_generation_jobs WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (j?.status !== 'queued') return;
      await releaseUndispatchedGenerationSpend(c, j.reservation_id);
      await c.query(
        "UPDATE image_generation_jobs SET status='rejected',error_code=$2,quota_reserved_bytes=0,updated_at=now() WHERE id=$1",
        [id, errorCode],
      );
    });
  }
  /** Internal receipt port, never exposed as an unauthenticated HTTP callback. Late results settle once. */
  async recordResult(id: string, result: ImageResult) {
    if (
      !Buffer.isBuffer(result.bytes) ||
      result.bytes.length > MAX_RASTER_BYTES ||
      !['image/png', 'image/webp'].includes(result.mime) ||
      !result.requestId ||
      result.requestId.length > 200 ||
      (result.actualMicros !== undefined &&
        (!Number.isSafeInteger(result.actualMicros) || result.actualMicros < 0))
    )
      throw new Error('INVALID_IMAGE_RECEIPT');
    const row = (
      await this.db.query<Job>('SELECT * FROM image_generation_jobs WHERE id=$1', [id])
    )[0];
    if (!row) throw new Error('UNKNOWN_JOB');
    const filename = `${id}.image-quarantine`,
      sha = createHash('sha256').update(result.bytes).digest('hex');
    await this.db.tx(async (c) => {
      await this.lockBudget(c, row);
      const j = (
        await c.query<Job>('SELECT * FROM image_generation_jobs WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!j) return;
      if (
        !(await c.query('SELECT 1 FROM image_generation_attempts WHERE job_id=$1', [id])).rowCount
      )
        fail(409, 'NO_PROVIDER_ATTEMPT', 'NO_PROVIDER_ATTEMPT');
      if (j.provider_request_id && j.provider_request_id !== result.requestId)
        fail(409, 'RESULT_CONFLICT', 'RESULT_CONFLICT');
      if (j.quarantine_sha256 && j.quarantine_sha256 !== sha)
        fail(409, 'RESULT_CONFLICT', 'RESULT_CONFLICT');
      if (j.actual_micros !== null && result.actualMicros !== Number(j.actual_micros))
        fail(409, 'COST_CONFLICT', 'COST_CONFLICT');
      if (!['dispatched', 'unknown', 'generated'].includes(j.status)) return;
      const erased = j.error_code === 'ERASED';
      if (result.actualMicros !== undefined)
        await settleGenerationSpend(c, j.reservation_id, result.actualMicros);
      await c.query(
        'UPDATE image_generation_attempts SET result_received_at=now(),actual_micros=COALESCE($2,actual_micros),provider_request_id=$3 WHERE job_id=$1',
        [id, result.actualMicros ?? null, erased ? null : result.requestId],
      );
      const rejected =
        erased ||
        j.cancel_requested ||
        (result.actualMicros !== undefined && result.actualMicros > Number(j.upper_micros));
      if (!rejected) {
        await mkdir(config.ASSET_DIR, { recursive: true });
        try {
          await writeFile(resolve(config.ASSET_DIR, filename), result.bytes, { flag: 'wx' });
        } catch (e) {
          if (
            (e as NodeJS.ErrnoException).code !== 'EEXIST' ||
            createHash('sha256')
              .update(await readFile(resolve(config.ASSET_DIR, filename)))
              .digest('hex') !== sha
          )
            throw e;
        }
      }
      if (rejected)
        await c.query(
          'INSERT INTO image_generation_cleanup(filename,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [`${id}.image-quarantine`, id],
        );
      await c.query(
        'UPDATE image_generation_jobs SET status=$2,actual_micros=COALESCE($3,actual_micros),provider_request_id=$4,quarantine_filename=$5,quarantine_sha256=$6,quarantine_mime=$7,quota_reserved_bytes=CASE WHEN $8 THEN 0 ELSE quota_reserved_bytes END,error_code=$9,updated_at=now() WHERE id=$1',
        [
          id,
          rejected ? (result.actualMicros === undefined ? 'unknown' : 'rejected') : 'generated',
          result.actualMicros ?? null,
          erased ? null : result.requestId,
          rejected ? null : filename,
          rejected ? null : sha,
          rejected ? null : result.mime,
          rejected,
          erased
            ? 'ERASED'
            : rejected
              ? 'ADMISSION_REVOKED_OR_OVERRUN'
              : result.actualMicros === undefined
                ? 'COST_RECONCILIATION_REQUIRED'
                : null,
        ],
      );
    });
  }
  private async admit(id: string) {
    const row = (
      await this.db.query<Job>('SELECT * FROM image_generation_jobs WHERE id=$1', [id])
    )[0];
    if (!row || row.status !== 'generated' || row.actual_micros === null || row.cancel_requested)
      return;
    if (!row.quarantine_filename || basename(row.quarantine_filename) !== row.quarantine_filename)
      return;
    let raster;
    try {
      const bytes = await readFile(resolve(config.ASSET_DIR, row.quarantine_filename));
      if (createHash('sha256').update(bytes).digest('hex') !== row.quarantine_sha256)
        throw new Error('INTEGRITY');
      raster = await normalizeRaster(
        bytes,
        row.quarantine_mime!,
        generationRequestSchema.parse(row.input).background === 'transparent',
      );
    } catch {
      await this.rejectAdmission(row, 'INVALID_RASTER_OR_ALPHA');
      return;
    }
    try {
      await this.db.tx(async (c) => {
        const input = generationRequestSchema.parse(row.input);
        await this.authorize(c, row.actor_id, input, row.reference_hashes);
        await lockRasterQuota(c, row.actor_id, raster.bytes.length, row.id);
        await this.lockBudget(c, row);
        const j = (
          await c.query<Job>('SELECT * FROM image_generation_jobs WHERE id=$1 FOR UPDATE', [id])
        ).rows[0];
        if (j.status !== 'generated' || j.cancel_requested || j.actual_micros === null) return;
        if (
          j.expires_at.getTime() <= Date.now() ||
          Number(j.actual_micros) > Number(j.upper_micros)
        )
          fail(409, 'ADMISSION_EXPIRED', 'ADMISSION_EXPIRED');
        const admitted = await admitGeneratedRaster(
          c,
          this.assets,
          j,
          input,
          raster,
          this.provider.id,
        );
        await c.query(
          "UPDATE image_generation_jobs SET status='admitted',admitted_revision_id=$2,quota_reserved_bytes=0,error_code=NULL,updated_at=now() WHERE id=$1",
          [id, admitted.id],
        );
        await c.query(
          'INSERT INTO image_generation_cleanup(filename,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [row.quarantine_filename, id],
        );
      });
    } catch {
      if ((await this.db.query('SELECT id FROM assets WHERE id=$1', [row.upload_id])).length)
        return;
      await unlink(resolve(config.ASSET_DIR, `${row.upload_id}.webp`)).catch(() => undefined);
      await this.rejectAdmission(row, 'ADMISSION_REJECTED');
      return;
    }
  }
  private async rejectAdmission(row: Job, errorCode: string) {
    await this.db.query(
      "UPDATE image_generation_jobs SET status='rejected',quota_reserved_bytes=0,error_code=$2,updated_at=now() WHERE id=$1 AND status='generated'",
      [row.id, errorCode],
    );
    if (row.quarantine_filename)
      await this.db.query(
        'INSERT INTO image_generation_cleanup(filename,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [row.quarantine_filename, row.id],
      );
  }
}
@Injectable()
export class ImageGenerationService extends ImageGenerationEngine implements OnModuleDestroy {
  private timer: ReturnType<typeof setInterval>;
  private busy: Promise<void> | undefined;
  private stopped = false;
  constructor(@Inject(Db) db: Db, @Inject(AssetReuseService) assets: AssetReuseService) {
    super(db, assets);
    this.timer = setInterval(() => {
      if (this.busy || this.stopped) return;
      this.busy = this.workOnce()
        .catch(() => undefined)
        .finally(() => {
          this.busy = undefined;
        });
    }, 250);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.busy;
  }
}
