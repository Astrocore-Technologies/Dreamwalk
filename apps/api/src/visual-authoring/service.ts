import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { unlink, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  turnRulesSchema,
  narrativeConstraintsSchema,
  supportingNpcPolicySchema,
  authoredGameDraftSchema,
  heroSchema,
  npcSchema,
  visualAuthoringRequestSchema,
  visualMutationSchema,
  visualLayerEditSchema,
  spatialApplyRequestSchema,
  visualGenerationQuoteSchema,
  visualGenerationDispatchSchema,
  visualGenerationReuseSchema,
  type VisualGenerationRole,
  characterAnimation,
  type AuthoredGameDraft,
  type GameState,
  type VisualPackage,
} from '@dreamwalk/contracts';
import {
  compilePlayableDraft,
  applyAction,
  projectState,
  tick,
  advanceObjectives,
} from '@dreamwalk/game-core';
import { Db } from '../db';
import { ImageGenerationService, ImageGenerationEngine } from '../image-generation/service';
import {
  generationRequestSchema,
  type AuthoringContext,
  type GenerationRequest,
} from '../image-generation/contracts';
import {
  buildArtRequest,
  requiredArtRoles,
  checkArtRaster,
  normalizeArtAtlas,
  isSheet,
  type AuthoringArtSource,
} from './real-art';
import { AssetReuseService } from '../assets/reuse.service';
import { storeRasterTx } from '../assets/raster';
import { config } from '../config';
import { fail } from '../errors';
import { createAuthorSandbox } from './sandbox';
import { fixtureRaster } from './fixture-art';
import { createLocationFixture } from './location-fixture';
import { ownedCharacterPackage } from './character-package';
import { visualDigest as digest } from './fingerprint';
import { authorizeSpatialPlan, spatialReadset, type SpatialAuthority } from './spatial-plan';
const previewActor = 'visual-preview-player';
function stageRequestDigest(input: GenerationRequest) {
  // The authority pins this derived ID after the stage request is stored. It is
  // validated independently at every financial boundary, not authored content.
  const content = { ...input };
  delete content.generationAuthorizationId;
  return digest(content);
}
type Project = {
  id: string;
  owner_id: string;
  kind: 'character' | 'location';
  adventure_id: string | null;
  brief: AuthoringArtSource['brief'];
  generation_mode?: 'fixture' | 'external';
  plan_origin?: 'fixture' | 'manual' | 'ai-pending' | 'ai-generated-plan';
  plan_authority?: Partial<SpatialAuthority>;
  public_grounding?: AuthoringArtSource['public_grounding'];
  status: 'concept' | 'approved' | 'ready' | 'cancelled';
  revision: number;
  source_hash: string;
  last_applied_source_hash?: string;
  concept_revision_id: string | null;
  plan: AuthoredGameDraft | null;
  preview_state: GameState | null;
};
@Injectable()
export class VisualAuthoringService {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(AssetReuseService) private assets: AssetReuseService,
    @Inject(ImageGenerationService) private images: ImageGenerationEngine,
  ) {
    this.images.setAuthoringValidator((c, owner, context, input) =>
      this.validateGeneration(c, owner, context, input),
    );
  }
  configuration() {
    const image = this.images.configuration();
    return {
      provider: 'fixture',
      chargeMicros: 0,
      externalAvailable: image.externalEnabled,
      blockers: image.externalBlockReasons ?? [],
      image,
      stages: ['concept', 'approved', 'ready'],
      generation: {
        manualDispatchOnly: true,
        automaticRetry: false,
        humanVisualReviewRequired: true,
        spatialPlan: 'deterministic-editable-template',
        structuralChecks: ['alpha', '24-nonempty-frames', 'square-atlas', 'immutable-hash'],
      },
    };
  }
  private async validateGeneration(
    c: PoolClient,
    owner: string,
    context: AuthoringContext,
    input: GenerationRequest,
  ) {
    const p = await this.own(c, owner, context.projectId);
    if (p.generation_mode !== 'external' || p.status === 'cancelled' || p.status === 'ready')
      fail(409, 'STATE_CONFLICT', 'STATE_CONFLICT');
    await this.fresh(c, owner, p);
    const row = (
      await c.query(
        'SELECT * FROM visual_authoring_stage_items WHERE project_id=$1 AND role=$2 FOR SHARE',
        [p.id, context.role],
      )
    ).rows[0];
    if (
      !row ||
      row.expected_project_revision !== p.revision ||
      context.expectedProjectRevision !== p.revision ||
      context.sourceHash !== p.source_hash ||
      context.stage !== row.stage ||
      stageRequestDigest(input) !== stageRequestDigest(row.request)
    )
      fail(409, 'MEDIA_CONTEXT_STALE', 'MEDIA_CONTEXT_STALE');
    if (
      input.privateReferenceAssetIds.length &&
      (!p.brief.sourcePhotoPermission ||
        input.privateReferenceAssetIds[0] !== p.brief.sourcePhotoAssetId ||
        context.role !== 'concept')
    )
      fail(403, 'SOURCE_PHOTO_PERMISSION_REQUIRED', 'SOURCE_PHOTO_PERMISSION_REQUIRED');
  }
  private artStage(p: Project, role: VisualGenerationRole) {
    if (
      p.generation_mode !== 'external' ||
      !requiredArtRoles(p.kind, p.status, p.plan).includes(role) ||
      !['concept', 'approved'].includes(p.status) ||
      (p.kind === 'location' &&
        (p.status !== 'approved' || !p.plan || p.plan_origin === 'ai-pending'))
    )
      fail(409, 'STATE_CONFLICT', 'STATE_CONFLICT');
  }
  async quoteGeneration(owner: string, id: string, input: unknown) {
    const b = visualGenerationQuoteSchema.parse(input);
    const request = await this.mutate(
      owner,
      b.operationId,
      { action: 'quoteGeneration', id, ...b },
      async (c) => {
        const p = await this.own(c, owner, id, b.expectedRevision);
        this.artStage(p, b.role);
        await this.fresh(c, owner, p);
        const old = (
          await c.query(
            'SELECT * FROM visual_authoring_stage_items WHERE project_id=$1 AND role=$2 FOR UPDATE',
            [id, b.role],
          )
        ).rows[0];
        if (old?.job_id || old?.dispatch_operation_id || old?.reused_revision_id)
          fail(409, 'GENERATION_ALREADY_STARTED', 'GENERATION_ALREADY_STARTED');
        let styleReferenceRevisionId: string | undefined;
        if (p.kind === 'location' && b.role !== 'background') {
          const background = (
            await c.query(
              `SELECT COALESCE(s.reused_revision_id,j.admitted_revision_id) AS revision_id
            FROM visual_authoring_stage_items s LEFT JOIN image_generation_jobs j ON j.id=s.job_id
            WHERE s.project_id=$1 AND s.role='background' AND (s.reused_revision_id IS NOT NULL OR j.status='admitted')`,
              [id],
            )
          ).rows[0];
          if (background?.revision_id) {
            await this.readPart(c, owner, background.revision_id, 'background');
            styleReferenceRevisionId = background.revision_id;
          }
        }
        const request = generationRequestSchema.parse({
          ...buildArtRequest(p, b.role, styleReferenceRevisionId),
          declineReuse: b.declineReuse,
          ...(b.liveTestSessionId ? { liveTestSessionId: b.liveTestSessionId } : {}),
        });
        await c.query(
          `INSERT INTO visual_authoring_stage_items(project_id,role,stage,expected_project_revision,request,quote_operation_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,role) DO UPDATE SET
        expected_project_revision=$4,request=$5,quote_operation_id=$6,quote_id=NULL,quote_result=NULL,updated_at=now()`,
          [
            id,
            b.role,
            request.authoringContext!.stage,
            p.revision,
            JSON.stringify(request),
            b.operationId,
          ],
        );
        return request;
      },
    );
    const current = (
      await this.db.query(
        'SELECT quote_result,quote_operation_id FROM visual_authoring_stage_items WHERE project_id=$1 AND role=$2',
        [id, b.role],
      )
    )[0];
    if (current?.quote_operation_id !== b.operationId) fail(409, 'STALE_STATE', 'STALE_STATE');
    if (current.quote_result) return current.quote_result;
    // Quoting makes no provider request. An interrupted quote may be retried; dispatch is separately idempotent.
    const result = await this.images.quote(owner, request);
    const changed = await this.db.query(
      `UPDATE visual_authoring_stage_items SET quote_id=$4,quote_result=$5,updated_at=now()
      WHERE project_id=$1 AND role=$2 AND quote_operation_id=$3 AND job_id IS NULL RETURNING role`,
      [
        id,
        b.role,
        b.operationId,
        'quote' in result ? (result.quote?.id ?? null) : null,
        JSON.stringify(result),
      ],
    );
    if (!changed.length) fail(409, 'STALE_STATE', 'STALE_STATE');
    return result;
  }
  async dispatchGeneration(owner: string, id: string, input: unknown) {
    const b = visualGenerationDispatchSchema.parse(input);
    await this.mutate(
      owner,
      b.operationId,
      { action: 'dispatchGeneration', id, ...b },
      async (c) => {
        const p = await this.own(c, owner, id, b.expectedRevision);
        this.artStage(p, b.role);
        await this.fresh(c, owner, p);
        const row = (
          await c.query(
            'SELECT * FROM visual_authoring_stage_items WHERE project_id=$1 AND role=$2 FOR UPDATE',
            [id, b.role],
          )
        ).rows[0];
        if (!row || row.quote_id !== b.quoteId || row.reused_revision_id)
          fail(409, 'QUOTE_MISMATCH', 'QUOTE_MISMATCH');
        if (row.job_id && row.dispatch_operation_id !== b.operationId)
          fail(409, 'GENERATION_ALREADY_STARTED', 'GENERATION_ALREADY_STARTED');
        if (row.dispatch_operation_id && row.dispatch_operation_id !== b.operationId)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        await c.query(
          'UPDATE visual_authoring_stage_items SET dispatch_operation_id=$3 WHERE project_id=$1 AND role=$2',
          [id, b.role, b.operationId],
        );
        return { prepared: true };
      },
    );
    const current = (
      await this.db.query(
        'SELECT job_id,dispatch_operation_id FROM visual_authoring_stage_items WHERE project_id=$1 AND role=$2',
        [id, b.role],
      )
    )[0];
    if (current?.dispatch_operation_id !== b.operationId)
      fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
    if (current.job_id) return this.images.get(owner, current.job_id);
    // Only this explicit consent endpoint enqueues. No polling/approval/world idle code invokes it.
    const job = await this.images.enqueue(owner, {
      quoteId: b.quoteId,
      operationId: b.operationId,
      consent: true,
      ...(b.estimateRiskConsent ? { estimateRiskConsent: true } : {}),
    });
    await this.db.query(
      `UPDATE visual_authoring_stage_items SET job_id=$4,updated_at=now()
      WHERE project_id=$1 AND role=$2 AND dispatch_operation_id=$3 AND (job_id IS NULL OR job_id=$4)`,
      [id, b.role, b.operationId, job.id],
    );
    return job;
  }
  async reuseGeneration(owner: string, id: string, input: unknown) {
    const b = visualGenerationReuseSchema.parse(input);
    return this.mutate(owner, b.operationId, { action: 'reuseGeneration', id, ...b }, async (c) => {
      const p = await this.own(c, owner, id, b.expectedRevision);
      this.artStage(p, b.role);
      await this.fresh(c, owner, p);
      const old = (
        await c.query(
          'SELECT * FROM visual_authoring_stage_items WHERE project_id=$1 AND role=$2 FOR UPDATE',
          [id, b.role],
        )
      ).rows[0];
      if (old?.job_id || old?.dispatch_operation_id || old?.reused_revision_id)
        fail(409, 'GENERATION_ALREADY_STARTED', 'GENERATION_ALREADY_STARTED');
      // First implementation admits already owned library references. Foreign grants are never silently copied.
      const part = await this.readPart(c, owner, b.revisionId, b.role);
      if (!(await checkArtRaster(part.bytes, b.role)).valid)
        fail(409, 'ART_VALIDATION_FAILED', 'ART_VALIDATION_FAILED');
      const request = buildArtRequest(p, b.role);
      await c.query(
        `INSERT INTO visual_authoring_stage_items(project_id,role,stage,expected_project_revision,request,reused_revision_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,role) DO UPDATE SET reused_revision_id=$6,updated_at=now()`,
        [
          id,
          b.role,
          request.authoringContext!.stage,
          p.revision,
          JSON.stringify(request),
          b.revisionId,
        ],
      );
      return { reused: true, revisionId: b.revisionId, providerCalls: 0, chargeMicros: 0 };
    });
  }
  private async readPart(c: PoolClient, owner: string, revisionId: string, role: string) {
    const row = (
      await c.query(
        `SELECT r.id,r.upload_id,r.sha256,r.width,r.height,r.metadata,a.filename FROM art_asset_revisions r
      JOIN assets a ON a.id=r.upload_id JOIN users u ON u.id=a.owner_id
      WHERE r.id=$1 AND a.owner_id=$2 AND u.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM art_asset_takedowns t WHERE t.revision_id=r.id) FOR SHARE OF r,a,u`,
        [revisionId, owner],
      )
    ).rows[0];
    if (!row) fail(409, 'ART_UNAVAILABLE', 'ART_UNAVAILABLE');
    const kind =
      role === 'portrait'
        ? 'portrait'
        : role.endsWith('background')
          ? 'background'
          : isSheet(role) || role === 'concept'
            ? 'sprite'
            : 'object';
    if (
      row.metadata?.kind !== kind ||
      row.metadata?.style !== 'drawn2D' ||
      !['top-down', role === 'portrait' ? 'portrait' : 'top-down'].includes(row.metadata?.camera)
    )
      fail(409, 'ART_INCOMPATIBLE', 'ART_INCOMPATIBLE');
    const bytes = await readFile(resolve(config.ASSET_DIR, row.filename));
    const { createHash } = await import('node:crypto');
    if (createHash('sha256').update(bytes).digest('hex') !== row.sha256)
      fail(409, 'ASSET_INTEGRITY_FAILED', 'ASSET_INTEGRITY_FAILED');
    return {
      role,
      revisionId: row.id,
      uploadId: row.upload_id,
      sha256: row.sha256,
      width: row.width,
      height: row.height,
      bytes,
    };
  }
  async generation(owner: string, id: string) {
    return this.db.tx(async (c) => {
      const p = await this.own(c, owner, id),
        roles = requiredArtRoles(p.kind, p.status, p.plan);
      const rows = (
        await c.query(
          `SELECT s.*,j.status AS job_status,j.admitted_revision_id,j.actual_micros,j.error_code
        FROM visual_authoring_stage_items s LEFT JOIN image_generation_jobs j ON j.id=s.job_id WHERE s.project_id=$1`,
          [id],
        )
      ).rows;
      const items: {
        role: string;
        stage: string;
        status: string;
        quote: unknown;
        job?: Awaited<ReturnType<ImageGenerationEngine['get']>>;
        revisionId?: string;
        dispatchOperationId?: string;
        url?: string;
        validation?: {
          valid: boolean;
          code?: string;
          width?: number;
          height?: number;
          nonemptyFrames?: number;
        };
      }[] = [];
      for (const row of rows) {
        const revisionId = row.reused_revision_id ?? row.admitted_revision_id;
        let validation;
        if (revisionId) {
          try {
            const part = await this.readPart(c, owner, revisionId, row.role);
            validation = await checkArtRaster(part.bytes, row.role);
          } catch {
            validation = { valid: false, code: 'ART_UNAVAILABLE' };
          }
        }
        const job = row.job_id ? await this.images.get(owner, row.job_id) : undefined;
        items.push({
          role: row.role,
          stage: row.stage,
          status: row.reused_revision_id
            ? 'reused'
            : (row.job_status ??
              (row.dispatch_operation_id
                ? 'dispatch-prepared'
                : row.quote_id
                  ? 'quoted'
                  : 'prepared')),
          quote: row.quote_result,
          dispatchOperationId: row.dispatch_operation_id ?? undefined,
          job,
          revisionId,
          url: revisionId ? `/api/v1/asset-library/revisions/${revisionId}/file` : undefined,
          validation,
        });
      }
      return {
        projectId: id,
        mode: p.generation_mode ?? 'fixture',
        requiredRoles: roles,
        items,
        readyForReview: roles.every((role) =>
          items.some((i) => i.role === role && i.validation?.valid),
        ),
        automaticRetry: false,
        humanVisualReviewRequired: true,
        configuration: this.images.configuration(),
      };
    });
  }
  private async generatedParts(
    c: PoolClient,
    owner: string,
    p: Project,
    roles: VisualGenerationRole[],
    files?: string[],
  ) {
    const rows = (
      await c.query(
        `SELECT s.*,j.status AS job_status,j.admitted_revision_id,j.actual_micros
      FROM visual_authoring_stage_items s LEFT JOIN image_generation_jobs j ON j.id=s.job_id WHERE s.project_id=$1 FOR SHARE OF s`,
        [p.id],
      )
    ).rows;
    const parts: VisualPackage['parts'] = [],
      jobIds: string[] = [];
    let chargeMicros = 0,
      providerCalls = 0;
    for (const role of roles) {
      const row = rows.find((r) => r.role === role),
        revisionId = row?.reused_revision_id ?? row?.admitted_revision_id;
      if (
        !row ||
        !revisionId ||
        (!row.reused_revision_id && (row.job_status !== 'admitted' || row.actual_micros === null))
      )
        fail(409, 'GENERATION_INCOMPLETE', 'GENERATION_INCOMPLETE');
      const part = await this.readPart(c, owner, revisionId, role);
      const check = await checkArtRaster(part.bytes, role);
      if (!check.valid) fail(409, 'ART_VALIDATION_FAILED', check.code ?? 'ART_VALIDATION_FAILED');
      let output: VisualPackage['parts'][number] = {
        role,
        revisionId: part.revisionId,
        uploadId: part.uploadId,
        sha256: part.sha256,
        width: part.width,
        height: part.height,
      };
      if (files && isSheet(role)) {
        const raster = await normalizeArtAtlas(part.bytes),
          uploadId = randomUUID();
        files.push(uploadId);
        await storeRasterTx(c, owner, uploadId, raster);
        const revision = await this.assets.registerTx(c, owner, {
          operationId: randomUUID(),
          uploadId,
          metadata: {
            title: `${p.brief.name} - ${role}`.slice(0, 120),
            kind: 'sprite',
            style: 'drawn2D',
            camera: 'top-down',
            tags: ['authoring', 'normalized-atlas'],
            variant: 'normalized-atlas-v1',
            provenance: {
              source: 'generated',
              provider: 'deterministic-atlas-normalization',
              reference: part.revisionId,
            },
            rights: {
              basis: 'generated',
              licenseLabel: 'Owner-approved generated art',
              attribution: '',
              allowAuthorReuse: p.brief.allowOutputReuse ?? false,
              attested: true,
            },
          },
        });
        output = {
          role,
          revisionId: revision.id,
          uploadId,
          sha256: raster.sha256,
          width: raster.width,
          height: raster.height,
        };
      }
      parts.push(output);
      if (row.job_id) {
        jobIds.push(row.job_id);
        providerCalls++;
        chargeMicros += Number(row.actual_micros);
      }
    }
    return { parts, jobIds, providerCalls, chargeMicros };
  }
  async spatialProject(c: PoolClient, owner: string, id: string, expectedRevision?: number) {
    const p = await this.own(c, owner, id, expectedRevision);
    if (p.kind !== 'location' || p.generation_mode !== 'external')
      fail(409, 'SPATIAL_MODE_REQUIRED', 'SPATIAL_MODE_REQUIRED');
    await this.fresh(c, owner, p);
    return p;
  }
  async applySpatialPlan(owner: string, id: string, input: unknown) {
    const b = spatialApplyRequestSchema.parse(input);
    return this.mutate(
      owner,
      b.operationId,
      { action: 'applySpatialPlan', id, ...b },
      async (c) => {
        const p = await this.spatialProject(c, owner, id, b.expectedRevision);
        if (p.status !== 'concept' || p.plan_origin !== 'ai-pending')
          fail(409, 'STATE_CONFLICT', 'STATE_CONFLICT');
        const proposal = (
          await c.query(
            'SELECT * FROM visual_spatial_proposals WHERE id=$1 AND project_id=$2 AND owner_id=$3 FOR UPDATE',
            [b.proposalId, id, owner],
          )
        ).rows[0];
        if (!proposal || proposal.status !== 'proposed')
          fail(409, 'SPATIAL_PROPOSAL_UNAVAILABLE', 'SPATIAL_PROPOSAL_UNAVAILABLE');
        if (
          proposal.project_revision !== p.revision ||
          proposal.source_hash !== p.source_hash ||
          proposal.readset_hash !== spatialReadset(p).hash
        )
          fail(409, 'STALE_STATE', 'STALE_STATE');
        if (digest({ layout: proposal.layout, plan: proposal.plan }) !== proposal.checksum)
          fail(409, 'ASSET_INTEGRITY_FAILED', 'ASSET_INTEGRITY_FAILED');
        const validated = authorizeSpatialPlan(proposal.layout, p.plan_authority ?? {});
        if (digest(validated.plan) !== digest(proposal.plan))
          fail(409, 'STALE_STATE', 'STALE_STATE');
        const compiled = compilePlayableDraft(validated.plan);
        if (!compiled.playable) fail(409, 'INVALID_MAP', 'INVALID_MAP');
        p.plan = validated.plan;
        p.preview_state = createAuthorSandbox(compiled.playable!);
        p.plan_origin = 'ai-generated-plan';
        p.revision++;
        await c.query(
          'UPDATE visual_authoring_projects SET plan=$2,preview_state=$3,plan_origin=$4,revision=$5,updated_at=now() WHERE id=$1',
          [id, JSON.stringify(p.plan), JSON.stringify(p.preview_state), p.plan_origin, p.revision],
        );
        await c.query("UPDATE visual_spatial_proposals SET status='applied' WHERE id=$1", [
          b.proposalId,
        ]);
        return this.view(p);
      },
    );
  }
  private async mutate<T>(
    owner: string,
    operationId: string,
    body: unknown,
    work: (c: PoolClient, files: string[]) => Promise<T>,
  ) {
    const files: string[] = [];
    try {
      return await this.db.tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `art-owner:${owner}`,
        ]);
        await this.assets.lockAuthor(c, owner);
        const prior = (
          await c.query(
            'SELECT * FROM visual_authoring_operations WHERE owner_id=$1 AND operation_id=$2',
            [owner, operationId],
          )
        ).rows[0];
        const hash = digest(body);
        if (prior) {
          if (prior.request_hash !== hash)
            fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
          return prior.result as T;
        }
        const recent = (
          await c.query(
            "SELECT count(*)::int AS n FROM visual_authoring_operations WHERE owner_id=$1 AND created_at>now()-interval '1 minute'",
            [owner],
          )
        ).rows[0];
        if (recent.n >= 30) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
        const result = await work(c, files);
        await c.query(
          'INSERT INTO visual_authoring_operations(owner_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)',
          [owner, operationId, hash, JSON.stringify(result)],
        );
        return result;
      });
    } catch (error) {
      // Only newly assigned UUID files from this failed transaction, never existing user uploads.
      await Promise.all(
        files.map((id) => unlink(resolve(config.ASSET_DIR, `${id}.webp`)).catch(() => undefined)),
      );
      throw error;
    }
  }
  private async source(c: PoolClient, owner: string, adventureId: string) {
    const story = (
      await c.query(
        "SELECT * FROM adventures WHERE id=$1 AND owner_id=$2 AND status<>'archived' FOR UPDATE",
        [adventureId, owner],
      )
    ).rows[0];
    if (!story) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const game = (
      await c.query('SELECT revision,draft FROM adventure_game_drafts WHERE adventure_id=$1', [
        adventureId,
      ])
    ).rows[0];
    const art = (
      await c.query('SELECT revision FROM art_story_asset_drafts WHERE adventure_id=$1', [
        adventureId,
      ])
    ).rows[0];
    return {
      story,
      gameDraft: game?.draft,
      hash: digest({
        data: story.data,
        title: story.title,
        edit: story.edit_revision,
        game: game?.revision ?? 0,
        art: art?.revision ?? 0,
      }),
    };
  }
  private async own(c: PoolClient, owner: string, id: string, expected?: number) {
    const p = (
      await c.query<Project>(
        'SELECT * FROM visual_authoring_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [z.uuid().parse(id), owner],
      )
    ).rows[0];
    if (!p) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    if (expected !== undefined && expected !== p.revision) fail(409, 'STALE_STATE', 'STALE_STATE');
    return p;
  }
  private async photo(c: PoolClient, owner: string, p: Project) {
    if (
      p.brief.sourcePhotoAssetId &&
      !(
        await c.query(
          'SELECT id FROM assets WHERE id=$1 AND owner_id=$2 AND NOT EXISTS(SELECT 1 FROM art_asset_revisions r JOIN art_asset_takedowns t ON t.revision_id=r.id WHERE r.upload_id=assets.id) FOR SHARE',
          [p.brief.sourcePhotoAssetId, owner],
        )
      ).rowCount
    )
      fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
  }
  private async fresh(c: PoolClient, owner: string, p: Project) {
    if (p.adventure_id && (await this.source(c, owner, p.adventure_id)).hash !== p.source_hash)
      fail(409, 'STALE_STATE', 'STALE_STATE');
    await this.photo(c, owner, p);
  }
  view(p: Project) {
    return {
      id: p.id,
      kind: p.kind,
      name: p.brief.name,
      sourceHash: p.source_hash,
      status: p.status,
      revision: p.revision,
      provider: p.generation_mode ?? 'fixture',
      ...(p.generation_mode === 'external'
        ? { generationReady: p.status === 'ready' }
        : { providerCalls: 0, chargeMicros: 0 }),
      planProvenance:
        p.kind === 'location' ? (p.plan_origin ?? 'deterministic-editable-template') : undefined,
      conceptRevisionId: p.concept_revision_id,
      conceptUrl: p.concept_revision_id
        ? `/api/v1/asset-library/revisions/${p.concept_revision_id}/file`
        : null,
      plan: p.plan,
      projection: p.preview_state ? projectState(p.preview_state, previewActor) : null,
      sourcePhotoPrivate: !!p.brief.sourcePhotoAssetId,
    };
  }
  private async admit(c: PoolClient, owner: string, p: Project, role: string, files: string[]) {
    const raster = await fixtureRaster(role === 'sample-sheet' ? 'sheet' : role),
      uploadId = randomUUID();
    files.push(uploadId);
    await storeRasterTx(c, owner, uploadId, raster);
    const kind =
      role === 'concept'
        ? 'sprite'
        : role === 'portrait'
          ? 'portrait'
          : ['sheet', 'sample-sheet', 'npc-sheet'].includes(role)
            ? 'sprite'
            : role.endsWith('background')
              ? 'background'
              : 'object';
    const revision = await this.assets.registerTx(c, owner, {
      operationId: randomUUID(),
      uploadId,
      metadata: {
        title: `${p.brief.name} · ${role}`,
        kind,
        style: 'drawn2D',
        camera: kind === 'portrait' ? 'portrait' : 'top-down',
        tags: ['original-fixture', p.kind === 'character' ? 'astral-ranger' : 'alchemist-atelier'],
        variant: `fixture-v1-${role}`,
        provenance: {
          source: 'licensed-import',
          reference: 'Dreamwalk original code-drawn acceptance fixture v1; no AI request',
        },
        rights: {
          basis: 'licensed',
          licenseLabel: 'Dreamwalk original fixture',
          attribution: 'Dreamwalk',
          allowAuthorReuse: p.brief.allowOutputReuse ?? false,
          attested: true,
        },
      },
    });
    return {
      role,
      revisionId: revision.id,
      uploadId,
      sha256: raster.sha256,
      width: raster.width,
      height: raster.height,
    };
  }
  async create(owner: string, input: unknown) {
    const b = visualAuthoringRequestSchema.parse(input);
    return this.mutate(owner, b.operationId, { action: 'create', ...b }, async (c, files) => {
      const count = (
        await c.query(
          'SELECT count(*)::int AS n FROM visual_authoring_projects WHERE owner_id=$1',
          [owner],
        )
      ).rows[0];
      if (count.n >= 100) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
      const source = b.kind === 'location' ? await this.source(c, owner, b.adventureId) : null;
      const planOrigin =
        b.kind === 'location'
          ? b.generationMode === 'fixture'
            ? 'fixture'
            : (b.spatialMode ?? 'ai') === 'ai'
              ? 'ai-pending'
              : 'manual'
          : 'fixture';
      if (b.kind === 'location' && b.generationMode === 'fixture' && b.spatialMode === 'ai')
        fail(400, 'EXTERNAL_PLANNER_MODE_REQUIRED', 'EXTERNAL_PLANNER_MODE_REQUIRED');
      const plan =
        b.kind === 'location' && planOrigin !== 'ai-pending'
          ? createLocationFixture(b.brief)
          : null;
      const compiled = plan ? compilePlayableDraft(plan) : null;
      if (compiled && !compiled.playable) fail(400, 'INVALID_MAP', compiled.errors.join(';'));
      const p: Project = {
        id: randomUUID(),
        owner_id: owner,
        kind: b.kind,
        generation_mode: b.generationMode,
        plan_origin: planOrigin,
        plan_authority: source
          ? {
              turnRules: turnRulesSchema.parse(source.gameDraft?.turnRules ?? {}),
              narrativeConstraints: narrativeConstraintsSchema.parse(
                source.gameDraft?.narrativeConstraints ?? {},
              ),
              ...(source.gameDraft?.supportingNpcPolicy
                ? {
                    supportingNpcPolicy: supportingNpcPolicySchema.parse(
                      source.gameDraft.supportingNpcPolicy,
                    ),
                  }
                : {}),
              ...(source.gameDraft?.roundPolicy
                ? {
                    roundPolicy: authoredGameDraftSchema.shape.roundPolicy.parse(
                      source.gameDraft.roundPolicy,
                    ),
                  }
                : {}),
            }
          : {},
        public_grounding: source
          ? {
              title: String(source.story.title).slice(0, 120),
              ...(typeof source.story.data?.content?.world === 'string'
                ? { world: source.story.data.content.world.slice(0, 1000) }
                : {}),
              ...(() => {
                const content = source.story.data?.content;
                const scene = Array.isArray(content?.scenes)
                  ? content.scenes.find(
                      (s: { id?: unknown; description?: unknown }) =>
                        s?.id === content.startSceneId,
                    )
                  : undefined;
                return typeof scene?.description === 'string'
                  ? { opening: scene.description.slice(0, 600) }
                  : {};
              })(),
              ...(() => {
                const locations = source.gameDraft?.maps ?? source.story.data?.content?.locations;
                return Array.isArray(locations)
                  ? {
                      locations: locations
                        .slice(0, 4)
                        .map((m: { label?: unknown; name?: unknown; description?: unknown }) => ({
                          name:
                            typeof m.label === 'string'
                              ? m.label.slice(0, 80)
                              : typeof m.name === 'string'
                                ? m.name.slice(0, 80)
                                : '',
                          description:
                            typeof m.description === 'string' ? m.description.slice(0, 250) : '',
                        })),
                    }
                  : {};
              })(),
              ...(typeof source.story.synopsis === 'string'
                ? { synopsis: source.story.synopsis.slice(0, 500) }
                : {}),
              ...(typeof source.story.genre === 'string'
                ? { genre: source.story.genre.slice(0, 80) }
                : {}),
            }
          : {},
        adventure_id: b.kind === 'location' ? b.adventureId : null,
        brief: b.brief,
        source_hash: source?.hash ?? digest(b.brief),
        status: 'concept',
        revision: 1,
        plan,
        concept_revision_id: null,
        preview_state: compiled?.playable ? createAuthorSandbox(compiled.playable!) : null,
      };
      await this.photo(c, owner, p);
      if (b.kind === 'character' && b.generationMode === 'fixture')
        p.concept_revision_id = (await this.admit(c, owner, p, 'concept', files)).revisionId;
      await c.query(
        'INSERT INTO visual_authoring_projects(id,owner_id,kind,adventure_id,brief,source_hash,status,plan,concept_revision_id,preview_state,generation_mode,public_grounding,plan_origin,plan_authority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [
          p.id,
          owner,
          p.kind,
          p.adventure_id,
          JSON.stringify(p.brief),
          p.source_hash,
          p.status,
          JSON.stringify(plan),
          p.concept_revision_id,
          JSON.stringify(p.preview_state),
          p.generation_mode,
          JSON.stringify(p.public_grounding),
          p.plan_origin,
          JSON.stringify(p.plan_authority),
        ],
      );
      return this.view(p);
    });
  }
  async list(owner: string) {
    return (
      await this.db.query<Project>(
        'SELECT * FROM visual_authoring_projects WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',
        [owner],
      )
    ).map((p) => this.view(p));
  }
  async get(owner: string, id: string) {
    return this.db.tx(async (c) => this.view(await this.own(c, owner, id)));
  }
  async approve(owner: string, id: string, input: unknown) {
    const b = visualMutationSchema
      .extend({ consent: z.literal(true) })
      .strict()
      .parse(input);
    return this.mutate(owner, b.operationId, { action: 'approve', id, ...b }, async (c) => {
      const p = await this.own(c, owner, id, b.expectedRevision);
      if (p.status !== 'concept') fail(409, 'STATE_CONFLICT', 'STATE_CONFLICT');
      if (p.kind === 'location' && (!p.plan || p.plan_origin === 'ai-pending'))
        fail(409, 'SPATIAL_PLAN_REQUIRED', 'SPATIAL_PLAN_REQUIRED');
      await this.fresh(c, owner, p);
      if (p.generation_mode === 'external' && p.kind === 'character') {
        const concept = await this.generatedParts(c, owner, p, ['concept']);
        p.concept_revision_id = concept.parts[0].revisionId;
      }
      if (p.concept_revision_id) await this.assets.revision(owner, p.concept_revision_id);
      p.status = 'approved';
      p.revision++;
      await c.query(
        "UPDATE visual_authoring_projects SET status='approved',revision=$2,concept_revision_id=$3,updated_at=now() WHERE id=$1",
        [id, p.revision, p.concept_revision_id],
      );
      return this.view(p);
    });
  }
  async complete(owner: string, id: string, input: unknown) {
    const b = visualMutationSchema
      .extend({ consent: z.literal(true), visualReview: z.literal(true).optional() })
      .strict()
      .parse(input);
    return this.mutate(owner, b.operationId, { action: 'complete', id, ...b }, async (c, files) => {
      const p = await this.own(c, owner, id, b.expectedRevision);
      if (p.status !== 'approved') fail(409, 'STATE_CONFLICT', 'STATE_CONFLICT');
      await this.fresh(c, owner, p);
      const parts: VisualPackage['parts'] = [];
      let live: Awaited<ReturnType<VisualAuthoringService['generatedParts']>> | undefined;
      if (p.generation_mode === 'external') {
        if (!b.visualReview) fail(400, 'VISUAL_REVIEW_REQUIRED', 'VISUAL_REVIEW_REQUIRED');
        live = await this.generatedParts(
          c,
          owner,
          p,
          p.kind === 'character'
            ? ['concept', 'portrait', 'sheet']
            : requiredArtRoles(p.kind, p.status, p.plan),
          files,
        );
        parts.push(...live.parts);
      } else if (p.kind === 'character') {
        const concept = (
          await c.query(
            'SELECT r.*,a.id AS upload_id FROM art_asset_revisions r JOIN assets a ON a.id=r.upload_id WHERE r.id=$1 AND a.owner_id=$2 AND NOT EXISTS(SELECT 1 FROM art_asset_takedowns t WHERE t.revision_id=r.id) FOR SHARE OF r,a',
            [p.concept_revision_id, owner],
          )
        ).rows[0];
        if (!concept) fail(409, 'ART_UNAVAILABLE', 'ART_UNAVAILABLE');
        parts.push({
          role: 'concept',
          revisionId: concept.id,
          uploadId: concept.upload_id,
          sha256: concept.sha256,
          width: concept.width,
          height: concept.height,
        });
        for (const role of ['portrait', 'sheet'])
          parts.push(await this.admit(c, owner, p, role, files));
      } else {
        for (const role of [
          'background',
          'annex-background',
          'table',
          'counter',
          'shelf',
          'plant',
          'rug',
          'door-open',
          'door-closed',
          'sample-sheet',
          'npc-sheet',
        ])
          parts.push(await this.admit(c, owner, p, role, files));
      }
      const manifest: VisualPackage = {
        id: randomUUID(),
        projectId: p.id,
        kind: p.kind,
        name: p.brief.name,
        version: 1,
        provider: p.generation_mode ?? 'fixture',
        providerCalls: live?.providerCalls ?? 0,
        chargeMicros: live?.chargeMicros ?? 0,
        ...(live
          ? {
              sourceJobIds: live.jobIds,
              visualReview: {
                confirmed: true as const,
                structuralValidation: 'passed' as const,
                consistency: 'human-reviewed' as const,
              },
            }
          : {}),
        parts,
        ...(p.kind === 'character' ? { animation: characterAnimation } : {}),
      };
      await c.query(
        'INSERT INTO visual_package_versions(id,project_id,owner_id,kind,manifest,plan,checksum) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          manifest.id,
          id,
          owner,
          p.kind,
          JSON.stringify(manifest),
          JSON.stringify(p.plan),
          digest({ manifest, plan: p.plan }),
        ],
      );
      if (p.preview_state && p.plan) {
        p.preview_state.artBindings = locationBindings(manifest, p.plan).map((b) => {
          const part = parts.find((part) => part.revisionId === b.revisionId)!;
          return {
            ...b,
            sha256: part.sha256,
            mime: 'image/webp',
            width: part.width,
            height: part.height,
          };
        });
        const sample = parts.find((part) => part.role === 'sample-sheet')!;
        p.preview_state.artBindings.push({
          slot: `entity:${previewActor}:sprite`,
          revisionId: sample.revisionId,
          sha256: sample.sha256,
          mime: 'image/webp',
          width: sample.width,
          height: sample.height,
        });
        p.preview_state.entities[previewActor].characterAnimation = characterAnimation;
        p.preview_state.entities.alchemist.characterAnimation = characterAnimation;
      }
      await c.query(
        "UPDATE visual_authoring_projects SET status='ready',revision=revision+1,preview_state=$2,updated_at=now() WHERE id=$1",
        [id, JSON.stringify(p.preview_state)],
      );
      return manifest;
    });
  }
  async cancel(owner: string, id: string, input: unknown) {
    const b = visualMutationSchema.parse(input);
    return this.mutate(owner, b.operationId, { action: 'cancel', id, ...b }, async (c) => {
      const p = await this.own(c, owner, id, b.expectedRevision);
      if (p.status === 'ready') fail(409, 'STATE_CONFLICT', 'STATE_CONFLICT');
      await c.query(
        "UPDATE visual_authoring_projects SET status='cancelled',revision=revision+1,preview_state=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
      await c.query(
        `UPDATE image_generation_jobs SET cancel_requested=true,updated_at=now() WHERE id IN (SELECT job_id FROM visual_authoring_stage_items WHERE project_id=$1) AND status IN ('queued','dispatched','unknown','generated')`,
        [id],
      );
      return p.generation_mode === 'external'
        ? { cancelled: true, billingMayRemainHeld: true }
        : { cancelled: true, providerCalls: 0, chargeMicros: 0 };
    });
  }
  async edit(owner: string, id: string, input: unknown) {
    const b = visualLayerEditSchema.parse(input);
    return this.mutate(owner, b.operationId, { action: 'edit', id, ...b }, async (c) => {
      const p = await this.own(c, owner, id, b.expectedRevision);
      if (p.kind !== 'location' || p.status !== 'concept' || !p.plan)
        fail(409, 'STATE_CONFLICT', 'STATE_CONFLICT');
      await this.fresh(c, owner, p);
      const map = p.plan!.maps.find((m) => m.id === b.mapId),
        layer = map?.composition?.layers.find((l) => l.id === b.layerId);
      if (!map || !layer) return fail(404, 'NOT_FOUND', 'NOT_FOUND');
      if (layer.solid)
        map.blocked = map.blocked.filter(
          (point) =>
            !(
              point.x >= layer.x &&
              point.x < layer.x + layer.width &&
              point.y >= layer.y &&
              point.y < layer.y + layer.height
            ),
        );
      Object.assign(layer, b.point, { visual: b.visual, solid: b.visual !== 'rug' });
      if (layer.solid)
        for (let y = layer.y; y < layer.y + layer.height; y++)
          for (let x = layer.x; x < layer.x + layer.width; x++) {
            if (map.blocked.some((p) => p.x === x && p.y === y))
              fail(400, 'INVALID_MAP', 'INVALID_MAP');
            map.blocked.push({ x, y });
          }
      const compiled = compilePlayableDraft(p.plan);
      if (!compiled.playable) fail(400, 'INVALID_MAP', compiled.errors.join(';'));
      p.preview_state = createAuthorSandbox(compiled.playable!);
      p.revision++;
      await c.query(
        'UPDATE visual_authoring_projects SET plan=$2,preview_state=$3,revision=$4,updated_at=now() WHERE id=$1',
        [id, JSON.stringify(p.plan), JSON.stringify(p.preview_state), p.revision],
      );
      return this.view(p);
    });
  }
  async preview(owner: string, id: string, input: unknown) {
    const b = visualMutationSchema
      .extend({
        action: z.discriminatedUnion('kind', [
          z
            .object({
              kind: z.literal('move_to'),
              target: z
                .object({ x: z.number().int().min(0).max(31), y: z.number().int().min(0).max(31) })
                .strict(),
            })
            .strict(),
          z
            .object({
              kind: z.enum(['open', 'close', 'transition', 'inspect', 'pick_up']),
              targetId: z.string().regex(/^[\w-]{1,100}$/),
            })
            .strict(),
        ]),
      })
      .strict()
      .parse(input);
    return this.mutate(owner, b.operationId, { operation: 'preview', id, ...b }, async (c) => {
      const p = await this.own(c, owner, id, b.expectedRevision);
      if (!p.preview_state || p.status === 'cancelled')
        fail(409, 'STATE_CONFLICT', 'STATE_CONFLICT');
      const before = p.preview_state!,
        result = applyAction(before, previewActor, b.action);
      if (result.error) fail(409, result.error, result.error);
      // Same authoritative core; simulation is isolated from the saved/shared campaign.
      let state = result.state;
      const frames = [projectState(state, previewActor)];
      for (let step = 0; step < 256 && state.entities[previewActor].path?.length; step++) {
        state = tick(state, 1).state;
        if (state.tick % 2 === 0 && frames.length < 128)
          frames.push(projectState(state, previewActor));
      }
      state = advanceObjectives(state, [previewActor]).state;
      p.preview_state = state;
      p.revision++;
      await c.query(
        'UPDATE visual_authoring_projects SET preview_state=$2,revision=$3 WHERE id=$1',
        [id, JSON.stringify(state), p.revision],
      );
      return { ...this.view(p), frames };
    });
  }
  async packages(owner: string) {
    const rows = await this.db.query(
      'SELECT manifest FROM visual_package_versions WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',
      [owner],
    );
    const allIds = [
      ...new Set(rows.flatMap((r) => (r.manifest as VisualPackage).parts.map((p) => p.revisionId))),
    ];
    const unavailable = new Set();
    for (let start = 0; start < allIds.length; start += 128)
      for (const id of await this.assets.unavailableRevisions(allIds.slice(start, start + 128)))
        unavailable.add(id);
    return rows.map((r) => ({
      ...r.manifest,
      unavailable: (r.manifest as VisualPackage).parts.some((p) => unavailable.has(p.revisionId)),
    }));
  }
  async equip(owner: string, id: string, input: unknown) {
    const b = z
      .object({
        operationId: z.uuid(),
        heroId: z.uuid().optional(),
        createTarget: z.boolean().default(false),
        targetType: z.enum(['hero', 'npc']).default('hero'),
      })
      .strict()
      .refine((v) => Boolean(v.heroId) !== v.createTarget)
      .parse(input);
    return this.mutate(owner, b.operationId, { action: 'equip', id, ...b }, async (c) => {
      const { manifest } = await ownedCharacterPackage(c, owner, z.uuid().parse(id));
      const table = b.targetType === 'npc' ? 'npcs' : 'heroes';
      const targetId = b.heroId ?? randomUUID();
      if (b.createTarget) {
        const count = (
          await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1`, [owner])
        ).rows[0];
        if (count.n >= 100) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
        const data = (b.targetType === 'npc' ? npcSchema : heroSchema).parse({
          name: manifest.name,
          characterPackageVersionId: id,
          portraitAssetId: manifest.parts.find((p) => p.role === 'portrait')!.uploadId,
        });
        await c.query(`INSERT INTO ${table}(id,owner_id,data) VALUES($1,$2,$3)`, [
          targetId,
          owner,
          JSON.stringify(data),
        ]);
      }
      const hero = (
        await c.query(`SELECT id FROM ${table} WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [
          targetId,
          owner,
        ])
      ).rows[0];
      if (!hero) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      await c.query(
        `UPDATE ${table} SET ${table === 'npcs' ? 'edit_revision=edit_revision+1,' : ''}data=jsonb_set(jsonb_set(data,'{characterPackageVersionId}',$3::jsonb),'{portraitAssetId}',$4::jsonb),updated_at=now() WHERE id=$1 AND owner_id=$2`,
        [
          targetId,
          owner,
          JSON.stringify(id),
          JSON.stringify(manifest.parts.find((p) => p.role === 'portrait')!.uploadId),
        ],
      );
      return {
        equipped: true,
        targetId,
        targetType: b.targetType,
        packageVersionId: id,
        providerCalls: 0,
        chargeMicros: 0,
      };
    });
  }
  async apply(owner: string, id: string, input: unknown) {
    const b = z
      .object({
        operationId: z.uuid(),
        adventureId: z.uuid(),
        expectedSourceHash: z.string().length(64),
        replaceDraft: z.literal(true),
      })
      .strict()
      .parse(input);
    return this.mutate(owner, b.operationId, { action: 'apply', id, ...b }, async (c) => {
      const source = await this.source(c, owner, b.adventureId);
      if (source.hash !== b.expectedSourceHash) fail(409, 'STALE_STATE', 'STALE_STATE');
      const row = (
        await c.query(
          "SELECT * FROM visual_package_versions WHERE id=$1 AND owner_id=$2 AND kind='location' FOR SHARE",
          [z.uuid().parse(id), owner],
        )
      ).rows[0];
      if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const manifest = row.manifest as VisualPackage,
        plan = structuredClone(row.plan) as AuthoredGameDraft;
      if (digest({ manifest, plan }) !== row.checksum)
        fail(409, 'ASSET_INTEGRITY_FAILED', 'ASSET_INTEGRITY_FAILED');
      const project = await this.own(c, owner, String(row.project_id));
      if (
        project.adventure_id === b.adventureId &&
        project.source_hash !== source.hash &&
        project.last_applied_source_hash !== source.hash
      )
        fail(409, 'STALE_STATE', 'STALE_STATE');
      for (const part of manifest.parts) await this.assets.revision(owner, part.revisionId);
      // A reusable room never changes the destination author's pinned rule authority.
      plan.turnRules = turnRulesSchema.parse(source.gameDraft?.turnRules ?? {});
      plan.narrativeConstraints = narrativeConstraintsSchema.parse(
        source.gameDraft?.narrativeConstraints ?? {},
      );
      if (source.gameDraft?.supportingNpcPolicy)
        plan.supportingNpcPolicy = supportingNpcPolicySchema.parse(
          source.gameDraft.supportingNpcPolicy,
        );
      else delete plan.supportingNpcPolicy;
      plan.roundPolicy = authoredGameDraftSchema.shape.roundPolicy.parse(
        source.gameDraft?.roundPolicy ?? { maxRounds: 5, planningMs: 30000 },
      );
      const destinationConstraints = plan.narrativeConstraints!;
      if (
        plan.maps.length > destinationConstraints.maxScenes ||
        plan.npcs.some((n) =>
          destinationConstraints.forbiddenRoles.some((role) =>
            (n.publicProfile?.role ?? n.personality?.role ?? '')
              .toLocaleLowerCase()
              .includes(role.toLocaleLowerCase()),
          ),
        )
      )
        fail(409, 'STORY_RULE_CONFLICT', 'STORY_RULE_CONFLICT');
      const validated = compilePlayableDraft(plan);
      if (!validated.playable) fail(409, 'INVALID_MAP', 'INVALID_MAP');
      const bindings = locationBindings(manifest, plan);
      await c.query(
        'INSERT INTO adventure_game_drafts(adventure_id,revision,draft) VALUES($1,1,$2) ON CONFLICT(adventure_id) DO UPDATE SET revision=adventure_game_drafts.revision+1,draft=EXCLUDED.draft,updated_at=now()',
        [b.adventureId, JSON.stringify(plan)],
      );
      await c.query(
        'INSERT INTO art_story_asset_drafts(adventure_id,revision,bindings) VALUES($1,1,$2) ON CONFLICT(adventure_id) DO UPDATE SET revision=art_story_asset_drafts.revision+1,bindings=EXCLUDED.bindings,updated_at=now()',
        [b.adventureId, JSON.stringify(bindings)],
      );
      await c.query(
        "UPDATE adventures SET status='draft',submitted_game_version_id=NULL,updated_at=now() WHERE id=$1",
        [b.adventureId],
      );
      const appliedSource = await this.source(c, owner, b.adventureId);
      await c.query(
        'UPDATE visual_authoring_projects SET last_applied_source_hash=$2 WHERE id=$1 AND adventure_id=$3',
        [project.id, appliedSource.hash, b.adventureId],
      );
      return { applied: true, packageVersionId: id, providerCalls: 0, chargeMicros: 0 };
    });
  }
  async sourceHash(owner: string, adventureId: string) {
    return this.db.tx(async (c) => ({
      sourceHash: (await this.source(c, owner, z.uuid().parse(adventureId))).hash,
    }));
  }
}
function locationBindings(manifest: VisualPackage, plan: AuthoredGameDraft) {
  const bindings = [
    {
      slot: 'map:atelier:background',
      revisionId: manifest.parts.find((p) => p.role === 'background')!.revisionId,
    },
    {
      slot: 'map:annex:background',
      revisionId: manifest.parts.find((p) => p.role === 'annex-background')!.revisionId,
    },
  ];
  for (const m of plan.maps)
    for (const l of m.composition?.layers ?? [])
      bindings.push({
        slot: `map:${m.id}:layer:${l.id}`,
        revisionId: manifest.parts.find((p) => p.role === l.visual)!.revisionId,
      });
  for (const variant of ['open', 'closed'])
    bindings.push({
      slot: `entity:atelier-door:object:${variant}`,
      revisionId: manifest.parts.find((p) => p.role === `door-${variant}`)!.revisionId,
    });
  const quest = manifest.parts.find((part) => part.role === 'quest-item');
  if (quest)
    bindings.push({ slot: 'entity:rain-journal:object:default', revisionId: quest.revisionId });
  bindings.push({
    slot: 'entity:alchemist:sprite',
    revisionId: manifest.parts.find((p) => p.role === 'npc-sheet')!.revisionId,
  });
  return bindings;
}
