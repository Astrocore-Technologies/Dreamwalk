import { schematicStorySource, playableMapBindings } from './story-map-mode';
import { AuthoringTextEngine } from '../live-test/authoring-text';
import { prepareStoryMapImages } from './story-map-images';
import { compileStoryPlan, type StoryPlanSource } from './story-plan';
import { ownedCharacterPackage } from '../visual-authoring/character-package';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  authoredGameDraftSchema,
  fixedMapExtentsAllowed,
  gameActionSchema,
  contentSchema,
  npcSchema,
  validateStoryLoreReferences,
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

export { sourceAccessSql, sourceLiveSql } from './source-access';
import { AssetReuseService } from '../assets/reuse.service';
import { applyAuthoredCharacters } from './character-authoring';
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
    @Inject(AssetReuseService) private art: AssetReuseService,
    @Optional() @Inject('STORY_BUILD_ENGINE') private storyEngine?: AuthoringTextEngine,
  ) {}
  async lockAuthor(c: PoolClient, userId: string) {
    return this.art.lockAuthor(c, userId);
  }
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
    return { ...this.simulateNpc(compiled.playable!, input), sourceRevision: Number(row.revision) };
  }
  async reviewNpc(req: Request, id: string, body: unknown) {
    const user = await this.auth.require(req);
    if (user.role !== 'admin') fail(404, 'NOT_FOUND', 'NOT_FOUND');
    const input = z
      .object({
        versionId: z.uuid(),
        npcId: z
          .string()
          .regex(/^[\w-]+$/)
          .max(100),
        ticks: z.number().int().min(0).max(120).default(20),
        actions: z.array(gameActionSchema).max(8).default([]),
      })
      .strict()
      .parse(body);
    const row = (
      await this.db.query(
        "SELECT v.* FROM adventures a JOIN game_playable_versions v ON v.id=a.submitted_game_version_id AND v.adventure_id=a.id WHERE a.id=$1 AND v.id=$2 AND a.status='pending_review' AND a.visibility='public' AND v.audience='review'",
        [id, input.versionId],
      )
    )[0];
    if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
    if (hash(row.package) !== row.checksum) fail(503, 'RECOVERY_REQUIRED', 'RECOVERY_REQUIRED');
    if (!row.package.compiled)
      fail(409, 'START_PREPARATION_REQUIRED', 'START_PREPARATION_REQUIRED');
    return {
      ...this.simulateNpc(row.package.compiled as PlayablePackage, input),
      versionId: row.id,
      sourceRevision: Number(row.source_revision),
      review: true,
    };
  }
  private simulateNpc(
    playable: PlayablePackage,
    input: { npcId: string; ticks: number; actions: z.infer<typeof gameActionSchema>[] },
  ) {
    let state = createStateFromPlayable(playable, ['preview-player'], 1);
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
      await this.validateNpcReferences(c, user.id, input.draft, id);
      this.validateLocations(story, input.draft);
      const current = (
        await c.query(
          'SELECT revision,draft FROM adventure_game_drafts WHERE adventure_id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (Number(current?.revision ?? 0) !== input.expectedRevision)
        fail(409, 'STALE_STATE', 'STALE_STATE');
      const prior = authoredGameDraftSchema.safeParse(current?.draft);
      if (!fixedMapExtentsAllowed(input.draft.maps, prior.success ? prior.data.maps : []))
        fail(400, 'INVALID_MAP', 'New maps must use the fixed 24x24 extent');
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
    storyId: string,
  ) {
    const ids = [...new Set(draft.npcs.flatMap((n) => (n.sourceNpcId ? [n.sourceNpcId] : [])))];
    if (!ids.length) return;
    const rows = await c.query(
      'SELECT id FROM npcs WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND (story_id IS NULL OR story_id=$3)',
      [ownerId, ids, storyId],
    );
    if (rows.rowCount !== ids.length) fail(403, 'FORBIDDEN', 'FORBIDDEN');
  }
  async freeze(
    c: PoolClient,
    story: Record<string, unknown>,
    audience: 'private' | 'review',
    expectedRevision?: number,
    expectedArtRevision?: number,
  ) {
    const row = (
      await c.query(
        'SELECT draft,revision FROM adventure_game_drafts WHERE adventure_id=$1 FOR UPDATE',
        [story.id],
      )
    ).rows[0];
    if (!row) {
      if (expectedRevision !== undefined && expectedRevision !== 0)
        fail(409, 'STALE_STATE', 'STALE_STATE');
      return this.freezeLaunchSource(c, story, audience, expectedArtRevision);
    }
    if (expectedRevision !== undefined && expectedRevision !== Number(row.revision))
      fail(409, 'STALE_STATE', 'STALE_STATE');
    const draft = authoredGameDraftSchema.parse(row.draft);
    const currentContent = contentSchema.parse((story.data as Record<string, unknown>).content);
    const sameIds = (a: string[], b: string[]) =>
      JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
    const linkedLocations = draft.maps.flatMap((m) =>
      m.sourceLocationId ? [m.sourceLocationId] : [],
    );
    const linkedNpcs = draft.npcs.flatMap((n) => (n.sourceNpcId ? [n.sourceNpcId] : []));
    // Standalone legacy maps were authored independently of the narrative wizard.
    // Do not replace their reviewed mechanics/objectives merely because no source links exist.
    const previousNpcIds =
      (
        await c.query(
          "SELECT package->'source'->'content'->'npcIds' AS ids FROM game_playable_versions WHERE adventure_id=$1 ORDER BY created_at DESC LIMIT 1",
          [story.id],
        )
      ).rows[0]?.ids ?? [];
    const changedLinkedLocations =
      linkedLocations.length > 0 &&
      !sameIds(
        linkedLocations,
        currentContent.locations.map((l) => l.id),
      );
    const changedLinkedNpcs =
      linkedLocations.length > 0 &&
      (currentContent.npcIds.length > 0 || previousNpcIds.length > 0) &&
      !sameIds(linkedNpcs, currentContent.npcIds);
    if (changedLinkedLocations || changedLinkedNpcs)
      return this.freezeLaunchSource(c, story, audience, expectedArtRevision, draft);
    await this.validateNpcReferences(c, String(story.owner_id), draft, String(story.id));
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
    const content = contentSchema.parse(narrative.content ?? {});
    if (!validateStoryLoreReferences(content))
      fail(400, 'VALIDATION_FAILED', 'INVALID_LORE_REFERENCE');
    applyAuthoredCharacters(
      draft,
      npcDefinitions.map((row) => ({
        id: String(row.id),
        characterProfile: npcSchema.parse(row.data).characterProfile,
      })),
      content.lorebook,
    );
    const compiled = compilePlayableDraft(authoredGameDraftSchema.parse(draft));
    if (!compiled.playable) fail(400, 'INVALID_MAP', compiled.errors.join(';'));
    for (const map of draft.maps) {
      const description = content.locations?.find(
        (l) => l.id === map.sourceLocationId,
      )?.description;
      if (description) compiled.playable!.maps[map.id].description = description;
    }
    const characterBindings: { slot: string; revisionId: string }[] = [];
    for (const npc of draft.npcs) {
      const source = npcDefinitions.find((row) => row.id === npc.sourceNpcId)?.data as
        | {
            role?: string;
            description?: string;
            appearance?: string;
            personality?: string;
            biography?: string;
            characterProfile?: unknown;
            characterPackageVersionId?: string;
          }
        | undefined;
      if (!source) continue;
      if (source.characterPackageVersionId) {
        const { manifest } = await ownedCharacterPackage(
          c,
          String(story.owner_id),
          source.characterPackageVersionId,
        );
        compiled.playable!.entities[npc.id].characterAnimation = manifest.animation;
        for (const part of manifest.parts.filter((p) =>
          ['sheet', 'sprite', 'portrait'].includes(p.role),
        ))
          characterBindings.push({
            slot: `entity:${npc.id}:${part.role === 'portrait' ? 'portrait' : 'sprite'}`,
            revisionId: part.revisionId,
          });
      }
      compiled.playable!.entities[npc.id].publicProfile = {
        role: (source.role ?? '').slice(0, 120),
        description: (source.description ?? '').slice(0, 4000),
        appearance: (source.appearance ?? '').slice(0, 4000),
      };
      const memory = compiled.playable!.npcBrains[npc.id].living;
      if (memory && (!source.characterProfile || memory.personality.biography === undefined))
        memory.personality.biography = [source.personality, source.biography]
          .filter(Boolean)
          .join('\n')
          .slice(0, 2000);
    }

    compiled.playable!.narrativePremise = {
      rules: content.rules ?? '',
      boundaries: content.boundaries ?? [],
      openingScene:
        content.scenes?.find((scene) => scene.id === content.startSceneId)?.description ?? '',
      title: String(story.title),
      summary: String(story.synopsis ?? ''),
      world: String((narrative.content as { world?: unknown } | undefined)?.world ?? ''),
      genre: String(story.genre ?? ''),
    };

    const preparedArt = await this.art.prepareManifestTx(
      c,
      String(story.id),
      String(story.owner_id),
      compiled.playable!,
      characterBindings,
    );
    if (expectedArtRevision !== undefined && preparedArt.draftRevision !== expectedArtRevision)
      fail(409, 'STALE_ART_REVISION', 'STALE_ART_REVISION');
    if (preparedArt.bindings.length)
      compiled.playable!.artBindings = playableMapBindings(
        preparedArt.bindings,
        compiled.playable!.maps,
      );
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
    if (previous) {
      await this.art.pinPrepared(c, String(previous.id), preparedArt);
      return String(previous.id);
    }
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
    await this.art.pinPrepared(c, versionId, preparedArt);
    return versionId;
  }
  private async freezeLaunchSource(
    c: PoolClient,
    story: Record<string, unknown>,
    audience: 'private' | 'review',
    expectedArtRevision?: number,
    priorDraft?: z.infer<typeof authoredGameDraftSchema>,
  ) {
    const narrative = story.data as Record<string, unknown>;
    const content = contentSchema.parse(narrative.content);
    if (
      !content.locations.length ||
      new Set(content.locations.map((l) => l.id)).size !== content.locations.length ||
      new Set(content.npcIds).size !== content.npcIds.length ||
      content.locations.length > 4 ||
      content.npcIds.length > 8 ||
      !validateStoryLoreReferences(content)
    )
      fail(400, 'STORY_PLAN_CAPACITY', 'STORY_PLAN_CAPACITY');
    const npcDefinitions = content.npcIds.length
      ? (
          await c.query(
            'SELECT id,data FROM npcs WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND (story_id IS NULL OR story_id=$3) ORDER BY id FOR SHARE',
            [story.owner_id, content.npcIds, story.id],
          )
        ).rows
      : [];
    if (npcDefinitions.length !== new Set(content.npcIds).size) fail(403, 'FORBIDDEN', 'FORBIDDEN');
    const additionalBindings: { slot: string; revisionId: string }[] = [];
    const animations: Record<string, unknown> = {};
    for (const n of npcDefinitions) {
      const data = npcSchema.parse(n.data);
      if (data.characterPackageVersionId) {
        const { manifest } = await ownedCharacterPackage(
          c,
          String(story.owner_id),
          data.characterPackageVersionId,
        );
        if (manifest.animation) animations[n.id] = manifest.animation;
        for (const part of manifest.parts.filter((p) =>
          ['sheet', 'sprite', 'portrait'].includes(p.role),
        ))
          additionalBindings.push({
            slot: `entity:${n.id}:${part.role === 'portrait' ? 'portrait' : 'sprite'}`,
            revisionId: part.revisionId,
          });
      }
    }
    const images = (
      await c.query(
        'SELECT location_id,revision_id FROM studio_location_images WHERE adventure_id=$1 AND owner_id=$2 ORDER BY location_id',
        [story.id, story.owner_id],
      )
    ).rows;
    for (const image of images) {
      if (!content.locations.some((l) => l.id === image.location_id)) continue;
      additionalBindings.push({
        slot: `map:${image.location_id}:background`,
        revisionId: image.revision_id,
      });
    }
    const aliases: Record<string, string | null> = {};
    for (const map of priorDraft?.maps ?? []) {
      if (map.sourceLocationId)
        aliases[`map:${map.id}:background`] = content.locations.some(
          (l) => l.id === map.sourceLocationId,
        )
          ? `map:${map.sourceLocationId}:background`
          : null;
    }
    for (const npc of priorDraft?.npcs ?? []) {
      if (npc.sourceNpcId)
        for (const variant of ['sprite', 'portrait'])
          aliases[`entity:${npc.id}:${variant}`] = content.npcIds.includes(npc.sourceNpcId)
            ? `entity:${npc.sourceNpcId}:${variant}`
            : null;
    }
    const preparedArt = await this.art.prepareLaunchManifestTx(
      c,
      String(story.id),
      String(story.owner_id),
      content.locations.map((l) => l.id),
      content.npcIds,
      additionalBindings,
      aliases,
    );
    if (
      expectedArtRevision !== undefined &&
      Number(preparedArt.draftRevision) !== expectedArtRevision
    )
      fail(409, 'STALE_ART_REVISION', 'STALE_ART_REVISION');
    const mapImages = await prepareStoryMapImages(
      c,
      this.art,
      String(story.owner_id),
      preparedArt.bindings.flatMap((b) => {
        const l = content.locations.find((l) => b.slot === `map:${l.id}:background`);
        return l ? [{ location_id: l.id, revision_id: b.revisionId }] : [];
      }),
    );
    const plannerSource: StoryPlanSource = {
      ...(mapImages.length ? { mapImages } : {}),
      priorDraft,
      title: String(story.title),
      synopsis: String(story.synopsis ?? ''),
      content,
      npcs: npcDefinitions.map((n) => ({
        id: n.id,
        name: n.data.name,
        role: n.data.role ?? '',
        description: n.data.description ?? '',
        appearance: n.data.appearance ?? '',
        characterProfile: n.data.characterProfile ?? null,
      })),
    };
    const payload = {
      schemaVersion: 2,
      kind: 'launch-source',
      compiled: null,
      plannerSource,
      npcDefinitions,
      animations,
      sourceArtBindings: preparedArt.bindings,
      source: {
        title: story.title,
        sourceLanguage: narrative.sourceLanguage,
        sourceRevision: narrative.sourceRevision,
        content,
      },
      narrativePremise: {
        title: String(story.title),
        summary: String(story.synopsis ?? ''),
        world: content.world ?? '',
        genre: String(story.genre ?? ''),
        rules: content.rules ?? '',
        boundaries: content.boundaries ?? [],
        openingScene: content.scenes.find((x) => x.id === content.startSceneId)?.description ?? '',
      },
    };
    const checksum = hash(payload),
      revision = Number(story.edit_revision);
    const previous = (
      await c.query(
        "SELECT id FROM game_playable_versions WHERE adventure_id=$1 AND source_revision=$2 AND audience=$3 AND checksum=$4 AND (audience='private' OR NOT EXISTS(SELECT 1 FROM game_playable_approvals ap WHERE ap.playable_version_id=game_playable_versions.id)) ORDER BY created_at DESC LIMIT 1",
        [story.id, revision, audience, checksum],
      )
    ).rows[0];
    const versionId = previous?.id ?? randomUUID();
    if (!previous) {
      const count = (
        await c.query(
          'SELECT count(*)::int AS n FROM game_playable_versions WHERE adventure_id=$1',
          [story.id],
        )
      ).rows[0];
      if (count.n >= 100) fail(429, 'RATE_LIMITED', 'RATE_LIMITED');
      await c.query(
        'INSERT INTO game_playable_versions(id,adventure_id,source_revision,audience,package,checksum) VALUES($1,$2,$3,$4,$5,$6)',
        [versionId, story.id, revision, audience, JSON.stringify(payload), checksum],
      );
    }
    await this.art.pinPrepared(c, versionId, preparedArt);
    return String(versionId);
  }

  compileLaunchPlan(
    sourcePackage: {
      plannerSource: StoryPlanSource;
      sourceArtBindings?: PlayablePackage['artBindings'];
      narrativePremise?: PlayablePackage['narrativePremise'];
      animations?: Record<string, unknown>;
      npcDefinitions?: { id: string; data: Record<string, unknown> }[];
    },
    proposal: unknown,
  ) {
    const checked = compileStoryPlan(sourcePackage.plannerSource, proposal);
    checked.playable.artBindings = playableMapBindings(
      sourcePackage.sourceArtBindings ?? [],
      checked.playable.maps,
    );
    checked.playable.narrativePremise = sourcePackage.narrativePremise;
    for (const npc of sourcePackage.npcDefinitions ?? []) {
      const memory = checked.playable.npcBrains[npc.id]?.living;
      if (memory && (!npc.data.characterProfile || memory.personality.biography === undefined))
        memory.personality.biography = [npc.data.personality, npc.data.biography]
          .filter(Boolean)
          .join('\n')
          .slice(0, 2000);
    }
    for (const [id, animation] of Object.entries(sourcePackage.animations ?? {})) {
      if (!checked.playable.entities[id])
        fail(409, 'STORY_SOURCE_MISMATCH', 'STORY_SOURCE_MISMATCH');
      checked.playable.entities[id].characterAnimation = animation as NonNullable<
        PlayablePackage['entities'][string]['characterAnimation']
      >;
    }
    return checked.playable;
  }
  async compilePrivate(req: Request, id: string, body: unknown) {
    const { expectedRevision, expectedArtRevision } = z
        .object({
          expectedRevision: z.number().int().positive(),
          expectedArtRevision: z.number().int().nonnegative().optional(),
        })
        .strict()
        .parse(body),
      user = await this.auth.require(req);
    const versionId = await this.db.tx(async (c) => {
      await this.lockAuthor(c, user.id);
      const story = (
        await c.query(
          "SELECT * FROM adventures WHERE id=$1 AND owner_id=$2 AND status<>'archived' FOR UPDATE",
          [id, user.id],
        )
      ).rows[0];
      if (!story) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      return this.freeze(c, story, 'private', expectedRevision, expectedArtRevision);
    });
    return { versionId };
  }
  async versions(req: Request, id: string, ownerOnly = false) {
    const user = await this.auth.require(req),
      story = (
        await this.db.query(
          'SELECT a.*,(SELECT playable_version_id FROM adventure_private_releases r WHERE r.id=a.private_release_id) AS private_playable_id FROM adventures a WHERE a.id=$1',
          [id],
        )
      )[0];
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
            ? invited && story.private_release_id
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
            (access === 'invited' && r.id === story.private_playable_id) ||
            (access === 'public' && r.id === published),
        )
        .map((r) => ({
          id: r.id,
          sourceRevision: r.source_revision,
          audience: r.audience,
          createdAt: r.created_at,
          approved: r.id === published || r.id === story.private_playable_id,
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
    if (!row.package.compiled)
      return {
        versionId: row.id,
        sourceRevision: row.source_revision,
        compiled: null,
        preparationRequired: true,
        sourceArtBindings: row.package.sourceArtBindings ?? [],
        sourceSummary: {
          title: row.package.plannerSource.title,
          locations: row.package.plannerSource.content.locations.map(
            (l: { id: string; name: string; description: string }) => ({
              id: l.id,
              name: l.name,
              description: l.description,
            }),
          ),
          npcs: row.package.plannerSource.npcs.map(
            (n: { id: string; name: string; role: string; description: string }) => ({
              id: n.id,
              name: n.name,
              role: n.role,
              description: n.description,
            }),
          ),
        },
      };
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
        objectives: p.objectives ?? [],
        npcPolicy: p.rulesetVersion === 'hybrid-v3' ? 'reactive-v1' : null,
        npcProfiles: Object.entries(p.npcBrains ?? {}).map(([npcId, brain]) => ({
          npcId,
          personality: brain.living?.personality ?? null,
          initialKnowledge: brain.living?.observations.filter((o) => o.tick === 0) ?? [],
          initialFacts: brain.living?.observations.filter((o) => o.kind === 'authored_fact') ?? [],
          initialGoals: brain.living?.goalDefinitions ?? [],
          promiseTemplates: brain.living?.promiseTemplates ?? [],
          initialGoal: brain.living?.goal.kind ?? brain.goal,
          patrolTarget: brain.patrolTarget,
        })),
        assetManifest: p.assetManifest,
        artBindings: p.artBindings ?? [],
        entities: Object.fromEntries(
          Object.entries(p.entities).map(([key, e]) => [
            key,
            {
              id: e.id,
              kind: e.kind,
              label: e.label,
              labelTranslations: e.labelTranslations,
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
  async sourceForStart(c: PoolClient, userId: string, versionId: string) {
    const row = (
      await c.query(
        'SELECT v.*,a.owner_id,a.visibility,a.status,a.published_snapshot,a.private_release_id,EXISTS(SELECT 1 FROM adventure_private_releases pr WHERE pr.playable_version_id=v.id AND pr.id=a.private_release_id) AS privately_released FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id JOIN users u ON u.id=a.owner_id WHERE v.id=$1 AND u.deleted_at IS NULL FOR SHARE OF a',
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
        if (
          row.visibility !== 'private' ||
          !row.private_release_id ||
          !row.privately_released ||
          !invitation.rowCount
        )
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
    await this.art.assertPinsAvailable(c, versionId);
    // Upgrade old uncompiled immutable sources in memory only; existing live/compiled maps stay untouched.
    if (
      row.package.kind === 'launch-source' &&
      !row.package.compiled &&
      !row.package.plannerSource.mapImages
    ) {
      const source = row.package.plannerSource as StoryPlanSource;
      const bindings = (row.package.sourceArtBindings ?? []) as {
        slot: string;
        revisionId: string;
      }[];
      const images = bindings.flatMap((b) => {
        const l = source.content.locations.find((l) => b.slot === `map:${l.id}:background`);
        return l ? [{ location_id: l.id, revision_id: b.revisionId }] : [];
      });
      if (images.length) {
        const mapImages = await prepareStoryMapImages(c, this.art, String(row.owner_id), images);
        const upgraded = { ...row.package, plannerSource: { ...source, mapImages } };
        row.package = upgraded;
        row.checksum = hash(upgraded);
      }
    }
    if (row.package.kind === 'launch-source' && !row.package.compiled) {
      const plannerSource = schematicStorySource(
        row.package.plannerSource,
        this.storyEngine?.provider.profile,
      );
      if (plannerSource !== row.package.plannerSource) {
        const adapted = { ...row.package, plannerSource };
        return { ...row, package: adapted, checksum: hash(adapted) };
      }
    }
    return row;
  }
  async resolveForStart(
    c: PoolClient,
    userId: string,
    versionId: string,
    actorId: string,
    seed: number,
    prepared?: PlayablePackage,
  ) {
    const row = await this.sourceForStart(c, userId, versionId);
    const compiled = row.package.compiled ?? prepared;
    if (!compiled) fail(409, 'START_PREPARATION_REQUIRED', 'START_PREPARATION_REQUIRED');
    const state = createStateFromPlayable(compiled, [actorId], seed);
    state.narrativeSource = { versionId: row.id, checksum: row.checksum };
    if (!state.narrativePremise) {
      const published = (
        await c.query(
          'SELECT av.snapshot FROM game_playable_approvals ap JOIN adventure_versions av ON av.id=ap.adventure_version_id WHERE ap.playable_version_id=$1',
          [row.id],
        )
      ).rows[0]?.snapshot;
      state.narrativePremise = {
        title: String(row.package.source?.title ?? compiled.title ?? ''),
        summary: String(published?.synopsis ?? ''),
        world: String(row.package.source?.content?.world ?? ''),
        genre: String(published?.genre ?? ''),
      };
    }
    return state;
  }
}
