import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  spatialQuoteRequestSchema,
  spatialDispatchRequestSchema,
  visualMutationSchema,
} from '@dreamwalk/contracts';
import { compilePlayableDraft, projectState } from '@dreamwalk/game-core';
import { Db } from '../db';
import { fail } from '../errors';
import { LIVE_TEXT } from '../live-test/config';
import { AuthoringTextEngine, type AuthoringTextBinding } from '../live-test/authoring-text';
import { createAuthorSandbox } from './sandbox';
import { VisualAuthoringService } from './service';
import {
  spatialReadset,
  validateSpatialPlan,
  authorizeSpatialPlan,
  type ValidatedSpatialPlan,
} from './spatial-plan';
import { visualDigest as digest } from './fingerprint';

@Injectable()
export class SpatialPlannerService {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(VisualAuthoringService) private visuals: VisualAuthoringService,
    @Optional() @Inject('AUTHORING_TEXT_ENGINE') private engine?: AuthoringTextEngine,
  ) {}
  private configured() {
    if (!this.engine) fail(409, 'SPATIAL_PLANNER_UNAVAILABLE', 'SPATIAL_PLANNER_UNAVAILABLE');
    return this.engine!;
  }
  private guard(owner: string, allowJobId?: string) {
    return async (c: PoolClient, binding: AuthoringTextBinding) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`art-owner:${owner}`]);
      const p = await this.visuals.spatialProject(
        c,
        owner,
        binding.projectId,
        binding.projectRevision,
      );
      if (p.status !== 'concept' || p.plan_origin !== 'ai-pending' || p.plan)
        fail(409, 'SPATIAL_PLAN_STATE_CHANGED', 'SPATIAL_PLAN_STATE_CHANGED');
      if (p.source_hash !== binding.sourceHash || spatialReadset(p).hash !== binding.readsetHash)
        fail(409, 'SPATIAL_CONTEXT_STALE', 'SPATIAL_CONTEXT_STALE');
      if (
        (
          await c.query(
            'SELECT id FROM live_authoring_text_jobs WHERE project_id=$1 AND ($2::uuid IS NULL OR id<>$2) LIMIT 1',
            [p.id, allowJobId ?? null],
          )
        ).rowCount
      )
        fail(409, 'SPATIAL_ATTEMPT_ALREADY_STARTED', 'SPATIAL_ATTEMPT_ALREADY_STARTED');
    };
  }
  private async project(owner: string, id: string) {
    z.uuid().parse(id);
    const p = (
      await this.db.query(
        'SELECT id,owner_id,kind,generation_mode,plan_origin,status,revision,source_hash FROM visual_authoring_projects WHERE id=$1 AND owner_id=$2',
        [id, owner],
      )
    )[0];
    if (!p) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    if (p.kind !== 'location' || p.generation_mode !== 'external')
      fail(409, 'SPATIAL_MODE_REQUIRED', 'SPATIAL_MODE_REQUIRED');
    return p;
  }
  async state(owner: string, id: string) {
    const p = await this.project(owner, id);
    const blockers: string[] = [];
    let available = false;
    if (this.engine?.live.config.enabled) {
      try {
        const authorization = await this.engine.live.status(owner);
        available = authorization.enabled && authorization.state === 'active';
      } catch (error) {
        const code = (error as { getResponse?: () => { code?: string } })?.getResponse?.().code;
        if (!['FORBIDDEN', 'LIVE_TEST_DISABLED', 'GENERATION_DISABLED'].includes(code ?? ''))
          throw error;
      }
    }
    const profile = this.engine?.live.textProfile() ?? LIVE_TEXT;
    const perRequestEstimate = 'estimation' in profile && !!profile.estimation;
    if (!available) blockers.push('SPATIAL_PLANNER_UNAVAILABLE');
    if (p.plan_origin !== 'ai-pending') blockers.push('SPATIAL_MODE_NOT_PENDING');
    if (p.status !== 'concept') blockers.push('STATE_CONFLICT');
    let fresh = true,
      readsetHash: string | undefined;
    try {
      const snapshot = await this.db.tx((c) => this.visuals.spatialProject(c, owner, id));
      readsetHash = spatialReadset(snapshot).hash;
    } catch (error) {
      const code = (error as { getResponse?: () => { code?: string } })?.getResponse?.().code;
      if (code === 'STALE_STATE') {
        fresh = false;
        blockers.push('SPATIAL_CONTEXT_STALE');
      } else throw error;
    }
    const quotes = await this.db.query(
      `SELECT q.id,q.upper_micros AS "upperMicros",q.expires_at AS "expiresAt",q.request_snapshot,q.generation_policy_revision,q.generation_policy_hash,EXISTS(SELECT 1 FROM live_authoring_text_jobs j WHERE j.quote_id=q.id) AS consumed
      FROM live_authoring_text_quotes q WHERE q.project_id=$1 AND q.actor_id=$2 ORDER BY q.created_at DESC LIMIT 20`,
      [id, owner],
    );
    const rows = await this.db.query(
      'SELECT j.*,r.upper_micros FROM live_authoring_text_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE j.project_id=$1 AND j.actor_id=$2 ORDER BY j.created_at DESC LIMIT 20',
      [id, owner],
    );
    const jobs = rows.map((row) => {
      const status =
        row.status === 'dispatched' &&
        row.deadline_at &&
        new Date(row.deadline_at).getTime() <= Date.now()
          ? 'unknown'
          : row.status;
      return {
        id: row.id,
        projectId: row.project_id,
        status,
        canCancel: ['queued', 'dispatched', 'generated'].includes(status),
        canRetry: false,
        upperMicros: row.request_snapshot ? null : Number(row.upper_micros),
        reserveMicros: Number(row.upper_micros),
        policyRevision: row.generation_policy_revision ?? null,
        policyHash: row.generation_policy_hash ?? null,
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
        createdAt: row.created_at,
        dispatchedAt: row.dispatched_at,
        completedAt: row.completed_at,
        result: status === 'committed' ? row.result : null,
      };
    });
    if (jobs.length) blockers.push('SPATIAL_ATTEMPT_ALREADY_STARTED');
    const row = (
      await this.db.query(
        'SELECT * FROM visual_spatial_proposals WHERE project_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 1',
        [id, owner],
      )
    )[0];
    let currentProposal;
    if (row) {
      if (digest({ layout: row.layout, plan: row.plan }) !== row.checksum)
        blockers.push('ASSET_INTEGRITY_FAILED');
      else {
        const compiled = compilePlayableDraft(row.plan);
        if (!compiled.playable) blockers.push('INVALID_MAP');
        else
          currentProposal = {
            id: row.id,
            jobId: row.job_id,
            status: row.status,
            projectRevision: row.project_revision,
            sourceHash: row.source_hash,
            layout: row.layout,
            plan: row.plan,
            projection: projectState(
              createAuthorSandbox(compiled.playable!),
              'visual-preview-player',
            ),
            validated: true,
          };
      }
    }
    const canApply = !!(
      fresh &&
      currentProposal &&
      currentProposal.status === 'proposed' &&
      p.status === 'concept' &&
      p.plan_origin === 'ai-pending' &&
      currentProposal.projectRevision === p.revision &&
      currentProposal.sourceHash === p.source_hash &&
      row.readset_hash === readsetHash
    );
    return {
      available,
      manualDispatchOnly: true,
      model: profile.model,
      maxOutputTokens: profile.maxOutputTokens,
      upperMicros: perRequestEstimate ? null : profile.upperMicros,
      perRequestEstimate: perRequestEstimate,
      quotes: quotes.map((q) => ({
        id: q.id,
        expiresAt: q.expiresAt,
        consumed: q.consumed,
        upperMicros: q.request_snapshot ? null : Number(q.upperMicros),
        reserveMicros: Number(q.upperMicros),
        policyRevision: q.generation_policy_revision ?? null,
        policyHash: q.generation_policy_hash ?? null,
        ...(q.request_snapshot
          ? {
              estimateSnapshot: q.request_snapshot,
              estimatedTotalMicros: q.request_snapshot.estimatedTotalMicros,
              costBasis: q.request_snapshot.costBasis,
              providerEnforcesQuotedCap: false,
            }
          : {}),
      })),
      jobs,
      currentProposal,
      canApply,
      canQuote:
        available &&
        fresh &&
        !jobs.length &&
        p.status === 'concept' &&
        p.plan_origin === 'ai-pending',
      blockers,
    };
  }
  async quote(owner: string, id: string, input: unknown) {
    const b = spatialQuoteRequestSchema.parse(input),
      engine = this.configured();
    const snapshot = await this.db.tx(async (c) => {
      const p = await this.visuals.spatialProject(c, owner, id, b.expectedRevision);
      if (p.status !== 'concept' || p.plan_origin !== 'ai-pending')
        fail(409, 'SPATIAL_MODE_NOT_PENDING', 'SPATIAL_MODE_NOT_PENDING');
      const readset = spatialReadset(p);
      return {
        binding: {
          sessionId: b.sessionId,
          projectId: id,
          projectRevision: p.revision,
          sourceHash: p.source_hash,
          readsetHash: readset.hash,
        },
        context: readset.context,
      };
    });
    return engine.quote(
      owner,
      { ...snapshot.binding, operationId: b.operationId, context: snapshot.context },
      this.guard(owner),
    );
  }
  async dispatch(owner: string, id: string, input: unknown) {
    const b = spatialDispatchRequestSchema.parse(input),
      engine = this.configured();
    const quote = (
      await this.db.query(
        'SELECT project_id,project_revision FROM live_authoring_text_quotes WHERE id=$1 AND actor_id=$2',
        [b.quoteId, owner],
      )
    )[0];
    if (!quote || quote.project_id !== id) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    if (quote.project_revision !== b.expectedRevision) fail(409, 'STALE_STATE', 'STALE_STATE');
    const job = await engine.enqueue(
      owner,
      { quoteId: b.quoteId, operationId: b.operationId, consent: true },
      this.guard(owner),
    );
    return engine.run(owner, job.id, this.guard(owner, job.id), async (c, binding, value) => {
      const checked = value as ValidatedSpatialPlan;
      const neutral = validateSpatialPlan(checked.layout);
      if (digest(neutral.plan) !== digest(checked.plan)) fail(409, 'INVALID_MAP', 'INVALID_MAP');
      const project = await this.visuals.spatialProject(c, owner, id, binding.projectRevision);
      const validated = authorizeSpatialPlan(checked.layout, project.plan_authority ?? {});
      const prior = (
        await c.query('SELECT id FROM visual_spatial_proposals WHERE job_id=$1', [job.id])
      ).rows[0];
      if (prior) return { proposalId: prior.id };
      const proposalId = randomUUID();
      await c.query(
        `INSERT INTO visual_spatial_proposals(id,project_id,job_id,owner_id,project_revision,source_hash,readset_hash,layout,plan,checksum)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          proposalId,
          id,
          job.id,
          owner,
          binding.projectRevision,
          binding.sourceHash,
          binding.readsetHash,
          JSON.stringify(validated.layout),
          JSON.stringify(validated.plan),
          digest(validated),
        ],
      );
      return { proposalId };
    });
  }
  async apply(owner: string, id: string, input: unknown) {
    return this.visuals.applySpatialPlan(owner, id, input);
  }
  async cancel(owner: string, id: string, jobId: string, input: unknown) {
    const b = visualMutationSchema.parse(input);
    const p = await this.project(owner, id);
    if (p.revision !== b.expectedRevision) fail(409, 'STALE_STATE', 'STALE_STATE');
    z.uuid().parse(jobId);
    const job = (
      await this.db.query(
        'SELECT id FROM live_authoring_text_jobs WHERE id=$1 AND project_id=$2 AND actor_id=$3',
        [jobId, id, owner],
      )
    )[0];
    if (!job) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    if (
      (
        await this.db.query(
          "SELECT 1 FROM visual_spatial_proposals WHERE job_id=$1 AND status='applied'",
          [jobId],
        )
      ).length
    )
      fail(409, 'SPATIAL_PROPOSAL_ALREADY_APPLIED', 'SPATIAL_PROPOSAL_ALREADY_APPLIED');
    const result = await this.configured().cancel(owner, jobId);
    await this.db.query(
      "UPDATE visual_spatial_proposals SET status='cancelled' WHERE job_id=$1 AND status='proposed'",
      [jobId],
    );
    return result;
  }
  async cancelPendingForProject(owner: string, id: string) {
    if (!this.engine) return;
    const rows = await this.db.query(
      "SELECT id FROM live_authoring_text_jobs WHERE project_id=$1 AND actor_id=$2 AND status IN ('queued','dispatched','generated','unknown')",
      [id, owner],
    );
    for (const job of rows) await this.engine.cancel(owner, job.id);
    await this.db.query(
      "UPDATE visual_spatial_proposals SET status='cancelled' WHERE project_id=$1 AND owner_id=$2 AND status='proposed'",
      [id, owner],
    );
  }
}
