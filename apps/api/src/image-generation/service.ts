import { resolveOwnerImageProfile } from '../generation/config';
import {
  quoteSparks,
  reserveSparks,
  settleReservationSparks,
  sparksEnabled,
  sparkTariff,
  sparkQuoteView,
} from '../generation/sparks-hooks';
import {
  estimateImageRequest,
  imagePricingProfileSnapshot,
  type ImageReserveSnapshot,
  type ImagePricingProfileSnapshot,
} from '../generation/estimates';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { Db } from '../db';
import { imageFramingMatchesProfile, type GameState } from '@dreamwalk/contracts';
import { prepareSceneMedia } from '../game/media-preparation';
import { sourceAccessSql } from '../game/source-access';
import { config } from '../config';
import { fail } from '../errors';
import { ImageProviderFailure, normalizeSafeImageDiagnostic } from './error-diagnostics';
import { recoverModelRejectionTx } from './recovery';
import { AssetReuseService } from '../assets/reuse.service';
import { normalizeRaster, lockRasterQuota, MAX_RASTER_BYTES } from '../assets/raster';
import { admitGeneratedRaster } from '../assets/generated-admission';
import {
  generationRequestSchema,
  defaultImagePolicy,
  type ImagePolicy,
  type GenerationRequest,
  type AuthoringContext,
} from './contracts';
import {
  FixtureImageProvider,
  type ImageProvider,
  type ImageReference,
  type ImageResult,
} from './provider';
import { createImageRuntime, createOwnerImageRuntime, type ImageCapabilities } from './config';
import { readGenerationConfig } from '../generation/config';
import {
  prepareStudioLocationTx,
  authorizeStudioLocationTx,
  bindStudioLocationTx,
} from './studio-location';
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
  adventure_id: string | null;
  operation_id: string;
  quote_id: string;
  request_hash: string;
  input: GenerationRequest;
  reference_hashes: Record<string, string>;
  mode: 'mock' | 'external';
  cost_basis: 'legacy_unknown' | 'fixture' | 'verified_bound' | 'approved_estimate';
  estimated_total_micros: string | null;
  estimate_snapshot: ImageReserveSnapshot | null;
  pricing_profile_snapshot: ImagePricingProfileSnapshot | null;
  generation_policy_revision: number | null;
  generation_policy_hash: string | null;
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
  safe_diagnostic: unknown;
  created_at: Date;
}
export class ImageGenerationEngine {
  async recoverModelRejection(actorId: string, id: string, body: unknown) {
    return this.db.tx((c) => recoverModelRejectionTx(c, actorId, id, body, this.policy));
  }
  async modelRejectionRecovery(actorId: string, id: string) {
    z.uuid().parse(id);
    return this.db.tx(async (c) => {
      const peek = (
        await c.query<Job>(
          'SELECT *,(SELECT status FROM spark_holds WHERE id=image_generation_jobs.spark_quote_id) AS spark_status,(SELECT reserved_subunits FROM spark_holds WHERE id=image_generation_jobs.spark_quote_id) AS spark_reserved_subunits,(SELECT captured_subunits FROM spark_holds WHERE id=image_generation_jobs.spark_quote_id) AS spark_captured_subunits FROM image_generation_jobs WHERE id=$1 AND actor_id=$2',
          [id, actorId],
        )
      ).rows[0];
      if (!peek) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      await this.lockBudget(c, peek);
      await c.query('SELECT id FROM image_generation_jobs WHERE id=$1 FOR UPDATE', [id]);
      const row = (
        await c.query('SELECT actual_micros FROM image_generation_recoveries WHERE job_id=$1', [id])
      ).rows[0];
      return {
        status: row ? 'recovered' : 'not_recovered',
        ...(row ? { actualMicros: Number(row.actual_micros) } : {}),
        automaticRetry: false,
      };
    });
  }
  async prepareStudioLocation(actorId: string, body: unknown) {
    return this.db.tx((c) => prepareStudioLocationTx(c, this.assets, actorId, body));
  }
  async bindStudioLocation(actorId: string, body: unknown) {
    return this.db.tx((c) => bindStudioLocationTx(c, this.assets, actorId, body));
  }

  private authoringValidator?: (
    c: PoolClient,
    owner: string,
    context: AuthoringContext,
    input: GenerationRequest,
  ) => Promise<void>;
  setAuthoringValidator(
    validator: (
      c: PoolClient,
      owner: string,
      context: AuthoringContext,
      input: GenerationRequest,
    ) => Promise<void>,
  ) {
    this.authoringValidator = validator;
  }

  private liveAuthorizer?: (
    c: PoolClient,
    owner: string,
    sessionId: string | undefined,
    input: GenerationRequest,
  ) => Promise<ImagePolicy>;
  setLiveAuthorizer(
    authorizer: (
      c: PoolClient,
      owner: string,
      sessionId: string | undefined,
      input: GenerationRequest,
    ) => Promise<ImagePolicy>,
  ) {
    this.liveAuthorizer = authorizer;
  }
  private runtimeStateReader?: (
    campaignId: string,
  ) => { state: GameState; dbRevision: number } | undefined;
  attachRuntimeStateReader(
    reader: (campaignId: string) => { state: GameState; dbRevision: number } | undefined,
  ) {
    this.runtimeStateReader = reader;
  }
  private async authorizeCampaign(
    c: PoolClient,
    actorId: string,
    input: GenerationRequest,
    legacyFraming = false,
  ) {
    const context = input.campaignContext!;
    // Match source mutation/erasure lock order before campaign/member locks.
    await c.query(
      `SELECT u.id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id
      JOIN adventures a ON a.id=v.adventure_id JOIN users u ON u.id=a.owner_id
      WHERE c.id=$1 FOR SHARE OF u`,
      [context.campaignId],
    );
    await c.query(
      `SELECT a.id FROM game_campaigns c JOIN game_playable_versions v ON v.id=c.source_version_id
      JOIN adventures a ON a.id=v.adventure_id WHERE c.id=$1 FOR SHARE OF a`,
      [context.campaignId],
    );
    await c.query(
      `SELECT i.id FROM adventure_invitations i JOIN game_playable_versions v ON v.adventure_id=i.adventure_id
      JOIN game_campaigns c ON c.source_version_id=v.id WHERE c.id=$1 AND i.recipient_id=$2 FOR SHARE OF i`,
      [context.campaignId, actorId],
    );
    const row = (
      await c.query(
        `SELECT c.state,c.revision,c.source_version_id,m.actor_id,v.adventure_id
       FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id
       JOIN game_playable_versions v ON v.id=c.source_version_id
       WHERE c.id=$1 AND c.owner_id=$2 AND m.user_id=$2 AND m.status='accepted'
       AND c.status='active' AND ${sourceAccessSql('$2')}
       FOR SHARE OF c,m,v`,
        [context.campaignId, actorId],
      )
    ).rows[0];
    if (!row || row.adventure_id !== input.adventureId) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const hot = this.runtimeStateReader?.(context.campaignId);
    // A retained cache may predate privacy erasure or another authoritative writer.
    // Only matching persisted revisions may contribute uncheckpointed live movement.
    const state =
      hot && hot.dbRevision === Number(row.revision) ? hot.state : (row.state as GameState);
    if ((state.narrativeCanon?.revision ?? 0) !== context.expectedCanonRevision)
      fail(409, 'MEDIA_CONTEXT_STALE', 'MEDIA_CONTEXT_STALE');
    const prepared = prepareSceneMedia(
      state,
      row.actor_id,
      row.source_version_id,
      {
        kind: context.kind,
        ...(context.entityId ? { entityId: context.entityId } : {}),
      },
      legacyFraming ? 0 : 1,
    );
    const title = (prepared.grounding.subject?.label ?? prepared.grounding.map.label).slice(0, 120);
    if (
      input.framingVersion !== prepared.spec.framingVersion ||
      hash(input.imageFraming ?? null) !== hash(prepared.spec.imageFraming ?? null) ||
      prepared.groundingHash !== context.groundingHash ||
      input.prompt !== prepared.prompt ||
      input.title !== title ||
      input.kind !== prepared.spec.kind ||
      input.camera !== prepared.spec.camera ||
      input.background !== prepared.spec.background ||
      hash(input.tags) !== hash(prepared.spec.tags) ||
      hash(input.referenceRevisionIds) !== hash(prepared.spec.referenceRevisionIds)
    )
      fail(409, 'MEDIA_CONTEXT_STALE', 'MEDIA_CONTEXT_STALE');
  }

  constructor(
    protected db: Db,
    protected assets: AssetReuseService,
    protected provider: ImageProvider = new FixtureImageProvider(),
    protected policy: ImagePolicy = defaultImagePolicy,
    private capabilities?: ImageCapabilities,
  ) {}
  configuration() {
    if (
      this.capabilities &&
      this.policy.externalExpiresAt &&
      Date.parse(this.policy.externalExpiresAt) <= Date.now()
    )
      return {
        ...this.capabilities,
        externalEnabled: false,
        externalBlockReasons: [
          ...new Set([...this.capabilities.externalBlockReasons, 'EXTERNAL_CONFIGURATION_EXPIRED']),
        ],
      };
    return (
      this.capabilities ?? {
        mockAvailable: true,
        externalEnabled: this.policy.externalEnabled && this.policy.approved,
        externalBlockReasons:
          this.policy.externalEnabled && this.policy.approved
            ? []
            : ['VERIFIED_TOTAL_COST_BOUND_REQUIRED', 'EXPLICIT_PROVIDER_CONFIGURATION_REQUIRED'],
        verifiedUpperMicros: this.policy.verifiedUpperMicros,
        approvedTotalMicros: this.policy.totalCapMicros,
        approvedImageMicros: this.policy.imageCapMicros,
        approvedTextMicros: this.policy.textCapMicros,
      }
    );
  }
  protected async authorize(
    c: PoolClient,
    actorId: string,
    input: GenerationRequest,
    expected?: Record<string, string>,
    legacyFraming = false,
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
    if (input.studioLocationContext)
      await authorizeStudioLocationTx(c, this.assets, actorId, input, legacyFraming);
    else if (input.authoringContext) {
      const p = (
        await c.query(
          'SELECT id,adventure_id,source_hash,status FROM visual_authoring_projects WHERE id=$1 AND owner_id=$2 FOR SHARE',
          [input.authoringContext.projectId, actorId],
        )
      ).rows[0];
      if (
        !p ||
        p.status === 'cancelled' ||
        p.source_hash !== input.authoringContext.sourceHash ||
        (p.adventure_id ?? undefined) !== input.adventureId
      )
        fail(409, 'AUTHORING_CONTEXT_STALE', 'AUTHORING_CONTEXT_STALE');
      if (!this.authoringValidator)
        fail(409, 'AUTHORING_VALIDATOR_REQUIRED', 'AUTHORING_VALIDATOR_REQUIRED');
      await this.authoringValidator!(c, actorId, input.authoringContext, input);
    } else if (input.campaignContext)
      await this.authorizeCampaign(c, actorId, input, legacyFraming);
    else if (
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
    const privateRefs = input.privateReferenceAssetIds.length
      ? (
          await c.query(
            `SELECT a.id,a.sha256,a.filename,a.mime FROM assets a WHERE a.id=ANY($1::uuid[]) AND a.owner_id=$2
       AND NOT EXISTS(SELECT 1 FROM art_asset_revisions r JOIN art_asset_takedowns t ON t.revision_id=r.id WHERE r.upload_id=a.id) FOR SHARE OF a`,
            [input.privateReferenceAssetIds, actorId],
          )
        ).rows
      : [];
    if (privateRefs.length !== input.privateReferenceAssetIds.length)
      fail(403, 'PRIVATE_REFERENCE_FORBIDDEN', 'PRIVATE_REFERENCE_FORBIDDEN');
    refs.push(...privateRefs);
    const referenceOrder = [...input.referenceRevisionIds, ...input.privateReferenceAssetIds];
    refs.sort((a, b) => referenceOrder.indexOf(a.id) - referenceOrder.indexOf(b.id));
    const hashes = Object.fromEntries(refs.map((r) => [r.id, r.sha256]));
    if (expected && hash(hashes) !== hash(expected))
      fail(409, 'REFERENCE_CHANGED', 'REFERENCE_CHANGED');
    let livePolicy: ImagePolicy | undefined;
    if (input.mode === 'external' && this.capabilities) {
      const authorizationId = input.generationAuthorizationId ?? input.liveTestSessionId;
      if (
        !this.liveAuthorizer ||
        (!authorizationId &&
          this.policy.generationMode !== 'owner' &&
          this.policy.generationMode !== 'release')
      )
        fail(409, 'MANUAL_LIVE_SESSION_REQUIRED', 'MANUAL_LIVE_SESSION_REQUIRED');
      const authorized = await this.liveAuthorizer!(c, actorId, authorizationId, input);
      if (this.policy.generationMode === 'owner' || this.policy.generationMode === 'release') {
        if (
          authorized.generationMode !== this.policy.generationMode ||
          authorized.generationConfigFingerprint !== this.policy.generationConfigFingerprint ||
          !authorized.generationAuthorizationId ||
          (authorizationId && authorizationId !== authorized.generationAuthorizationId)
        )
          fail(409, 'GENERATION_AUTHORIZATION_MISMATCH', 'GENERATION_AUTHORIZATION_MISMATCH');
        // Pin the explicit persisted claim, including when the caller omitted its convenience alias.
        input.generationAuthorizationId = authorized.generationAuthorizationId;
      }
      livePolicy = {
        ...authorized,
        verifiedUpperMicros: this.policy.verifiedUpperMicros,
        costBasis: this.policy.costBasis,
        estimatedTotalMicros: this.policy.estimatedTotalMicros,
        operationalReserveMicros: this.policy.operationalReserveMicros,
        totalCapMicros: Math.min(authorized.totalCapMicros, this.policy.totalCapMicros),
        imageCapMicros: Math.min(authorized.imageCapMicros, this.policy.imageCapMicros),
        textCapMicros: Math.min(authorized.textCapMicros, this.policy.textCapMicros),
      };
    }
    return { hashes, refs, livePolicy };
  }
  private planning(input: GenerationRequest) {
    const base = this.policy.ownerImageProfile;
    if (
      input.mode !== 'external' ||
      (this.policy.generationMode !== 'owner' && this.policy.generationMode !== 'release') ||
      !base
    )
      return undefined;
    const p = resolveOwnerImageProfile(base, input.imageFraming);
    const references = input.referenceRevisionIds.length + input.privateReferenceAssetIds.length;
    if (references > p.maxReferenceImages)
      fail(409, 'IMAGE_REFERENCE_ESTIMATE_UNAVAILABLE', 'IMAGE_REFERENCE_ESTIMATE_UNAVAILABLE');
    if (Buffer.byteLength(input.prompt, 'utf8') > p.maxPromptUtf8Bytes)
      fail(413, 'GENERATION_INPUT_TOO_LARGE', 'GENERATION_INPUT_TOO_LARGE');
    return {
      estimateSnapshot: estimateImageRequest(input.prompt, references, p, this.provider.id),
      pricingProfileSnapshot: imagePricingProfileSnapshot(p),
    };
  }
  private reservationMicros(input: GenerationRequest) {
    return (
      this.planning(input)?.estimateSnapshot.reserveMicros ??
      (input.mode === 'mock'
        ? this.policy.generationMode === 'owner' || this.policy.generationMode === 'release'
          ? 0
          : this.policy.mockUpperMicros
        : this.policy.costBasis === 'approved_estimate'
          ? this.policy.operationalReserveMicros!
          : this.policy.verifiedUpperMicros!)
    );
  }
  private assertPolicyRevision(
    row: {
      input: unknown;
      generation_policy_revision?: number | null;
      generation_policy_hash?: string | null;
    },
    policy?: ImagePolicy,
  ) {
    if (
      (this.policy.generationMode !== 'owner' && this.policy.generationMode !== 'release') ||
      generationRequestSchema.parse(row.input).mode !== 'external' ||
      !this.capabilities
    )
      return;
    if (
      !policy ||
      !Number.isSafeInteger(policy.generationPolicyRevision) ||
      !policy.generationPolicyHash ||
      row.generation_policy_revision !== policy.generationPolicyRevision ||
      row.generation_policy_hash !== policy.generationPolicyHash
    )
      fail(409, 'GENERATION_POLICY_STALE', 'GENERATION_POLICY_STALE');
  }
  private liveGate(input: GenerationRequest) {
    if (input.mode !== 'external') return;
    const approvedSize =
      this.policy.ownerImageProfile?.size ?? this.capabilities?.requestProfile.size ?? '1024x1024';
    if (
      !imageFramingMatchesProfile(
        input.imageFraming,
        approvedSize,
        this.policy.ownerImageProfile?.framingPolicy,
      )
    )
      fail(409, 'IMAGE_SIZE_POLICY_REVIEW_REQUIRED', 'IMAGE_SIZE_POLICY_REVIEW_REQUIRED');
    const reserve = this.reservationMicros(input);
    if (
      !this.policy.externalEnabled ||
      !this.policy.approved ||
      (!!this.policy.externalExpiresAt &&
        Date.parse(this.policy.externalExpiresAt) <= Date.now()) ||
      !Number.isSafeInteger(reserve) ||
      reserve <= 0 ||
      reserve >
        (this.policy.generationMode === 'owner' || this.policy.generationMode === 'release'
          ? this.policy.imageCapMicros
          : 1000000) ||
      (this.policy.costBasis !== 'approved_estimate' && this.policy.verifiedUpperMicros === null)
    )
      fail(409, 'LIVE_COST_BOUND_REQUIRED', 'LIVE_COST_BOUND_REQUIRED');
    if (
      this.policy.costBasis === 'approved_estimate' &&
      (input.referenceRevisionIds.length || input.privateReferenceAssetIds.length) &&
      ((this.policy.generationMode !== 'owner' && this.policy.generationMode !== 'release') ||
        input.referenceRevisionIds.length + input.privateReferenceAssetIds.length >
          (this.capabilities?.requestProfile.maxReferenceImages ?? 0))
    )
      fail(409, 'IMAGE_REFERENCE_ESTIMATE_UNAVAILABLE', 'IMAGE_REFERENCE_ESTIMATE_UNAVAILABLE');
  }
  private assertQuotedProvider(row: {
    input: unknown;
    reference_hashes: unknown;
    policy_version: string;
    upper_micros: unknown;
    request_hash: string;
    cost_basis?: string;
    estimated_total_micros?: unknown;
    estimate_snapshot?: ImageReserveSnapshot | null;
    pricing_profile_snapshot?: ImagePricingProfileSnapshot | null;
    generation_policy_revision?: number | null;
    generation_policy_hash?: string | null;
  }) {
    const input = generationRequestSchema.parse(row.input),
      planned = this.planning(input);
    if (
      (this.policy.generationMode === 'owner' || this.policy.generationMode === 'release') &&
      input.mode === 'external'
    ) {
      if (
        row.cost_basis !== 'approved_estimate' ||
        Number(row.estimated_total_micros) !==
          (planned?.estimateSnapshot.estimatedTotalMicros ?? this.policy.estimatedTotalMicros) ||
        Number(row.upper_micros) !== this.reservationMicros(input)
      )
        fail(409, 'QUOTE_PROVIDER_CHANGED', 'QUOTE_PROVIDER_CHANGED');
      if (row.estimate_snapshot || row.pricing_profile_snapshot) {
        if (
          !planned ||
          hash(row.estimate_snapshot) !== hash(planned.estimateSnapshot) ||
          hash(row.pricing_profile_snapshot) !== hash(planned.pricingProfileSnapshot)
        )
          fail(409, 'QUOTE_PROVIDER_CHANGED', 'QUOTE_PROVIDER_CHANGED');
      } else if (this.policy.ownerImageProfile?.estimation)
        fail(409, 'QUOTE_PROVIDER_CHANGED', 'QUOTE_PROVIDER_CHANGED');
    }
    const expected = hash({
      input: row.input,
      refs: row.reference_hashes,
      policy: this.policy.version,
      provider: this.provider.id,
      upper: Number(row.upper_micros),
      ...(row.estimate_snapshot
        ? {
            estimateSnapshotHash: row.estimate_snapshot.fingerprint,
            pricingProfileHash: row.pricing_profile_snapshot?.fingerprint,
          }
        : {}),
      ...(row.generation_policy_revision != null
        ? { policyRevision: row.generation_policy_revision, policyHash: row.generation_policy_hash }
        : {}),
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
      const currentAuthorization = await this.authorize(c, actorId, input, authorization.hashes);
      const n = (
        await c.query(
          "SELECT count(*)::int AS n FROM image_generation_quotes WHERE actor_id=$1 AND created_at>now()-interval '1 minute'",
          [actorId],
        )
      ).rows[0].n;
      if (n >= 30) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
      const id = randomUUID(),
        expiresAt = new Date(Date.now() + this.policy.quoteTtlMs),
        upper = this.reservationMicros(input),
        costBasis = input.mode === 'mock' ? 'fixture' : (this.policy.costBasis ?? 'verified_bound'),
        planned = this.planning(input),
        policyRevision = currentAuthorization.livePolicy?.generationPolicyRevision,
        policyHash = currentAuthorization.livePolicy?.generationPolicyHash;
      if (
        (this.policy.generationMode === 'owner' || this.policy.generationMode === 'release') &&
        input.mode === 'external' &&
        this.capabilities &&
        (!Number.isSafeInteger(policyRevision) || !policyHash)
      )
        fail(409, 'GENERATION_POLICY_STALE', 'GENERATION_POLICY_STALE');
      const requestHash = hash({
        input,
        refs: authorization.hashes,
        policy: this.policy.version,
        provider: this.provider.id,
        upper,
        ...(planned
          ? {
              estimateSnapshotHash: planned.estimateSnapshot.fingerprint,
              pricingProfileHash: planned.pricingProfileSnapshot.fingerprint,
            }
          : {}),
        ...(policyRevision != null ? { policyRevision, policyHash } : {}),
      });
      await c.query(
        'INSERT INTO image_generation_quotes(id,actor_id,adventure_id,request_hash,input,reference_hashes,mode,policy_version,upper_micros,expires_at,cost_basis,estimated_total_micros,estimate_snapshot,pricing_profile_snapshot,generation_policy_revision,generation_policy_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
        [
          id,
          actorId,
          input.adventureId ?? null,
          requestHash,
          input,
          authorization.hashes,
          input.mode,
          this.policy.version,
          upper,
          expiresAt,
          costBasis,
          costBasis === 'approved_estimate'
            ? (planned?.estimateSnapshot.estimatedTotalMicros ?? this.policy.estimatedTotalMicros)
            : null,
          planned?.estimateSnapshot ?? null,
          planned?.pricingProfileSnapshot ?? null,
          policyRevision ?? null,
          policyHash ?? null,
        ],
      );
      let sparkQuoteId: string | null = null;
      if (
        input.mode === 'external' &&
        (this.policy.generationMode === 'release' || (await sparksEnabled(c, actorId)))
      ) {
        const profile = planned?.pricingProfileSnapshot;
        if (!profile)
          fail(409, 'SPARK_PRICING_SNAPSHOT_REQUIRED', 'SPARK_PRICING_SNAPSHOT_REQUIRED');
        sparkQuoteId = await quoteSparks(
          c,
          {
            ownerId: actorId,
            operationId: id,
            sourceKind: 'image',
            sourceId: id,
            reserveSubunits: String(upper),
            expiresAt: expiresAt.toISOString(),
            tariff: sparkTariff(
              {
                model: profile!.model,
                inputMicrosPerMillion: profile!.inputTextMicrosPerMillion,
                outputMicrosPerMillion: profile!.outputImageMicrosPerMillion,
              },
              this.provider.id,
              profile!.fingerprint,
            ),
            providerQuote: {
              quoteId: id,
              requestHash,
              pricingProfile: profile,
              estimate: planned?.estimateSnapshot,
              settlement: 'actual-image-micros',
              cachePricing: 'not-quoted',
            },
          },
          { required: this.policy.generationMode === 'release' },
        );
        await c.query('UPDATE image_generation_quotes SET spark_quote_id=$2 WHERE id=$1', [
          id,
          sparkQuoteId,
        ]);
      }
      return {
        decision: 'quote',
        quote: {
          ...(input.framingVersion
            ? { framingVersion: input.framingVersion, imageFraming: input.imageFraming ?? null }
            : {}),
          ...sparkQuoteView(sparkQuoteId, String(upper)),
          id,
          mode: input.mode,
          upperMicros: costBasis === 'approved_estimate' ? null : upper,
          costBasis,
          reserveMicros: upper,
          verifiedUpperMicros: costBasis === 'verified_bound' ? upper : null,
          ...(costBasis === 'approved_estimate'
            ? {
                estimatedTotalMicros:
                  planned?.estimateSnapshot.estimatedTotalMicros ??
                  this.policy.estimatedTotalMicros,
              }
            : {}),
          expiresAt: expiresAt.toISOString(),
          rightsAttestationRequired: true,
          ...(planned
            ? {
                ...planned,
                ...(this.policy.ownerImageProfile?.framingPolicy
                  ? {
                      basePricingProfileId: imagePricingProfileSnapshot(
                        this.policy.ownerImageProfile,
                      ).id,
                      basePricingProfileHash: imagePricingProfileSnapshot(
                        this.policy.ownerImageProfile,
                      ).fingerprint,
                    }
                  : {}),
                estimateSnapshotId: planned.estimateSnapshot.id,
                estimateSnapshotHash: planned.estimateSnapshot.fingerprint,
                pricingProfileId: planned.pricingProfileSnapshot.id,
                pricingProfileHash: planned.pricingProfileSnapshot.fingerprint,
              }
            : {}),
          ...(policyRevision != null ? { policyRevision, policyHash } : {}),
          ...(input.mode === 'external' &&
          (this.policy.generationMode === 'owner' || this.policy.generationMode === 'release')
            ? {
                generationMode: this.policy.generationMode,
                estimateRiskConsentRequired: true,
                providerEnforcesQuotedCap: false,
              }
            : {}),
        },
        matches,
      };
    });
  }
  private dto(j: Job) {
    return {
      id: j.id,
      ...(j.spark_quote_id
        ? {
            sparkHoldId: j.spark_quote_id,
            sparkStatus: j.spark_status,
            sparkReservedSubunits: j.spark_reserved_subunits,
            sparkCapturedSubunits: j.spark_captured_subunits,
          }
        : {}),
      operationId: j.operation_id,
      status: j.status,
      mode: j.mode,
      studioLocationId: j.input.studioLocationContext?.locationId,
      studioSourceHash: j.input.studioLocationContext?.sourceHash,
      costBasis: j.cost_basis,
      estimateSnapshot: j.estimate_snapshot ?? undefined,
      pricingProfileSnapshot: j.pricing_profile_snapshot ?? undefined,
      estimateSnapshotId: j.estimate_snapshot?.id,
      estimateSnapshotHash: j.estimate_snapshot?.fingerprint,
      pricingProfileId: j.pricing_profile_snapshot?.id,
      pricingProfileHash: j.pricing_profile_snapshot?.fingerprint,
      policyRevision: j.generation_policy_revision ?? undefined,
      policyHash: j.generation_policy_hash ?? undefined,
      reserveMicros: Number(j.upper_micros),
      verifiedUpperMicros: j.cost_basis === 'verified_bound' ? Number(j.upper_micros) : null,
      estimatedTotalMicros:
        j.estimated_total_micros === null ? undefined : Number(j.estimated_total_micros),
      revisionId: j.admitted_revision_id ?? undefined,
      errorCode: j.error_code ?? undefined,
      diagnostic: normalizeSafeImageDiagnostic(j.safe_diagnostic),
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
      .object({
        quoteId: z.uuid(),
        operationId: z.uuid(),
        consent: z.literal(true),
        estimateRiskConsent: z.literal(true).optional(),
      })
      .strict()
      .parse(body);
    return this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `art-owner:${actorId}`,
      ]);
      // Read-only receipt recovery never creates a reservation or revives an old policy.
      if (
        !(
          await c.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [
            actorId,
          ])
        ).rowCount
      )
        fail(401, 'UNAUTHORIZED', 'UNAUTHORIZED');
      const previous = (
        await c.query<Job>(
          'SELECT * FROM image_generation_jobs WHERE actor_id=$1 AND operation_id=$2',
          [actorId, b.operationId],
        )
      ).rows[0];
      if (previous) {
        if (previous.quote_id !== b.quoteId)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        if (
          previous.mode === 'external' &&
          previous.cost_basis === 'approved_estimate' &&
          (previous.input.generationAuthorizationId ||
            this.policy.generationMode === 'owner' ||
            this.policy.generationMode === 'release') &&
          b.estimateRiskConsent !== true
        )
          fail(409, 'IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED', 'IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED');
        return this.dto(previous);
      }

      const q = (
        await c.query('SELECT * FROM image_generation_quotes WHERE id=$1 AND actor_id=$2', [
          b.quoteId,
          actorId,
        ])
      ).rows[0];
      if (!q) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const input = generationRequestSchema.parse(q.input);
      // A separate informed action is mandatory even on idempotent replay; ordinary consent is not estimate consent.
      if (
        input.mode === 'external' &&
        (this.policy.generationMode === 'owner' || this.policy.generationMode === 'release') &&
        (q.cost_basis !== 'approved_estimate' || b.estimateRiskConsent !== true)
      )
        fail(409, 'IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED', 'IMAGE_ESTIMATE_RISK_CONSENT_REQUIRED');
      const authorization = await this.authorize(
        c,
        actorId,
        input,
        q.reference_hashes,
        input.framingVersion === undefined,
      );
      this.liveGate(input);
      this.assertQuotedProvider(q);
      this.assertPolicyRevision(q, authorization.livePolicy);
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
          input.mode === 'mock' &&
            (this.policy.generationMode === 'owner' || this.policy.generationMode === 'release')
            ? {
                ...defaultImagePolicy,
                version: 'image-fixtures-nonfinancial-v1',
                scopeId: 'image-fixtures-nonfinancial-v1',
                totalCapMicros: 0,
                imageCapMicros: 0,
                textCapMicros: 0,
                mockUpperMicros: 0,
              }
            : input.mode === 'external' &&
                (this.policy.generationMode === 'owner' || this.policy.generationMode === 'release')
              ? {
                  ...(authorization.livePolicy ?? this.policy),
                  estimatedTotalMicros: Number(q.estimated_total_micros),
                  operationalReserveMicros: Number(q.upper_micros),
                }
              : (authorization.livePolicy ?? this.policy),
          actorId,
          'image',
          id,
          Number(q.upper_micros),
          input.mode === 'mock',
        );
      if (input.mode === 'external')
        await reserveSparks(c, actorId, q.spark_quote_id, reservation, {
          required: this.policy.generationMode === 'release',
        });
      const job = (
        await c.query<Job>(
          "INSERT INTO image_generation_jobs(id,actor_id,adventure_id,operation_id,quote_id,request_hash,input,reference_hashes,mode,policy_version,status,reservation_id,upper_micros,expires_at,upload_id,family_id,revision_id,cost_basis,estimated_total_micros,estimate_snapshot,pricing_profile_snapshot,generation_policy_revision,generation_policy_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *",
          [
            id,
            actorId,
            input.adventureId ?? null,
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
            q.cost_basis,
            q.estimated_total_micros,
            q.estimate_snapshot ?? null,
            q.pricing_profile_snapshot ?? null,
            q.generation_policy_revision ?? null,
            q.generation_policy_hash ?? null,
          ],
        )
      ).rows[0];
      await c.query('UPDATE image_generation_jobs SET spark_quote_id=$2 WHERE id=$1', [
        id,
        q.spark_quote_id ?? null,
      ]);
      job.spark_quote_id = q.spark_quote_id;
      job.spark_status = q.spark_quote_id ? 'held' : undefined;
      job.spark_reserved_subunits = q.spark_quote_id ? String(q.upper_micros) : undefined;
      return this.dto(job);
    });
  }
  async get(actorId: string, id: string) {
    z.uuid().parse(id);
    const j = (
      await this.db.query<Job>(
        'SELECT *,(SELECT status FROM spark_holds WHERE id=image_generation_jobs.spark_quote_id) AS spark_status,(SELECT reserved_subunits FROM spark_holds WHERE id=image_generation_jobs.spark_quote_id) AS spark_reserved_subunits,(SELECT captured_subunits FROM spark_holds WHERE id=image_generation_jobs.spark_quote_id) AS spark_captured_subunits FROM image_generation_jobs WHERE id=$1 AND actor_id=$2',
        [id, actorId],
      )
    )[0];
    if (!j) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    return this.dto(j);
  }
  async list(actorId: string, adventureId: string, campaignId?: string) {
    z.uuid().parse(adventureId);
    if (campaignId) {
      z.uuid().parse(campaignId);
      if (
        !(
          await this.db.query(
            `SELECT c.id FROM game_campaigns c
        JOIN game_members m ON m.campaign_id=c.id JOIN game_playable_versions v ON v.id=c.source_version_id
        WHERE c.id=$1 AND c.owner_id=$2 AND m.user_id=$2 AND m.status='accepted'
        AND v.adventure_id=$3 AND c.status='active' AND ${sourceAccessSql('$2')}`,
            [campaignId, actorId, adventureId],
          )
        ).length
      )
        fail(404, 'NOT_FOUND', 'NOT_FOUND');
    } else if (
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
          `SELECT *,(SELECT status FROM spark_holds WHERE id=image_generation_jobs.spark_quote_id) AS spark_status,(SELECT reserved_subunits FROM spark_holds WHERE id=image_generation_jobs.spark_quote_id) AS spark_reserved_subunits,(SELECT captured_subunits FROM spark_holds WHERE id=image_generation_jobs.spark_quote_id) AS spark_captured_subunits FROM image_generation_jobs WHERE actor_id=$1 AND adventure_id=$2
           AND ($3::text IS NULL OR input->'campaignContext'->>'campaignId'=$3) ORDER BY created_at DESC LIMIT 50`,
          [actorId, adventureId, campaignId ?? null],
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
    // Same lock order as authorization: session -> shared scope -> image job.
    await c.query(
      'SELECT s.id FROM live_test_sessions s JOIN generation_budget_reservations r ON r.scope_id=s.scope_id WHERE r.id=$1 ORDER BY s.id FOR UPDATE OF s',
      [job.reservation_id],
    );
    await c.query(
      'SELECT id FROM generation_budget_scopes WHERE id=(SELECT scope_id FROM generation_budget_reservations WHERE id=$1) FOR UPDATE',
      [job.reservation_id],
    );
  }
  /** Durable owner stop: later receipts settle liability but never silently re-enable generation. */
  private async stopOwnerUnknown(c: PoolClient, job: Job) {
    if (job.mode !== 'external') return;
    await settleReservationSparks(c, job.reservation_id, {
      outcome: 'unknown',
      receiptId: `image:${job.id}`,
    });
    const stopped = await c.query(
      "UPDATE live_test_sessions s SET state='stopped',stop_code=COALESCE(stop_code,'IMAGE_RESULT_UNKNOWN') FROM generation_budget_reservations r WHERE r.id=$1 AND s.scope_id=r.scope_id AND s.mode='owner' RETURNING s.scope_id",
      [job.reservation_id],
    );
    if (stopped.rowCount)
      await c.query('UPDATE generation_budget_scopes SET blocked=true WHERE id=$1', [
        stopped.rows[0].scope_id,
      ]);
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
        ) {
          await this.stopOwnerUnknown(c, j);
          await c.query(
            "UPDATE image_generation_jobs SET status='unknown',error_code='DISPATCH_UNCERTAIN',updated_at=now() WHERE id=$1",
            [j.id],
          );
        } else if ((j.status === 'generated' || j.status === 'unknown') && j.cancel_requested) {
          await settleReservationSparks(c, j.reservation_id, {
            outcome: j.status === 'unknown' ? 'unknown' : 'failure_policy_pending',
            receiptId: `image:${j.id}`,
          });
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
          auth = await this.authorize(
            c,
            candidate.actor_id,
            input,
            candidate.reference_hashes,
            input.framingVersion === undefined,
          );
        this.liveGate(input);
        this.assertQuotedProvider(candidate);
        this.assertPolicyRevision(candidate, auth.livePolicy);
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
    } catch (error) {
      const diagnostic =
        error instanceof ImageProviderFailure
          ? normalizeSafeImageDiagnostic(error.diagnostic)
          : undefined;
      await this.db.tx(async (c) => {
        await this.lockBudget(c, claimed.job);
        const current = (
          await c.query(
            'SELECT status,error_code FROM image_generation_jobs WHERE id=$1 FOR UPDATE',
            [claimed.job.id],
          )
        ).rows[0];
        // Erasure/revocation may have completed while the provider was in flight.
        // Never reattach diagnostics or identifiers to erased personal data.
        if (!current || current.status !== 'dispatched' || current.error_code === 'ERASED') return;
        await this.stopOwnerUnknown(c, claimed.job);
        await c.query(
          "UPDATE image_generation_jobs SET status='unknown',error_code='DISPATCH_UNCERTAIN',safe_diagnostic=$2,provider_request_id=COALESCE($3,provider_request_id),updated_at=now() WHERE id=$1",
          [claimed.job.id, diagnostic ?? null, diagnostic?.requestId ?? null],
        );
        if (diagnostic?.requestId)
          await c.query(
            'UPDATE image_generation_attempts SET provider_request_id=$3 WHERE job_id=$1 AND dispatch_id=$2',
            [claimed.job.id, claimed.dispatchId, diagnostic.requestId],
          );
      });
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
        (await c.query('SELECT 1 FROM image_generation_recoveries WHERE job_id=$1', [id])).rowCount
      )
        fail(409, 'RECOVERED_REJECTION_RECEIPT_CONFLICT', 'RECOVERED_REJECTION_RECEIPT_CONFLICT');
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
      if (
        result.actualMicros === undefined ||
        j.status === 'unknown' ||
        (j.status === 'dispatched' &&
          j.dispatch_deadline &&
          j.dispatch_deadline.getTime() <= Date.now())
      )
        await this.stopOwnerUnknown(c, j);
      if (result.actualMicros !== undefined)
        await settleGenerationSpend(c, j.reservation_id, result.actualMicros);
      if (
        result.actualMicros === undefined ||
        j.status === 'unknown' ||
        j.cancel_requested ||
        erased ||
        result.actualMicros > Number(j.upper_micros) ||
        result.costVerifiedForSparks === false
      )
        await settleReservationSparks(c, j.reservation_id, {
          outcome:
            result.actualMicros === undefined || j.status === 'unknown'
              ? 'unknown'
              : 'failure_policy_pending',
          receiptId: `image:${id}`,
        });
      await c.query('UPDATE image_generation_jobs SET spark_cost_verified=$2 WHERE id=$1', [
        id,
        result.costVerifiedForSparks !== false && result.actualMicros !== undefined,
      ]);
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
          result.actualMicros === undefined &&
          (this.policy.generationMode === 'owner' || this.policy.generationMode === 'release')
            ? 'unknown'
            : rejected
              ? result.actualMicros === undefined
                ? 'unknown'
                : 'rejected'
              : 'generated',
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
    if (
      row.input.imageFraming &&
      (raster.width !== row.input.imageFraming.width ||
        raster.height !== row.input.imageFraming.height)
    ) {
      await this.rejectAdmission(row, 'IMAGE_FRAMING_DIMENSIONS_MISMATCH');
      return;
    }
    if (
      row.mode === 'external' &&
      (this.policy.generationMode === 'owner' || this.policy.generationMode === 'release')
    ) {
      const expected = (
        row.pricing_profile_snapshot?.size ?? this.capabilities?.requestProfile.size
      )
        ?.split('x')
        .map(Number);
      if (!expected || raster.width !== expected[0] || raster.height !== expected[1]) {
        await this.rejectAdmission(row, 'IMAGE_PROFILE_DIMENSIONS_MISMATCH');
        return;
      }
    }
    try {
      await this.db.tx(async (c) => {
        const input = generationRequestSchema.parse(row.input);
        const admissionAuthorization = await this.authorize(
          c,
          row.actor_id,
          input,
          row.reference_hashes,
          input.framingVersion === undefined,
        );
        this.assertPolicyRevision(row, admissionAuthorization.livePolicy);
        if (this.policy.generationMode === 'owner' || this.policy.generationMode === 'release') {
          this.liveGate(input);
          this.assertQuotedProvider(row);
        }
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
        const attempt = (
          await c.query('SELECT provider FROM image_generation_attempts WHERE job_id=$1', [id])
        ).rows[0];
        if (!attempt) fail(409, 'NO_PROVIDER_ATTEMPT', 'NO_PROVIDER_ATTEMPT');
        const admitted = await admitGeneratedRaster(
          c,
          this.assets,
          j,
          input,
          raster,
          String(attempt.provider),
        );
        await settleReservationSparks(c, j.reservation_id, {
          outcome: 'success',
          actualMicros: String(j.actual_micros),
          evidence: 'configured_rates',
          receiptId: `image:${id}`,
        });
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
    await this.db.tx(async (c) => {
      await this.lockBudget(c, row);
      await c.query('SELECT id FROM image_generation_jobs WHERE id=$1 FOR UPDATE', [row.id]);
      await settleReservationSparks(c, row.reservation_id, {
        outcome: 'failure_policy_pending',
        receiptId: `image:${row.id}`,
      });
      await c.query(
        "UPDATE image_generation_jobs SET status='rejected',quota_reserved_bytes=0,error_code=$2,updated_at=now() WHERE id=$1 AND status='generated'",
        [row.id, errorCode],
      );
    });
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
    const ownerConfig = readGenerationConfig(process.env);
    const runtime =
      ownerConfig.mode === 'owner' || ownerConfig.mode === 'release'
        ? createOwnerImageRuntime(ownerConfig, {
            resolveApiKey: () => process.env.OPENAI_API_KEY ?? process.env.NPC_AI_API_KEY,
          })
        : createImageRuntime(process.env, {
            resolveApiKey: () =>
              process.env.LIVE_TEST_ENABLED === 'true'
                ? process.env.NPC_AI_API_KEY
                : process.env.OPENAI_API_KEY,
          });
    super(db, assets, runtime.provider, runtime.policy, runtime.capabilities);
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
