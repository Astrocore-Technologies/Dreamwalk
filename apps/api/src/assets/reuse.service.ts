import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import {
  frozenArtBindingsSchema,
  type PlayablePackage,
  type GameState,
  type FrozenArtBinding,
} from '@dreamwalk/contracts';
import {
  validateArtBindingSlot,
  projectVisibleArtBindings,
  compilePlayableDraft,
} from '@dreamwalk/game-core';
import { Db } from '../db';
import { fail } from '../errors';
import { sourceAccessSql } from '../game/source-access';
import {
  assetSpecSchema,
  draftBindingsSchema,
  grantReuseSchema,
  registerRevisionSchema,
  type AssetBinding,
  type AssetSpec,
} from './reuse.contracts';
const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, stable(x)]),
        )
      : v;
const hash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(v)))
    .digest('hex');
interface Revision extends QueryResultRow {
  id: string;
  family_id: string;
  revision: number;
  owner_id: string;
  metadata: Record<string, unknown>;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  upload_id: string | null;
  filename?: string;
}
const baseRevision = `SELECT r.*,f.owner_id,f.archived_at,u.deleted_at,blob.filename FROM art_asset_revisions r JOIN art_asset_families f ON f.id=r.family_id JOIN users u ON u.id=f.owner_id LEFT JOIN assets blob ON blob.id=r.upload_id`;
@Injectable()
export class AssetReuseService {
  private runtimeStateReader?: (campaignId: string) => GameState | undefined;
  constructor(@Inject(Db) private db: Db) {}
  attachRuntimeStateReader(reader: (campaignId: string) => GameState | undefined) {
    this.runtimeStateReader = reader;
  }
  private dto(r: Revision, viewerId?: string | null) {
    const metadata = r.metadata as Record<string, unknown>,
      provenance = (metadata.provenance ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      owned: r.owner_id === viewerId,
      familyId: r.family_id,
      revision: r.revision,
      sha256: r.sha256,
      mime: r.mime,
      width: r.width,
      height: r.height,
      metadata: {
        ...metadata,
        provenance: {
          source: provenance.source,
          ...(provenance.provider ? { provider: provenance.provider } : {}),
        },
      },
      url: `/api/v1/asset-library/revisions/${r.id}/file`,
    };
  }
  private async active(c: PoolClient, userId: string) {
    if (
      !(await c.query('SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL', [userId])).rowCount
    )
      fail(401, 'UNAUTHORIZED', 'UNAUTHORIZED');
  }
  async lockAuthor(c: PoolClient, userId: string) {
    if (
      !(
        await c.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [userId])
      ).rowCount
    )
      fail(401, 'UNAUTHORIZED', 'UNAUTHORIZED');
  }
  private async mutate<T>(
    userId: string,
    operationId: string,
    request: unknown,
    work: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
    z.uuid().parse(operationId);
    return this.db.tx(async (c) => {
      await this.active(c, userId);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `art-owner:${userId}`,
      ]);
      await this.lockAuthor(c, userId);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `art-operation:${userId}:${operationId}`,
      ]);
      const fingerprint = hash(request),
        prior = (
          await c.query('SELECT * FROM art_asset_operations WHERE user_id=$1 AND operation_id=$2', [
            userId,
            operationId,
          ])
        ).rows[0];
      if (prior) {
        if (prior.request_hash !== fingerprint)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return prior.result as T;
      }
      const recent = (
        await c.query(
          "SELECT count(*)::int AS n FROM art_asset_operations WHERE user_id=$1 AND created_at>now()-interval '1 minute'",
          [userId],
        )
      ).rows[0];
      if (recent.n >= 60) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
      const result = await work(c);
      await c.query(
        'INSERT INTO art_asset_operations(user_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)',
        [userId, operationId, fingerprint, JSON.stringify(result)],
      );
      return result;
    });
  }
  private async reusable(c: PoolClient, userId: string, revisionId: string, lock = false) {
    if (lock) {
      const owner = (
        await c.query(
          'SELECT f.owner_id FROM art_asset_revisions r JOIN art_asset_families f ON f.id=r.family_id WHERE r.id=$1',
          [revisionId],
        )
      ).rows[0];
      if (
        !owner ||
        !(
          await c.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [
            owner.owner_id,
          ])
        ).rowCount
      )
        fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
    }
    const row = (
      await c.query<Revision>(`${baseRevision} WHERE r.id=$1 ${lock ? 'FOR SHARE OF r,f' : ''}`, [
        revisionId,
      ])
    ).rows[0];
    if (
      !row ||
      !row.upload_id ||
      row.archived_at ||
      row.deleted_at ||
      (await c.query('SELECT 1 FROM art_asset_takedowns WHERE revision_id=$1', [revisionId]))
        .rowCount
    )
      fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
    if (lock) {
      await c.query('SELECT id FROM assets WHERE id=$1 FOR SHARE', [row.upload_id]);
      if (
        (await c.query('SELECT 1 FROM art_asset_takedowns WHERE revision_id=$1', [revisionId]))
          .rowCount
      )
        fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
    }
    if (row.owner_id === userId) return { row, grantId: null };
    const grant = (
      await c.query(
        'SELECT id FROM art_asset_grants WHERE revision_id=$1 AND grantee_id=$2 AND revoked_at IS NULL FOR SHARE',
        [revisionId, userId],
      )
    ).rows[0];
    if (!grant) fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
    return { row, grantId: grant.id as string };
  }
  async register(userId: string, input: unknown) {
    const b = registerRevisionSchema.parse(input);
    return this.mutate(userId, b.operationId, { action: 'register', ...b }, (c) =>
      this.registerTx(c, userId, b),
    );
  }
  /** Internal transactional admission; callers must hold active author and art-owner quota lock. */
  async registerTx(
    c: PoolClient,
    userId: string,
    input: unknown,
    ids?: { familyId: string; revisionId: string },
  ) {
    const b = registerRevisionSchema.parse(input);
    const upload = (
      await c.query('SELECT * FROM assets WHERE id=$1 AND owner_id=$2 FOR SHARE', [
        b.uploadId,
        userId,
      ])
    ).rows[0];
    if (
      !upload ||
      (
        await c.query(
          'SELECT 1 FROM art_asset_revisions r JOIN art_asset_takedowns t ON t.revision_id=r.id WHERE r.upload_id=$1 LIMIT 1',
          [b.uploadId],
        )
      ).rowCount
    )
      fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
    const count = (
      await c.query(
        'SELECT count(*)::int AS n FROM art_asset_revisions r JOIN art_asset_families f ON f.id=r.family_id WHERE f.owner_id=$1',
        [userId],
      )
    ).rows[0];
    if (count.n >= 2000) fail(429, 'ASSET_REVISION_QUOTA', 'ASSET_REVISION_QUOTA');
    const familyId = b.familyId ?? ids?.familyId ?? randomUUID();
    let revision = 1;
    if (b.familyId) {
      const family = (
        await c.query('SELECT * FROM art_asset_families WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
          familyId,
          userId,
        ])
      ).rows[0];
      if (!family || family.archived_at) fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
      if (family.head_revision !== b.expectedFamilyRevision)
        fail(409, 'STALE_REVISION', 'STALE_REVISION');
      revision = family.head_revision + 1;
    } else
      await c.query('INSERT INTO art_asset_families(id,owner_id) VALUES($1,$2)', [
        familyId,
        userId,
      ]);
    const id = ids?.revisionId ?? randomUUID();
    await c.query(
      'INSERT INTO art_asset_revisions(id,family_id,revision,upload_id,metadata,sha256,mime,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        id,
        familyId,
        revision,
        b.uploadId,
        b.metadata,
        upload.sha256,
        upload.mime,
        upload.width,
        upload.height,
      ],
    );
    await c.query('UPDATE art_asset_families SET head_revision=$2 WHERE id=$1', [
      familyId,
      revision,
    ]);
    return this.dto(
      (await c.query<Revision>(`${baseRevision} WHERE r.id=$1`, [id])).rows[0],
      userId,
    );
  }
  async catalog(userId: string) {
    return this.db.tx(async (c) => {
      await this.active(c, userId);
      const rows = (
        await c.query<Revision>(
          `${baseRevision} WHERE r.upload_id IS NOT NULL AND f.archived_at IS NULL AND u.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM art_asset_takedowns t WHERE t.revision_id=r.id) AND (f.owner_id=$1 OR EXISTS(SELECT 1 FROM art_asset_grants g WHERE g.revision_id=r.id AND g.grantee_id=$1 AND g.revoked_at IS NULL)) ORDER BY r.created_at DESC,r.id LIMIT 200`,
          [userId],
        )
      ).rows;
      return rows.map((r) => ({ ...this.dto(r, userId), canReuse: true }));
    });
  }
  async revision(userId: string, id: string) {
    z.uuid().parse(id);
    return this.db.tx(async (c) => {
      await this.active(c, userId);
      return { ...this.dto((await this.reusable(c, userId, id)).row, userId), canReuse: true };
    });
  }
  async grants(userId: string, id: string) {
    z.uuid().parse(id);
    return this.db.tx(async (c) => {
      await this.active(c, userId);
      if (
        !(
          await c.query(
            'SELECT 1 FROM art_asset_revisions r JOIN art_asset_families f ON f.id=r.family_id WHERE r.id=$1 AND f.owner_id=$2',
            [id, userId],
          )
        ).rowCount
      )
        fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
      return (
        await c.query(
          'SELECT g.id,g.grantee_id AS "granteeUserId",u.handle AS "granteeHandle",g.revoked_at IS NOT NULL AS revoked,g.retain_existing_pins AS "retainExistingPins" FROM art_asset_grants g LEFT JOIN users u ON u.id=g.grantee_id AND u.deleted_at IS NULL WHERE g.revision_id=$1 ORDER BY g.created_at DESC LIMIT 200',
          [id],
        )
      ).rows;
    });
  }
  async search(userId: string, input: unknown) {
    const spec = assetSpecSchema.parse(input);
    return this.db.tx(async (c) => {
      await this.active(c, userId);
      return this.searchTx(c, userId, spec);
    });
  }
  private async searchTx(c: PoolClient, userId: string, spec: AssetSpec) {
    const rows = (
      await c.query<Revision>(
        `${baseRevision} WHERE r.upload_id IS NOT NULL AND f.archived_at IS NULL AND u.deleted_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM art_asset_takedowns t WHERE t.revision_id=r.id)
   AND (f.owner_id=$1 OR EXISTS(SELECT 1 FROM art_asset_grants g WHERE g.revision_id=r.id AND g.grantee_id=$1 AND g.revoked_at IS NULL))
   AND r.metadata->>'kind'=$2 AND r.metadata->>'style'=$3 AND ($4='unrestricted' OR r.metadata->>'camera'=$4 OR r.metadata->>'camera'='unrestricted')
   AND (r.metadata->'tags') @> $5::jsonb AND r.width>=$6 AND r.height>=$7
   AND ($8::text IS NULL OR r.metadata->>'variant'=$8)
   ORDER BY (f.owner_id=$1) DESC,r.created_at DESC,r.id LIMIT 50`,
        [
          userId,
          spec.kind,
          spec.style,
          spec.camera,
          JSON.stringify(spec.tags),
          spec.minWidth,
          spec.minHeight,
          spec.variant ?? null,
        ],
      )
    ).rows;
    return rows.map((r) => ({ ...this.dto(r, userId), canReuse: true }));
  }
  async resolve(userId: string, input: unknown) {
    const spec = assetSpecSchema.parse(input),
      matches = await this.search(userId, spec);
    if (matches.length)
      return {
        decision: 'reuse' as const,
        revision: matches[0],
        alternatives: matches.slice(1),
        generation: null,
        providerCalls: 0,
        charge: 0,
      };
    return {
      decision: 'propose_generation' as const,
      revision: null,
      alternatives: [],
      generation: {
        id: hash({ userId, spec }).slice(0, 32),
        kind: 'generation_proposal' as const,
        spec,
        requiresExplicitApproval: true,
        estimatedCost: null,
      },
      providerCalls: 0,
      charge: 0,
    };
  }
  async grant(userId: string, revisionId: string, input: unknown) {
    z.uuid().parse(revisionId);
    const b = grantReuseSchema.parse(input);
    return this.mutate(userId, b.operationId, { action: 'grant', revisionId, ...b }, async (c) => {
      const { row } = await this.reusable(c, userId, revisionId, true);
      if (row.owner_id !== userId) fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
      if (!(row.metadata.rights as { allowAuthorReuse?: boolean })?.allowAuthorReuse)
        fail(403, 'REUSE_NOT_ATTESTED', 'REUSE_NOT_ATTESTED');
      const granteeUserId =
        b.granteeUserId ??
        (
          await c.query(
            'SELECT id FROM users WHERE lower(handle)=lower($1) AND deleted_at IS NULL',
            [b.granteeHandle],
          )
        ).rows[0]?.id;
      if (!granteeUserId) fail(404, 'RECIPIENT_NOT_FOUND', 'RECIPIENT_NOT_FOUND');
      if (granteeUserId === userId) fail(400, 'SELF_GRANT_UNNECESSARY', 'SELF_GRANT_UNNECESSARY');
      if (
        !(
          await c.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [
            granteeUserId,
          ])
        ).rowCount
      )
        fail(404, 'RECIPIENT_NOT_FOUND', 'RECIPIENT_NOT_FOUND');
      const prior = (
        await c.query(
          'SELECT id FROM art_asset_grants WHERE revision_id=$1 AND grantee_id=$2 AND revoked_at IS NULL',
          [revisionId, granteeUserId],
        )
      ).rows[0];
      const id = prior?.id ?? randomUUID();
      if (!prior)
        await c.query(
          'INSERT INTO art_asset_grants(id,revision_id,grantor_id,grantee_id,retain_existing_pins) VALUES($1,$2,$3,$4,true)',
          [id, revisionId, userId, granteeUserId],
        );
      return {
        id,
        revisionId,
        granteeUserId: granteeUserId,
        retainExistingPins: true,
        revoked: false,
      };
    });
  }
  async revoke(userId: string, revisionId: string, grantId: string, operationId: string) {
    [revisionId, grantId].forEach((v) => z.uuid().parse(v));
    return this.mutate(
      userId,
      operationId,
      { action: 'revoke', revisionId, grantId },
      async (c) => {
        const grant = (
          await c.query(
            'SELECT * FROM art_asset_grants WHERE id=$1 AND revision_id=$2 AND grantor_id=$3 FOR UPDATE',
            [grantId, revisionId, userId],
          )
        ).rows[0];
        if (!grant) fail(404, 'NOT_FOUND', 'NOT_FOUND');
        await c.query(
          'UPDATE art_asset_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1',
          [grantId],
        );
        return { id: grantId, revoked: true, existingPinsRetained: true };
      },
    );
  }
  async takedown(userId: string, revisionId: string, operationId: string) {
    z.uuid().parse(revisionId);
    return this.mutate(userId, operationId, { action: 'takedown', revisionId }, async (c) => {
      if (
        !(
          await c.query(
            'SELECT 1 FROM art_asset_revisions r JOIN art_asset_families f ON f.id=r.family_id WHERE r.id=$1 AND f.owner_id=$2 FOR UPDATE OF f',
            [revisionId, userId],
          )
        ).rowCount
      )
        fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
      await c.query(
        'SELECT id FROM assets WHERE id=(SELECT upload_id FROM art_asset_revisions WHERE id=$1) FOR UPDATE',
        [revisionId],
      );
      await c.query(
        "INSERT INTO art_asset_takedowns(revision_id,reason_code) SELECT id,'owner_withdrawal' FROM art_asset_revisions WHERE id=$1 OR upload_id=(SELECT upload_id FROM art_asset_revisions WHERE id=$1) ON CONFLICT DO NOTHING",
        [revisionId],
      );
      await c.query(
        'UPDATE art_asset_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE revision_id=$1',
        [revisionId],
      );
      return { revisionId, tombstoned: true };
    });
  }
  async draft(userId: string, adventureId: string) {
    z.uuid().parse(adventureId);
    return this.db.tx(async (c) => {
      await this.storyOwner(c, userId, adventureId);
      const r = (
        await c.query('SELECT * FROM art_story_asset_drafts WHERE adventure_id=$1', [adventureId])
      ).rows[0];
      return { revision: r?.revision ?? 0, bindings: r?.bindings ?? [] };
    });
  }
  private async storyOwner(c: PoolClient, userId: string, id: string, mutation = false) {
    await this.active(c, userId);
    if (
      !(
        await c.query(
          `SELECT 1 FROM adventures WHERE id=$1 AND owner_id=$2 AND status<>'archived' FOR ${mutation ? 'UPDATE' : 'SHARE'}`,
          [id, userId],
        )
      ).rowCount
    )
      fail(404, 'NOT_FOUND', 'NOT_FOUND');
  }
  async saveDraft(userId: string, adventureId: string, input: unknown) {
    z.uuid().parse(adventureId);
    const b = draftBindingsSchema.parse(input);
    return this.mutate(userId, b.operationId, { action: 'draft', adventureId, ...b }, async (c) => {
      await this.storyOwner(c, userId, adventureId, true);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `art-story:${adventureId}`,
      ]);
      const prior = (
        await c.query(
          'SELECT revision FROM art_story_asset_drafts WHERE adventure_id=$1 FOR UPDATE',
          [adventureId],
        )
      ).rows[0];
      if ((prior?.revision ?? 0) !== b.expectedRevision)
        fail(409, 'STALE_REVISION', 'STALE_REVISION');
      const mapDraft = (
        await c.query('SELECT draft FROM adventure_game_drafts WHERE adventure_id=$1 FOR SHARE', [
          adventureId,
        ])
      ).rows[0];
      if (!mapDraft) fail(409, 'NOT_PLAYABLE', 'NOT_PLAYABLE');
      const compiled = compilePlayableDraft(mapDraft.draft);
      if (!compiled.playable) fail(400, 'INVALID_MAP', 'INVALID_MAP');
      for (const binding of b.bindings) {
        const { row } = await this.reusable(c, userId, binding.revisionId, true);
        this.validateBinding(compiled.playable!, binding.slot, row.metadata);
      }
      const revision = (prior?.revision ?? 0) + 1;
      await c.query(
        'INSERT INTO art_story_asset_drafts(adventure_id,revision,bindings) VALUES($1,$2,$3) ON CONFLICT(adventure_id) DO UPDATE SET revision=EXCLUDED.revision,bindings=EXCLUDED.bindings,updated_at=now()',
        [adventureId, revision, JSON.stringify(b.bindings)],
      );
      await c.query(
        "UPDATE adventures SET status=CASE WHEN status='archived' THEN status ELSE 'draft' END,submitted_game_version_id=NULL,updated_at=now() WHERE id=$1",
        [adventureId],
      );
      return { revision, bindings: b.bindings };
    });
  }
  /** Publication hook: caller must own the transaction that creates the immutable playable version. */
  private validateBinding(
    playable: PlayablePackage,
    slot: string,
    metadata: Record<string, unknown>,
  ) {
    if (
      !validateArtBindingSlot(
        playable,
        slot,
        metadata as { kind: string; style: string; camera: string },
      )
    )
      fail(400, 'INVALID_ART_BINDING', 'INVALID_ART_BINDING');
  }
  /** Caller owns the authorized campaign writer transaction and current slot visibility. */
  async pinCampaignArtTx(
    c: PoolClient,
    userId: string,
    campaignId: string,
    state: GameState,
    slot: string,
    revisionId: string,
  ): Promise<FrozenArtBinding> {
    z.uuid().parse(revisionId);
    const { row, grantId } = await this.reusable(c, userId, revisionId, true);
    if (
      !validateArtBindingSlot(
        state,
        slot,
        row.metadata as { kind: string; style: string; camera: string },
      )
    )
      fail(400, 'INVALID_ART_BINDING', 'INVALID_ART_BINDING');
    const binding = frozenArtBindingsSchema.parse([
      {
        slot,
        revisionId,
        sha256: row.sha256,
        mime: row.mime,
        width: row.width,
        height: row.height,
      },
    ])[0];
    await c.query(
      'INSERT INTO art_campaign_pins(campaign_id,slot,revision_id,grant_id,rights_snapshot) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [campaignId, slot, revisionId, grantId, row.metadata.rights],
    );
    return binding;
  }
  /** Resolve once before package hashing; caller owns the playable freeze transaction. */
  async prepareManifestTx(
    c: PoolClient,
    adventureId: string,
    userId: string,
    playable: PlayablePackage,
  ) {
    await this.storyOwner(c, userId, adventureId, true);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `art-story:${adventureId}`,
    ]);
    const draft = (
      await c.query('SELECT * FROM art_story_asset_drafts WHERE adventure_id=$1 FOR SHARE', [
        adventureId,
      ])
    ).rows[0];
    const pins = [];
    for (const binding of (draft?.bindings ?? []) as AssetBinding[]) {
      const { row, grantId } = await this.reusable(c, userId, binding.revisionId, true);
      // Package-aware slot/kind/camera validation is supplied by the shared core helper.
      this.validateBinding(playable, binding.slot, row.metadata);
      pins.push({
        ...binding,
        grantId,
        rights: row.metadata.rights,
        sha256: row.sha256,
        mime: row.mime,
        width: row.width,
        height: row.height,
      });
    }
    pins.sort((a, b) => a.slot.localeCompare(b.slot));
    const bindings = frozenArtBindingsSchema.parse(
      pins.map(({ slot, revisionId, sha256, mime, width, height }) => ({
        slot,
        revisionId,
        sha256,
        mime,
        width,
        height,
      })),
    );
    return {
      adventureId,
      draftRevision: draft?.revision ?? 0,
      pins,
      bindings,
      checksum: hash(bindings),
    };
  }
  async pinPrepared(
    c: PoolClient,
    playableVersionId: string,
    prepared: Awaited<ReturnType<AssetReuseService['prepareManifestTx']>>,
  ) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `art-version:${playableVersionId}`,
    ]);
    const version = (
      await c.query('SELECT adventure_id,package FROM game_playable_versions WHERE id=$1', [
        playableVersionId,
      ])
    ).rows[0];
    if (
      !version ||
      version.adventure_id !== prepared.adventureId ||
      hash(version.package.compiled.artBindings ?? []) !== prepared.checksum
    )
      fail(409, 'MANIFEST_CONFLICT', 'MANIFEST_CONFLICT');
    const prior = (
      await c.query('SELECT checksum FROM art_playable_manifests WHERE playable_version_id=$1', [
        playableVersionId,
      ])
    ).rows[0];
    if (prior) {
      if (prior.checksum !== prepared.checksum) fail(409, 'MANIFEST_CONFLICT', 'MANIFEST_CONFLICT');
      return { checksum: prior.checksum };
    }
    await c.query(
      'INSERT INTO art_playable_manifests(playable_version_id,adventure_id,draft_revision,checksum) VALUES($1,$2,$3,$4)',
      [playableVersionId, prepared.adventureId, prepared.draftRevision, prepared.checksum],
    );
    for (const p of prepared.pins)
      await c.query(
        'INSERT INTO art_playable_pins(playable_version_id,slot,revision_id,grant_id,rights_snapshot) VALUES($1,$2,$3,$4,$5)',
        [playableVersionId, p.slot, p.revisionId, p.grantId, p.rights],
      );
    return { checksum: prepared.checksum };
  }
  private async versionAccess(
    c: PoolClient,
    userId: string | null,
    versionId: string,
    admin = false,
  ) {
    const access = (
      await c.query(
        `SELECT 1 FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id JOIN users author ON author.id=a.owner_id WHERE v.id=$1 AND author.deleted_at IS NULL AND a.status<>'archived' AND (
    a.owner_id=$2
    OR ($3::boolean AND a.status='pending_review' AND a.submitted_game_version_id=v.id))`,
        [versionId, userId, admin],
      )
    ).rowCount;
    if (!access) fail(404, 'NOT_FOUND', 'NOT_FOUND');
  }
  async manifest(userId: string | null, versionId: string, admin = false) {
    z.uuid().parse(versionId);
    return this.db.tx(async (c) => {
      await this.versionAccess(c, userId, versionId, admin);
      const manifest = (
        await c.query('SELECT checksum FROM art_playable_manifests WHERE playable_version_id=$1', [
          versionId,
        ])
      ).rows[0];
      if (!manifest) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const rows = (
        await c.query<Revision>(
          `${baseRevision} JOIN art_playable_pins p ON p.revision_id=r.id WHERE p.playable_version_id=$1 ORDER BY p.slot`,
          [versionId],
        )
      ).rows;
      const bindings = (
        await c.query(
          'SELECT slot,revision_id FROM art_playable_pins WHERE playable_version_id=$1 ORDER BY slot',
          [versionId],
        )
      ).rows;
      const unavailable = new Set(
        (
          await c.query(
            'SELECT revision_id FROM art_asset_takedowns WHERE revision_id=ANY($1::uuid[])',
            [rows.map((r) => r.id)],
          )
        ).rows.map((r) => r.revision_id),
      );
      return {
        checksum: manifest.checksum,
        bindings: bindings.map((b) => {
          const r = rows.find((r) => r.id === b.revision_id)!;
          return {
            slot: b.slot,
            revision:
              !r.upload_id || r.deleted_at || unavailable.has(r.id)
                ? { id: r.id, unavailable: true }
                : {
                    ...this.dto(r),
                    url: `/api/v1/asset-library/revisions/${r.id}/file?playableVersionId=${versionId}`,
                  },
          };
        }),
      };
    });
  }
  async assertPinsAvailable(c: PoolClient, versionId: string) {
    const version = (
      await c.query('SELECT package FROM game_playable_versions WHERE id=$1', [versionId])
    ).rows[0];
    if (!version) fail(409, 'ART_UNAVAILABLE', 'ART_UNAVAILABLE');
    const bindings = frozenArtBindingsSchema.parse(version.package.compiled.artBindings ?? []);
    for (const binding of bindings) {
      const owner = (
        await c.query(
          'SELECT f.owner_id FROM art_asset_revisions r JOIN art_asset_families f ON f.id=r.family_id WHERE r.id=$1',
          [binding.revisionId],
        )
      ).rows[0];
      if (
        !owner ||
        !(
          await c.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [
            owner.owner_id,
          ])
        ).rowCount
      )
        fail(409, 'ART_UNAVAILABLE', 'ART_UNAVAILABLE');
      const revision = (
        await c.query(
          'SELECT r.upload_id FROM art_asset_revisions r JOIN art_playable_pins p ON p.revision_id=r.id WHERE r.id=$1 AND p.playable_version_id=$2 AND p.slot=$3 FOR SHARE OF r',
          [binding.revisionId, versionId, binding.slot],
        )
      ).rows[0];
      if (!revision?.upload_id) fail(409, 'ART_UNAVAILABLE', 'ART_UNAVAILABLE');
      if (
        !(await c.query('SELECT id FROM assets WHERE id=$1 FOR SHARE', [revision.upload_id]))
          .rowCount ||
        (
          await c.query('SELECT 1 FROM art_asset_takedowns WHERE revision_id=$1', [
            binding.revisionId,
          ])
        ).rowCount
      )
        fail(409, 'ART_UNAVAILABLE', 'ART_UNAVAILABLE');
    }
  }
  async unavailableRevisions(revisionIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(revisionIds)].slice(0, 128);
    if (!ids.length) return new Set();
    const rows = await this.db.query<{ id: string }>(
      `SELECT r.id FROM art_asset_revisions r JOIN art_asset_families f ON f.id=r.family_id JOIN users u ON u.id=f.owner_id JOIN assets a ON a.id=r.upload_id WHERE r.id=ANY($1::uuid[]) AND u.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM art_asset_takedowns t WHERE t.revision_id=r.id)`,
      [ids],
    );
    const available = new Set(rows.map((r) => r.id));
    return new Set(ids.filter((id) => !available.has(id)));
  }
  async visibleManifestForState(
    campaignId: string,
    actorId: string,
    state: GameState,
    sourceVersionId: string | null,
  ) {
    const bindings = projectVisibleArtBindings(state, actorId);
    const missing = await this.unavailableRevisions(bindings.map((b) => b.revisionId));
    const pins = await this.db.query<{
      slot: string;
      revision_id: string;
      rights_snapshot: Record<string, unknown>;
    }>(
      `SELECT slot,revision_id,rights_snapshot FROM art_playable_pins WHERE playable_version_id=$1 AND revision_id=ANY($2::uuid[])
       UNION ALL SELECT slot,revision_id,rights_snapshot FROM art_campaign_pins WHERE campaign_id=$3 AND revision_id=ANY($2::uuid[])`,
      [sourceVersionId, bindings.map((b) => b.revisionId), campaignId],
    );
    const rights = new Map(pins.map((p) => [`${p.slot}:${p.revision_id}`, p.rights_snapshot]));
    return {
      bindings: bindings
        .filter((b) => !missing.has(b.revisionId) && rights.has(`${b.slot}:${b.revisionId}`))
        .map((b) => ({
          ...b,
          attribution: String(rights.get(`${b.slot}:${b.revisionId}`)?.attribution ?? '').slice(
            0,
            240,
          ),
          licenseLabel: String(rights.get(`${b.slot}:${b.revisionId}`)?.licenseLabel ?? '').slice(
            0,
            120,
          ),
          url: `/api/v1/asset-library/revisions/${b.revisionId}/file?campaignId=${campaignId}`,
        })),
      refreshAfterMs: 5000,
    };
  }
  async campaignManifest(userId: string, campaignId: string) {
    z.uuid().parse(campaignId);
    const row = (
      await this.db.query<{ state: GameState; actor_id: string; source_version_id: string | null }>(
        `SELECT c.state,c.source_version_id,m.actor_id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id JOIN users owner ON owner.id=c.owner_id JOIN users viewer ON viewer.id=m.user_id WHERE c.id=$1 AND m.user_id=$2 AND m.status='accepted' AND owner.deleted_at IS NULL AND viewer.deleted_at IS NULL AND ${sourceAccessSql('$2')}`,
        [campaignId, userId],
      )
    )[0];
    if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    return this.visibleManifestForState(
      campaignId,
      row.actor_id,
      this.runtimeStateReader?.(campaignId) ?? row.state,
      row.source_version_id,
    );
  }
  async fileDescriptor(
    userId: string | null,
    revisionId: string,
    context: { campaignId?: string; playableVersionId?: string } = {},
    admin = false,
  ) {
    z.uuid().parse(revisionId);
    if (context.campaignId) z.uuid().parse(context.campaignId);
    if (context.playableVersionId) z.uuid().parse(context.playableVersionId);
    return this.db.tx(async (c) => {
      const row = (await c.query<Revision>(`${baseRevision} WHERE r.id=$1`, [revisionId])).rows[0];
      if (
        !row ||
        !row.upload_id ||
        !row.filename ||
        row.deleted_at ||
        (await c.query('SELECT 1 FROM art_asset_takedowns WHERE revision_id=$1', [revisionId]))
          .rowCount
      )
        fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
      let allowed = userId === row.owner_id;
      let versionId = context.playableVersionId;
      let campaignPin = false;
      if (context.campaignId) {
        if (!userId) fail(404, 'NOT_FOUND', 'NOT_FOUND');
        const campaign = (
          await c.query(
            `SELECT c.source_version_id,c.state,m.actor_id FROM game_campaigns c JOIN game_members m ON m.campaign_id=c.id JOIN users owner ON owner.id=c.owner_id WHERE c.id=$1 AND m.user_id=$2 AND m.status='accepted' AND owner.deleted_at IS NULL AND ${sourceAccessSql('$2')}`,
            [context.campaignId, userId],
          )
        ).rows[0];
        if (!campaign) fail(404, 'NOT_FOUND', 'NOT_FOUND');
        const visible = projectVisibleArtBindings(
          this.runtimeStateReader?.(context.campaignId) ?? (campaign.state as GameState),
          campaign.actor_id as string,
        );
        if (!visible.some((b: FrozenArtBinding) => b.revisionId === revisionId))
          fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
        versionId = campaign.source_version_id;
        campaignPin = Boolean(
          (
            await c.query(
              'SELECT 1 FROM art_campaign_pins WHERE campaign_id=$1 AND revision_id=$2 AND slot=ANY($3::text[])',
              [
                context.campaignId,
                revisionId,
                visible
                  .filter((b: FrozenArtBinding) => b.revisionId === revisionId)
                  .map((b: FrozenArtBinding) => b.slot),
              ],
            )
          ).rowCount,
        );
      }
      if (versionId) {
        if (!context.campaignId) await this.versionAccess(c, userId, versionId, admin);
        allowed = Boolean(
          (
            await c.query(
              'SELECT 1 FROM art_playable_pins WHERE playable_version_id=$1 AND revision_id=$2',
              [versionId, revisionId],
            )
          ).rowCount,
        );
      } else if (userId && !allowed)
        allowed = Boolean(
          (
            await c.query(
              'SELECT 1 FROM art_asset_grants WHERE revision_id=$1 AND grantee_id=$2 AND revoked_at IS NULL',
              [revisionId, userId],
            )
          ).rowCount,
        );
      if (context.campaignId) allowed = (versionId ? allowed : false) || campaignPin;
      if (!allowed) fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
      return { filename: row.filename!, mime: row.mime, sha256: row.sha256 };
    });
  }
}
