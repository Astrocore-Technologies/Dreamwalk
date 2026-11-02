import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  contentSchema,
  authoredGameDraftSchema,
  npcCharacterProfileSchema,
  validateStoryLoreReferences,
} from '@dreamwalk/contracts';
import { enumerateArtSlots } from '@dreamwalk/game-core';
import { Db } from '../db';
import { AssetReuseService } from '../assets/reuse.service';
import { AuthoringTextEngine, type AuthoringTextBinding } from '../live-test/authoring-text';
import { fail } from '../errors';
import { visualDigest as digest } from '../visual-authoring/fingerprint';
import { compileStoryPlan, type StoryPlanSource } from './story-plan';
const op = z.object({ operationId: z.uuid() }).strict();
@Injectable()
export class StoryBuildService {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(AssetReuseService) private art: AssetReuseService,
    @Optional() @Inject('STORY_BUILD_ENGINE') private engine?: AuthoringTextEngine,
  ) {}
  private configured() {
    return this.engine ?? fail(409, 'STORY_PLANNER_UNAVAILABLE', 'STORY_PLANNER_UNAVAILABLE');
  }
  private async lock(c: PoolClient, owner: string) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['art-owner:' + owner]);
    await this.art.lockAuthor(c, owner);
  }
  private async source(c: PoolClient, owner: string, id: string) {
    const story = (
      await c.query(
        "SELECT * FROM adventures WHERE id=$1 AND owner_id=$2 AND status<>'archived' FOR UPDATE",
        [id, owner],
      )
    ).rows[0];
    if (!story) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const content = contentSchema.parse(story.data.content);
    if (!content.locations.length || content.locations.length > 4 || content.npcIds.length > 8)
      fail(400, 'STORY_PLAN_CAPACITY', 'STORY_PLAN_CAPACITY');
    if (
      !validateStoryLoreReferences(content) ||
      new Set(content.locations.map((l) => l.id)).size !== content.locations.length ||
      new Set(content.npcIds).size !== content.npcIds.length
    )
      fail(400, 'STORY_SOURCE_MISMATCH', 'STORY_SOURCE_MISMATCH');
    const npcs = content.npcIds.length
      ? (
          await c.query(
            'SELECT id,data FROM npcs WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND (story_id IS NULL OR story_id=$3) ORDER BY id FOR SHARE',
            [owner, content.npcIds, id],
          )
        ).rows
      : [];
    if (npcs.length !== content.npcIds.length) fail(403, 'FORBIDDEN', 'FORBIDDEN');
    const game = (
      await c.query(
        'SELECT draft,revision FROM adventure_game_drafts WHERE adventure_id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    const art = (
      await c.query(
        'SELECT bindings,revision FROM art_story_asset_drafts WHERE adventure_id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    const images = (
      await c.query(
        'SELECT location_id,revision_id,source_hash FROM studio_location_images WHERE adventure_id=$1 AND owner_id=$2 ORDER BY location_id',
        [id, owner],
      )
    ).rows;
    const hash = digest({
      data: story.data,
      edit: story.edit_revision,
      npcs,
      gameRevision: game?.revision ?? 0,
      artRevision: art?.revision ?? 0,
      images,
    });
    const source: StoryPlanSource = {
      title: story.data.title ?? story.title,
      synopsis: story.data.synopsis ?? story.synopsis ?? '',
      content,
      npcs: npcs.map((n) => ({
        id: n.id,
        name: n.data.name,
        role: n.data.role ?? '',
        description: n.data.description ?? '',
        appearance: n.data.appearance ?? '',
        ...(n.data.characterProfile === null
          ? { characterProfile: null }
          : n.data.characterProfile
            ? { characterProfile: npcCharacterProfileSchema.parse(n.data.characterProfile) }
            : {}),
      })),
      priorDraft: game?.draft ? authoredGameDraftSchema.parse(game.draft) : null,
    };
    return {
      hash,
      source,
      images,
      bindings: art?.bindings ?? [],
      gameRevision: Number(game?.revision ?? 0),
      artRevision: Number(art?.revision ?? 0),
    };
  }
  async prepare(owner: string, adventureId: string, input: unknown) {
    const b = op.parse(input);
    z.uuid().parse(adventureId);
    return this.db.tx(async (c) => {
      await this.lock(c, owner);
      const prior = (
          await c.query(
            'SELECT request_hash,result FROM visual_authoring_operations WHERE owner_id=$1 AND operation_id=$2',
            [owner, b.operationId],
          )
        ).rows[0],
        requestHash = digest({ action: 'story-build', adventureId });
      if (prior) {
        if (prior.request_hash !== requestHash)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return prior.result;
      }
      const s = await this.source(c, owner, adventureId),
        id = randomUUID();
      await c.query(
        "INSERT INTO visual_authoring_projects(id,owner_id,kind,adventure_id,brief,source_hash,status,generation_mode,plan_origin) VALUES($1,$2,'location',$3,$4,$5,'concept','external','manual')",
        [id, owner, adventureId, JSON.stringify({ name: s.source.title }), s.hash],
      );
      await c.query(
        'INSERT INTO story_playable_builds(project_id,owner_id,adventure_id,source_hash,source_snapshot) VALUES($1,$2,$3,$4,$5)',
        [id, owner, adventureId, s.hash, JSON.stringify(s)],
      );
      const result = {
        id,
        sourceHash: s.hash,
        status: 'prepared',
        providerCalls: 0,
        automaticDispatch: false,
      };
      await c.query(
        'INSERT INTO visual_authoring_operations(owner_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)',
        [owner, b.operationId, requestHash, JSON.stringify(result)],
      );
      return result;
    });
  }
  private async own(c: PoolClient, owner: string, id: string) {
    const r = (
      await c.query(
        'SELECT b.*,p.status AS project_status FROM story_playable_builds b JOIN visual_authoring_projects p ON p.id=b.project_id WHERE b.project_id=$1 AND b.owner_id=$2 AND p.owner_id=$2 FOR UPDATE OF b,p',
        [z.uuid().parse(id), owner],
      )
    ).rows[0];
    return r ?? fail(404, 'NOT_FOUND', 'NOT_FOUND');
  }
  private guard(owner: string) {
    return async (c: PoolClient, b: AuthoringTextBinding) => {
      await this.lock(c, owner);
      const r = await this.own(c, owner, b.projectId);
      const current = await this.source(c, owner, r.adventure_id);
      if (
        r.status !== 'prepared' ||
        r.project_status === 'cancelled' ||
        b.projectRevision !== 1 ||
        b.sourceHash !== r.source_hash ||
        b.readsetHash !== digest(r.source_snapshot.source) ||
        current.hash !== r.source_hash ||
        // Older immutable preparations omitted synopsis despite hashing the full story.
        // Never quote the new prompt with silently incomplete source: reprepare instead.
        (r.source_snapshot.source.synopsis === undefined && !!current.source.synopsis)
      )
        fail(409, 'STORY_CONTEXT_STALE', 'STORY_CONTEXT_STALE');
    };
  }
  private sameAuthorSource(a: StoryPlanSource, b: StoryPlanSource) {
    return (
      digest({ title: a.title, synopsis: a.synopsis ?? '', content: a.content, npcs: a.npcs }) ===
      digest({ title: b.title, synopsis: b.synopsis ?? '', content: b.content, npcs: b.npcs })
    );
  }
  async latest(owner: string, adventureId: string) {
    z.uuid().parse(adventureId);
    const story = await this.db.query('SELECT id FROM adventures WHERE id=$1 AND owner_id=$2', [
      adventureId,
      owner,
    ]);
    if (!story.length) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const row = (
      await this.db.query(
        'SELECT project_id FROM story_playable_builds WHERE adventure_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 1',
        [adventureId, owner],
      )
    )[0];
    return row ? this.state(owner, row.project_id) : null;
  }
  async state(owner: string, id: string) {
    return this.db.tx(async (c) => {
      await this.lock(c, owner);
      const r = await this.own(c, owner, id);
      const jobs = (
        await c.query(
          'SELECT j.id,j.status,j.error_code,j.actual_micros,h.status AS "sparkStatus",h.reserved_subunits AS "sparkReservedSubunits",h.captured_subunits AS "sparkCapturedSubunits" FROM live_authoring_text_jobs j LEFT JOIN spark_holds h ON h.id=j.spark_quote_id WHERE j.project_id=$1 AND j.actor_id=$2 ORDER BY j.created_at DESC LIMIT 8',
          [id, owner],
        )
      ).rows;
      const current = await this.source(c, owner, r.adventure_id);
      return {
        id,
        status: r.status,
        sourceHash: r.source_hash,
        draft: r.draft,
        images: r.source_snapshot.images,
        jobs,
        automaticDispatch: false,
        sourceCurrent:
          this.sameAuthorSource(current.source, r.source_snapshot.source) &&
          (r.status === 'applied' || current.hash === r.source_hash),
      };
    });
  }
  async quote(owner: string, id: string, input: unknown) {
    const b = op.extend({ sessionId: z.uuid() }).parse(input);
    const data = await this.db.tx(async (c) => {
      await this.lock(c, owner);
      const r = await this.own(c, owner, id);
      if (r.status !== 'prepared') fail(409, 'STATE_CONFLICT', 'STATE_CONFLICT');
      return {
        operationId: b.operationId,
        sessionId: b.sessionId,
        projectId: id,
        projectRevision: 1,
        sourceHash: r.source_hash,
        readsetHash: digest(r.source_snapshot.source),
        context: r.source_snapshot.source,
      };
    });
    return this.configured().quote(owner, data, this.guard(owner));
  }
  async dispatch(owner: string, id: string, input: unknown) {
    const b = op.extend({ quoteId: z.uuid(), consent: z.literal(true) }).parse(input),
      engine = this.configured();
    const q = (
      await this.db.query(
        'SELECT project_id FROM live_authoring_text_quotes WHERE id=$1 AND actor_id=$2',
        [b.quoteId, owner],
      )
    )[0];
    if (q?.project_id !== id) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const job = await engine.enqueue(owner, b, this.guard(owner));
    return engine.run(owner, job.id, this.guard(owner), async (c, b, value) => {
      const r = await this.own(c, owner, id),
        s = r.source_snapshot.source as StoryPlanSource;
      const checked = compileStoryPlan(s, value);
      await c.query(
        "UPDATE story_playable_builds SET status='proposed',proposal=$2,draft=$3,job_id=$4 WHERE project_id=$1",
        [id, JSON.stringify(checked.proposal), JSON.stringify(checked.draft), job.id],
      );
      return { buildId: id, readyForReview: true };
    });
  }
  async apply(owner: string, id: string, input: unknown) {
    const b = op
      .extend({
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
        reviewed: z.literal(true),
        imageReuseConsent: z.literal(true),
      })
      .parse(input);
    return this.db.tx(async (c) => {
      await this.lock(c, owner);
      const requestHash = digest({ action: 'story-build-apply', id, ...b }),
        prior = (
          await c.query(
            'SELECT request_hash,result FROM visual_authoring_operations WHERE owner_id=$1 AND operation_id=$2',
            [owner, b.operationId],
          )
        ).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash)
          fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
        return prior.result;
      }
      const r = await this.own(c, owner, id),
        s = await this.source(c, owner, r.adventure_id);
      if (
        r.status !== 'proposed' ||
        r.project_status === 'cancelled' ||
        r.source_hash !== b.sourceHash ||
        s.hash !== r.source_hash
      )
        fail(409, 'STORY_CONTEXT_STALE', 'STORY_CONTEXT_STALE');
      const checked = compileStoryPlan(s.source, r.proposal);
      if (digest(checked.draft) !== digest(r.draft))
        fail(409, 'ASSET_INTEGRITY_FAILED', 'ASSET_INTEGRITY_FAILED');
      const slots = new Set(enumerateArtSlots(checked.draft).map((s) => s.slot));
      const bindings = (s.bindings as { slot: string; revisionId: string }[]).filter((v) =>
        slots.has(v.slot),
      );
      for (const image of s.images) {
        const map = checked.draft.maps.find((m) => m.sourceLocationId === image.location_id);
        if (!map) continue;
        const revision = await this.art.reusableRevisionTx(c, owner, image.revision_id);
        if (
          revision.row.metadata.kind !== 'background' ||
          revision.row.metadata.camera !== 'top-down' ||
          revision.row.metadata.style !== 'drawn2D'
        )
          fail(409, 'ART_INCOMPATIBLE', 'ART_INCOMPATIBLE');
        const slot = 'map:' + map.id + ':background';
        const old = bindings.findIndex((b) => b.slot === slot);
        if (old >= 0) bindings.splice(old, 1);
        bindings.push({ slot, revisionId: image.revision_id });
        await c.query(
          'UPDATE studio_location_images SET map_id=$3 WHERE adventure_id=$1 AND location_id=$2',
          [r.adventure_id, image.location_id, map.id],
        );
      }
      await c.query(
        'INSERT INTO adventure_game_drafts(adventure_id,revision,draft) VALUES($1,1,$2) ON CONFLICT(adventure_id) DO UPDATE SET revision=adventure_game_drafts.revision+1,draft=EXCLUDED.draft,updated_at=now()',
        [r.adventure_id, JSON.stringify(checked.draft)],
      );
      await c.query(
        'INSERT INTO art_story_asset_drafts(adventure_id,revision,bindings) VALUES($1,1,$2) ON CONFLICT(adventure_id) DO UPDATE SET revision=art_story_asset_drafts.revision+1,bindings=EXCLUDED.bindings,updated_at=now()',
        [r.adventure_id, JSON.stringify(bindings)],
      );
      await c.query(
        "UPDATE adventures SET status='draft',submitted_game_version_id=NULL,updated_at=now() WHERE id=$1",
        [r.adventure_id],
      );
      await c.query(
        "UPDATE story_playable_builds SET status='applied',applied_at=now() WHERE project_id=$1",
        [id],
      );
      const result = {
        applied: true,
        adventureId: r.adventure_id,
        playableRevision: s.gameRevision + 1,
        providerCalls: 0,
        chargeMicros: 0,
      };
      await c.query(
        'INSERT INTO visual_authoring_operations(owner_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)',
        [owner, b.operationId, requestHash, JSON.stringify(result)],
      );
      return result;
    });
  }
}
