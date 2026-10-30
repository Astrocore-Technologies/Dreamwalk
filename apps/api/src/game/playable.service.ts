import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  authoredGameDraftSchema,
  gameActionSchema,
  type PlayablePackage,
} from '@dreamwalk/contracts';
import {
  compilePlayableDraft,
  createStateFromPlayable,
  applyAction,
  recordNpcEvents,
  tick,
  stepLivingNpcs,
  stepNpcPlan,
} from '@dreamwalk/game-core';
import { Db } from '../db';
import { Auth } from '../auth';
import { fail } from '../errors';

export function sourceAccessSql(user: string, campaign = 'c') {
  return `(${campaign}.source_version_id IS NULL OR EXISTS(SELECT 1 FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id JOIN users author ON author.id=a.owner_id WHERE v.id=${campaign}.source_version_id AND author.deleted_at IS NULL AND a.status<>'archived' AND ((v.audience='private' AND (a.owner_id=${user} OR (a.visibility='private' AND EXISTS(SELECT 1 FROM adventure_invitations i WHERE i.adventure_id=a.id AND i.recipient_id=${user} AND i.status='accepted')))) OR (v.audience='review' AND a.visibility='public' AND a.published_snapshot IS NOT NULL AND EXISTS(SELECT 1 FROM game_playable_approvals ap WHERE ap.playable_version_id=v.id)))))`;
}
export function sourceLiveSql(campaign = 'c') {
  return `(${campaign}.source_version_id IS NULL OR EXISTS(SELECT 1 FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id JOIN users author ON author.id=a.owner_id WHERE v.id=${campaign}.source_version_id AND author.deleted_at IS NULL AND a.status<>'archived' AND (v.audience='private' OR (a.visibility='public' AND a.published_snapshot IS NOT NULL AND EXISTS(SELECT 1 FROM game_playable_approvals ap WHERE ap.playable_version_id=v.id)))))`;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function hash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
@Injectable()
export class PlayableService {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Auth) private auth: Auth,
  ) {}
  async draft(req: Request, id: string) {
    const owner = await this.auth.require(req);
    if (
      !(
        await this.db.query('SELECT id FROM adventures WHERE id=$1 AND owner_id=$2', [id, owner.id])
      ).length
    )
      fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const row = (
      await this.db.query(
        'SELECT draft,revision FROM adventure_game_drafts WHERE adventure_id=$1',
        [id],
      )
    )[0];
    return row ?? { draft: null, revision: 0 };
  }
  /** A fresh author-owned sandbox only. Never reads a party's campaign or private history. */
  async previewNpc(req: Request, id: string, body: unknown) {
    const input = z
      .object({
        expectedRevision: z.number().int().positive(),
        npcId: z
          .string()
          .regex(/^[\w-]+$/)
          .max(100),
        ticks: z.number().int().min(0).max(120).default(20),
        actions: z.array(gameActionSchema).max(8).default([]),
      })
      .strict()
      .parse(body);
    const row = await this.draft(req, id);
    if (!row.draft || Number(row.revision) !== input.expectedRevision)
      fail(409, 'STALE_STATE', 'STALE_STATE');
    const compiled = compilePlayableDraft(row.draft);
    if (!compiled.playable) fail(400, 'INVALID_MAP', compiled.errors.join(';'));
    let state = createStateFromPlayable(compiled.playable!, ['preview-player'], 1);
    if (!state.npcBrains || !Object.hasOwn(state.npcBrains, input.npcId))
      fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const outcomes: { status: string; code?: string }[] = [];
    for (const [index, action] of input.actions.entries()) {
      const before = state,
        result = applyAction(state, 'preview-player', action);
      outcomes.push({
        status: result.error ? 'rejected' : 'committed',
        ...(result.error ? { code: result.error } : {}),
      });
      if (!result.error)
        state = recordNpcEvents(
          before,
          result.state,
          result.events,
          `preview-action-${index}`,
        ).state;
    }
    for (let step = 0; step < input.ticks; step++) {
      const before = state,
        next = tick(state, 1);
      state = recordNpcEvents(
        before,
        next.state,
        next.events,
        `preview-tick-${next.state.tick}`,
      ).state;
      if (state.rulesetVersion === 'hybrid-v3') {
        const beforeRoutine = state,
          routine = stepLivingNpcs(state);
        if (!routine.error)
          state = recordNpcEvents(
            beforeRoutine,
            routine.state,
            routine.events,
            `preview-routine-${state.tick}`,
          ).state;
        for (const npcId of Object.keys(state.npcBrains ?? {})) {
          const beforePlan = state,
            plan = stepNpcPlan(state, npcId);
          if (!plan.error)
            state = recordNpcEvents(
              beforePlan,
              plan.state,
              plan.events,
              `preview-plan-${npcId}-${state.tick}`,
            ).state;
        }
      }
    }
    return {
      sandbox: true,
      sourceRevision: Number(row.revision),
      npcId: input.npcId,
      tick: state.tick,
      rulesetVersion: state.rulesetVersion,
      outcomes,
      brain: state.npcBrains?.[input.npcId],
    };
  }
  async save(req: Request, id: string, body: unknown) {
    const input = z
        .object({
          expectedRevision: z.number().int().nonnegative(),
          draft: authoredGameDraftSchema,
        })
        .strict()
        .parse(body),
      user = await this.auth.require(req);
    const compiled = compilePlayableDraft(input.draft);
    if (!compiled.playable) fail(400, 'INVALID_MAP', compiled.errors.join(';'));
    const saved = await this.db.tx(async (c) => {
      const story = (
        await c.query('SELECT * FROM adventures WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
          id,
          user.id,
        ])
      ).rows[0];
      if (!story) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      await this.validateNpcReferences(c, user.id, input.draft);
      this.validateLocations(story, input.draft);
      const current = (
        await c.query(
          'SELECT revision FROM adventure_game_drafts WHERE adventure_id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (Number(current?.revision ?? 0) !== input.expectedRevision)
        fail(409, 'STALE_STATE', 'STALE_STATE');
      await c.query(
        'INSERT INTO adventure_game_drafts(adventure_id,revision,draft) VALUES($1,1,$2) ON CONFLICT(adventure_id) DO UPDATE SET revision=adventure_game_drafts.revision+1,draft=EXCLUDED.draft,updated_at=now()',
        [id, JSON.stringify(input.draft)],
      );
      // A changed map is a changed submission. Keep the last approved narrative/map live.
      await c.query(
        "UPDATE adventures SET status=CASE WHEN status='archived' THEN status ELSE 'draft' END,submitted_game_version_id=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
      return (
        await c.query('SELECT draft,revision FROM adventure_game_drafts WHERE adventure_id=$1', [
          id,
        ])
      ).rows[0];
    });
    return saved;
  }
  private validateLocations(
    story: Record<string, unknown>,
    draft: z.infer<typeof authoredGameDraftSchema>,
  ) {
    const data = story.data as { content?: { locations?: { id: string }[] } };
    const ids = new Set((data.content?.locations ?? []).map((l) => l.id));
    if (draft.maps.some((map) => map.sourceLocationId && !ids.has(map.sourceLocationId)))
      fail(400, 'INVALID_MAP', 'Unknown source location');
  }
  private async validateNpcReferences(
    c: PoolClient,
    ownerId: string,
    draft: z.infer<typeof authoredGameDraftSchema>,
  ) {
    const ids = [...new Set(draft.npcs.flatMap((n) => (n.sourceNpcId ? [n.sourceNpcId] : [])))];
    if (!ids.length) return;
    const rows = await c.query('SELECT id FROM npcs WHERE owner_id=$1 AND id=ANY($2::uuid[])', [
      ownerId,
      ids,
    ]);
    if (rows.rowCount !== ids.length) fail(403, 'FORBIDDEN', 'FORBIDDEN');
  }
  async freeze(
    c: PoolClient,
    story: Record<string, unknown>,
    audience: 'private' | 'review',
    expectedRevision?: number,
  ) {
    const row = (
      await c.query(
        'SELECT draft,revision FROM adventure_game_drafts WHERE adventure_id=$1 FOR UPDATE',
        [story.id],
      )
    ).rows[0];
    if (!row) {
      if (expectedRevision !== undefined) fail(409, 'NOT_PLAYABLE', 'NOT_PLAYABLE');
      return null;
    }
    if (expectedRevision !== undefined && expectedRevision !== Number(row.revision))
      fail(409, 'STALE_STATE', 'STALE_STATE');
    const draft = authoredGameDraftSchema.parse(row.draft),
      compiled = compilePlayableDraft(draft);
    if (!compiled.playable) fail(400, 'INVALID_MAP', compiled.errors.join(';'));
    await this.validateNpcReferences(c, String(story.owner_id), draft);
    this.validateLocations(story, draft);
    const ids = draft.npcs.flatMap((n) => (n.sourceNpcId ? [n.sourceNpcId] : []));
    const npcDefinitions = ids.length
      ? (
          await c.query('SELECT id,data FROM npcs WHERE owner_id=$1 AND id=ANY($2::uuid[])', [
            story.owner_id,
            ids,
          ])
        ).rows
      : [];
    const narrative = story.data as Record<string, unknown>;
    const payload = {
      schemaVersion: 1,
      compiled: compiled.playable,
      source: {
        title: story.title,
        sourceLanguage: narrative.sourceLanguage,
        sourceRevision: narrative.sourceRevision,
        content: narrative.content,
      },
      npcDefinitions,
    };
    const checksum = hash(payload);
    const previous = (
      await c.query(
        "SELECT id FROM game_playable_versions WHERE adventure_id=$1 AND source_revision=$2 AND audience=$3 AND checksum=$4 AND (audience='private' OR NOT EXISTS(SELECT 1 FROM game_playable_approvals ap WHERE ap.playable_version_id=game_playable_versions.id)) ORDER BY created_at DESC LIMIT 1",
        [story.id, row.revision, audience, checksum],
      )
    ).rows[0];
    if (previous) return String(previous.id);
    const count = (
      await c.query('SELECT count(*)::int AS n FROM game_playable_versions WHERE adventure_id=$1', [
        story.id,
      ])
    ).rows[0];
    if (count.n >= 100) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
    const versionId = randomUUID();
    await c.query(
      'INSERT INTO game_playable_versions(id,adventure_id,source_revision,audience,package,checksum) VALUES($1,$2,$3,$4,$5,$6)',
      [versionId, story.id, row.revision, audience, JSON.stringify(payload), checksum],
    );
    return versionId;
  }
  async compilePrivate(req: Request, id: string, body: unknown) {
    const { expectedRevision } = z
        .object({ expectedRevision: z.number().int().positive() })
        .strict()
        .parse(body),
      user = await this.auth.require(req);
    const versionId = await this.db.tx(async (c) => {
      const story = (
        await c.query(
          "SELECT * FROM adventures WHERE id=$1 AND owner_id=$2 AND status<>'archived' FOR UPDATE",
          [id, user.id],
        )
      ).rows[0];
      if (!story) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      return this.freeze(c, story, 'private', expectedRevision);
    });
    return { versionId };
  }
  async versions(req: Request, id: string, ownerOnly = false) {
    const user = await this.auth.require(req),
      story = (await this.db.query('SELECT * FROM adventures WHERE id=$1', [id]))[0];
    if (!story || (ownerOnly && story.owner_id !== user.id)) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const invited =
      (
        await this.db.query(
          "SELECT id FROM adventure_invitations WHERE adventure_id=$1 AND recipient_id=$2 AND status='accepted'",
          [id, user.id],
        )
      ).length > 0;
    const access =
      story.owner_id === user.id
        ? 'owner'
        : story.status === 'archived'
          ? null
          : story.visibility === 'private'
            ? invited
              ? 'invited'
              : null
            : story.published_snapshot
              ? 'public'
              : null;
    if (!access) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const rows = await this.db.query(
      'SELECT id,source_revision,audience,created_at FROM game_playable_versions WHERE adventure_id=$1 ORDER BY created_at DESC LIMIT 100',
      [id],
    );
    const published = (story.published_snapshot as Record<string, unknown> | null)
      ?.playableVersionId;
    return {
      versions: rows
        .filter(
          (r) =>
            story.owner_id === user.id ||
            (access === 'invited' && r.audience === 'private') ||
            (access === 'public' && r.id === published),
        )
        .map((r) => ({
          id: r.id,
          sourceRevision: r.source_revision,
          audience: r.audience,
          createdAt: r.created_at,
          approved: r.id === published,
        })),
    };
  }
  async review(req: Request, id: string) {
    const user = await this.auth.require(req);
    if (user.role !== 'admin') fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const row = (
      await this.db.query(
        "SELECT v.*,a.submitted_game_version_id FROM adventures a LEFT JOIN game_playable_versions v ON v.id=a.submitted_game_version_id AND v.adventure_id=a.id AND v.audience='review' WHERE a.id=$1 AND a.visibility='public' AND a.status='pending_review'",
        [id],
      )
    )[0];
    if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    if (!row.submitted_game_version_id)
      return { versionId: null, sourceRevision: null, compiled: null };
    if (!row.id) fail(503, 'RECOVERY_REQUIRED', 'RECOVERY_REQUIRED');
    if (hash(row.package) !== row.checksum) fail(503, 'RECOVERY_REQUIRED', 'RECOVERY_REQUIRED');
    const p = row.package.compiled as PlayablePackage;
    return {
      versionId: row.id,
      sourceRevision: row.source_revision,
      compiled: {
        schemaVersion: p.schemaVersion,
        rulesetVersion: p.rulesetVersion,
        title: p.title,
        startMapId: p.startMapId,
        maps: p.maps,
        roundPolicy: p.roundPolicy,
        npcPolicy: p.rulesetVersion === 'hybrid-v3' ? 'reactive-v1' : null,
        npcProfiles: Object.entries(p.npcBrains ?? {}).map(([npcId, brain]) => ({
          npcId,
          personality: brain.living?.personality ?? null,
          initialKnowledge: brain.living?.observations.filter((o) => o.tick === 0) ?? [],
          initialGoal: brain.living?.goal.kind ?? brain.goal,
          patrolTarget: brain.patrolTarget,
        })),
        assetManifest: p.assetManifest,
        entities: Object.fromEntries(
          Object.entries(p.entities).map(([key, e]) => [
            key,
            {
              id: e.id,
              kind: e.kind,
              label: e.label,
              visual: e.visual,
              mapId: e.mapId,
              x: e.x,
              y: e.y,
              locked: e.locked,
              open: e.open,
              keyId: e.keyId,
              ownerId: e.ownerId,
            },
          ]),
        ),
      },
    };
  }
  async resolveForStart(
    c: PoolClient,
    userId: string,
    versionId: string,
    actorId: string,
    seed: number,
  ) {
    const row = (
      await c.query(
        'SELECT v.*,a.owner_id,a.visibility,a.status,a.published_snapshot FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id JOIN users u ON u.id=a.owner_id WHERE v.id=$1 AND u.deleted_at IS NULL FOR SHARE OF a',
        [versionId],
      )
    ).rows[0];
    if (!row || row.status === 'archived') fail(404, 'NOT_FOUND', 'NOT_FOUND');
    if (row.audience === 'private') {
      if (row.owner_id !== userId) {
        const invitation = await c.query(
          "SELECT id FROM adventure_invitations WHERE adventure_id=$1 AND recipient_id=$2 AND status='accepted'",
          [row.adventure_id, userId],
        );
        if (row.visibility !== 'private' || !invitation.rowCount)
          fail(403, 'FORBIDDEN', 'FORBIDDEN');
      }
    } else {
      const approval = await c.query(
        'SELECT playable_version_id FROM game_playable_approvals WHERE playable_version_id=$1',
        [versionId],
      );
      if (
        row.visibility !== 'public' ||
        !approval.rowCount ||
        row.published_snapshot?.playableVersionId !== versionId
      )
        fail(403, 'FORBIDDEN', 'FORBIDDEN');
    }
    if (hash(row.package) !== row.checksum) fail(503, 'RECOVERY_REQUIRED', 'RECOVERY_REQUIRED');
    return createStateFromPlayable(row.package.compiled, [actorId], seed);
  }
}
