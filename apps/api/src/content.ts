import { remapSceneParticipants } from './story-authoring/scene-participants';
import { remapCopiedCharacterProfile, remapCopiedStoryLore } from './game/character-authoring';
import { ownedCharacterPackage } from './visual-authoring/character-package';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  adventureSchema,
  heroSchema,
  npcSchema,
  npcTextFields,
  npcTranslationSchema,
  safeNpcMetadata,
  parsePatch,
  type Adventure,
  type User,
  type Locale,
  type MetadataTranslations,
  localeSchema,
  safeAdventureMetadata,
  readerStoryContent,
  validateStoryLoreReferences,
} from '@dreamwalk/contracts';
import { Db, camel } from './db';
import { Auth } from './auth';
import { fail } from './errors';
import { PlayableService } from './game/playable.service';
const expectedEditRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional();
function draftPatch(body: unknown) {
  const { expectedEditRevision, ...patch } = z
    .object({ expectedEditRevision: expectedEditRevisionSchema })
    .passthrough()
    .parse(body);
  return { expectedEditRevision, patch };
}
function checkEditRevision(row: Record<string, unknown>, expected: number | undefined) {
  if (expected !== undefined && Number(row.edit_revision) !== expected)
    fail(409, 'STALE_STATE', 'Draft changed in another editor. Reload before saving.');
}
export const publicAdventureSql =
  "a.visibility='public' AND a.published_snapshot IS NOT NULL AND a.status<>'archived' AND EXISTS(SELECT 1 FROM users public_owner WHERE public_owner.id=a.owner_id AND public_owner.deleted_at IS NULL)";
// Separate correlated aggregates avoid multiplying rounds by likes or party members.
// Only approved source versions contribute; private/draft playtests remain private.
export const adventureSelect = `SELECT a.*,(SELECT r.snapshot FROM adventure_private_releases r WHERE r.id=a.private_release_id) AS private_snapshot,u.name AS author_name,u.handle AS author_handle,
  (SELECT count(*)::int FROM favorites f WHERE f.adventure_id=a.id) AS favorite_count,
  CASE WHEN ${publicAdventureSql} THEN (SELECT count(*)::int FROM adventure_likes l JOIN users liker ON liker.id=l.user_id AND liker.deleted_at IS NULL WHERE l.adventure_id=a.id) ELSE 0 END AS like_count,
  CASE WHEN ${publicAdventureSql} THEN (SELECT count(*)::int FROM game_playable_versions v
    JOIN game_playable_approvals approval ON approval.playable_version_id=v.id
    JOIN game_campaigns c ON c.source_version_id=v.id
    JOIN users player ON player.id=c.owner_id AND player.deleted_at IS NULL
    JOIN game_events e ON e.campaign_id=c.id AND e.kind IN ('turn.world.completed','round.resolved') AND e.created_at>=approval.approved_at
    WHERE v.adventure_id=a.id) ELSE 0 END AS total_rounds
  FROM adventures a JOIN users u ON u.id=a.owner_id`;
export const readableAdventureSql = (userParameter: string) =>
  `(a.owner_id=${userParameter} OR (${publicAdventureSql}) OR (a.visibility='private' AND a.private_release_id IS NOT NULL AND a.status<>'archived' AND EXISTS(SELECT 1 FROM adventure_invitations i WHERE i.adventure_id=a.id AND i.recipient_id=${userParameter} AND i.status='accepted')))`;
export function adventureView(
  row: Record<string, unknown>,
  usePublished = false,
  reader = false,
  publicReview = false,
): Adventure {
  const released = row.visibility === 'private' ? row.private_snapshot : row.published_snapshot;
  const snapshot = usePublished && released ? released : null;
  const data = (snapshot ?? row.data) as Record<string, unknown>;
  const metadata = {
    title: (snapshot ? data.title : row.title) as string,
    synopsis: (snapshot ? data.synopsis : row.synopsis) as string,
    sourceLanguage: (data.sourceLanguage ?? 'ru') as Locale,
    sourceRevision: Number(data.sourceRevision ?? 1),
    translations: (data.translations ?? {}) as MetadataTranslations,
  };
  const exposedMetadata = usePublished || reader ? safeAdventureMetadata(metadata) : metadata;
  const readerView = (usePublished || reader) && !publicReview;
  // Published snapshots are storage, not public DTOs. Project legacy releases on
  // every read; never spread private author prose or future unknown fields.
  const exposedData = readerView
    ? {
        genre: data.genre,
        tags: data.tags,
        cover: data.cover,
        coverAssetId: data.coverAssetId,
        playersMin: data.playersMin,
        playersMax: data.playersMax,
        duration: data.duration,
        difficulty: data.difficulty,
      }
    : data;
  return {
    ...exposedData,
    ...(readerView
      ? {
          content: {
            world: '',
            rules: '',
            locations: [],
            npcIds: [],
            scenes: [],
            startSceneId: '',
            boundaries: [],
          },
        }
      : {}),
    ...(publicReview && data.content
      ? { content: readerStoryContent(data.content as Record<string, unknown>) }
      : {}),
    ...exposedMetadata,
    id: row.id,
    ownerId: row.owner_id,
    slug: row.slug,
    title: snapshot ? data.title : row.title,
    synopsis: snapshot ? data.synopsis : row.synopsis,
    genre: snapshot ? data.genre : row.genre,
    status: snapshot ? 'published' : row.status,
    visibility: row.visibility,
    version: row.version,
    editRevision: !usePublished && !reader ? Number(row.edit_revision ?? 1) : undefined,
    author: { name: row.author_name, handle: row.author_handle },
    playableVersionId: (usePublished
      ? data.playableVersionId
      : (released as Record<string, unknown> | null)?.playableVersionId) as
      string | null | undefined,
    favoriteCount: row.favorite_count ?? 0,
    likeCount: row.like_count ?? 0,
    totalRounds: row.total_rounds ?? 0,
    likedByMe: row.liked_by_me === true,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  } as Adventure;
}
function entityView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(row.data as Record<string, unknown>),
    id: row.id,
    ...(row.edit_revision === undefined ? {} : { editRevision: Number(row.edit_revision) }),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}
@Injectable()
export class Content {
  constructor(
    @Inject(Db)
    readonly db: Db,
    @Inject(Auth)
    readonly auth: Auth,
  ) {}
  async own(id: string, userId: string) {
    const rows = await this.db.query(adventureSelect + ' WHERE a.id=$1 AND a.owner_id=$2', [
      id,
      userId,
    ]);
    return rows[0] ?? fail(404, 'NOT_FOUND', 'Приключение не найдено.');
  }
  async access(
    row: Record<string, unknown>,
    user: User | null,
  ): Promise<'owner' | 'invited' | 'public' | 'reviewer' | null> {
    if (user?.id === row.owner_id) return 'owner';
    if (row.status === 'archived') return null;
    if (row.visibility === 'public') {
      if (user?.role === 'admin' && row.status === 'pending_review') return 'reviewer';
      return row.published_snapshot ? 'public' : null;
    }
    if (!user || !row.private_release_id) return null;
    const invites = await this.db.query(
      "SELECT id FROM adventure_invitations WHERE adventure_id=$1 AND recipient_id=$2 AND status='accepted'",
      [row.id, user.id],
    );
    return invites.length ? 'invited' : null;
  }
  async validateReferences(
    userId: string,
    data: z.infer<typeof adventureSchema>,
    publish = false,
    storyId?: string,
  ) {
    await this.auth.ownedAsset(userId, data.coverAssetId);
    if (data.playersMin > data.playersMax)
      fail(400, 'VALIDATION_FAILED', 'Минимум игроков не может превышать максимум.');
    const c = data.content;
    if (!validateStoryLoreReferences(c)) fail(400, 'VALIDATION_FAILED', 'INVALID_LORE_REFERENCE');
    if (
      new Set(c.locations.map((x) => x.id)).size !== c.locations.length ||
      new Set(c.scenes.map((x) => x.id)).size !== c.scenes.length
    )
      fail(400, 'VALIDATION_FAILED', 'Идентификаторы локаций и сцен должны быть уникальны.');
    for (const scene of c.scenes)
      if (!c.locations.some((l) => l.id === scene.locationId))
        fail(400, 'VALIDATION_FAILED', 'Сцена ссылается на отсутствующую локацию.');
    if (c.startSceneId && !c.scenes.some((s) => s.id === c.startSceneId))
      fail(400, 'VALIDATION_FAILED', 'Стартовая сцена не найдена.');
    if (c.npcIds.length) {
      const rows = await this.db.query(
        'SELECT id FROM npcs WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND (story_id IS NULL OR story_id=$3)',
        [c.npcIds, userId, storyId ?? null],
      );
      if (rows.length !== new Set(c.npcIds).size)
        fail(403, 'FORBIDDEN', 'Можно использовать только своих NPC.');
    }
    if (
      publish &&
      (!data.synopsis.trim() ||
        !c.world.trim() ||
        !c.locations.length ||
        !c.scenes.length ||
        !c.startSceneId)
    )
      fail(
        400,
        'VALIDATION_FAILED',
        'Заполните описание, мир, локацию и стартовую сцену перед публикацией.',
      );
  }
  async save(id: string, userId: string, body: unknown) {
    const input = draftPatch(body);
    const patch = parsePatch(adventureSchema.partial(), input.patch);
    if (patch.status && ['published', 'pending_review'].includes(patch.status))
      fail(403, 'FORBIDDEN', 'Для публикации отправьте историю на модерацию.');
    const saved = await this.db.tx(async (c) => {
      const old = (
        await c.query('SELECT * FROM adventures WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
          id,
          userId,
        ])
      ).rows[0];
      if (!old) fail(404, 'NOT_FOUND', 'Приключение не найдено.');
      checkEditRevision(old, input.expectedEditRevision);
      const data = adventureSchema.parse({
        ...old.data,
        status: old.status,
        visibility: old.visibility,
        ...patch,
        sourceRevision: Number(old.data.sourceRevision ?? 1),
        translations: old.data.translations ?? {},
      });
      if (
        data.title !== old.title ||
        data.synopsis !== old.synopsis ||
        data.sourceLanguage !== (old.data.sourceLanguage ?? 'ru') ||
        JSON.stringify(data.tags) !== JSON.stringify(old.data.tags ?? [])
      )
        data.sourceRevision++;
      if (
        (old.status === 'published' || old.status === 'pending_review') &&
        patch.status === undefined
      )
        data.status = 'draft';
      if (data.visibility !== old.visibility && data.status !== 'archived') data.status = 'draft';
      await this.validateReferences(userId, data, false, id);
      await c.query(
        'UPDATE adventures SET title=$2,synopsis=$3,genre=$4,status=$5,data=$6,visibility=$7,published_snapshot=CASE WHEN visibility<>$7 THEN NULL ELSE published_snapshot END,private_release_id=CASE WHEN visibility<>$7 THEN NULL ELSE private_release_id END,updated_at=now() WHERE id=$1',
        [
          id,
          data.title,
          data.synopsis,
          data.genre,
          data.status,
          JSON.stringify(data),
          data.visibility,
        ],
      );
      if (data.visibility !== old.visibility) {
        await c.query(
          "UPDATE adventure_invitations SET status='revoked',updated_at=now() WHERE adventure_id=$1 AND status IN('pending','accepted')",
          [id],
        );
        await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
          userId,
          'adventure.visibility',
          id,
          JSON.stringify({ visibility: data.visibility }),
        ]);
      }
      return (await c.query(adventureSelect + ' WHERE a.id=$1', [id])).rows[0];
    });
    return adventureView(saved);
  }
}
@Controller('api/v1')
export class ContentController {
  constructor(
    @Inject(Db)
    private db: Db,
    @Inject(Auth)
    private auth: Auth,
    @Inject(Content)
    private content: Content,
    @Inject(PlayableService) private playable: PlayableService,
  ) {}
  @Get('genres')
  async genres() {
    return (
      (await this.db.query("SELECT value FROM platform_settings WHERE key='taxonomy'"))[0]?.value
        .genres ?? []
    );
  }
  @Get('tags')
  async tags() {
    return (
      (await this.db.query("SELECT value FROM platform_settings WHERE key='taxonomy'"))[0]?.value
        .tags ?? []
    );
  }
  @Get('adventures')
  async catalog(
    @Query('q')
    q = '',
    @Query('genre')
    genre = '',
    @Query('sort')
    sort = 'popular',
    @Req() req: Request,
  ) {
    const order =
      sort === 'new'
        ? 'a.created_at DESC'
        : sort === 'updated'
          ? 'a.updated_at DESC'
          : 'like_count DESC,total_rounds DESC,a.created_at DESC,a.id';
    const rows = await this.db.query(
      adventureSelect +
        ` WHERE ${publicAdventureSql} AND ($1='' OR a.published_snapshot->>'title' ILIKE $2 OR a.published_snapshot->>'synopsis' ILIKE $2 OR EXISTS(SELECT 1 FROM jsonb_each(COALESCE(a.published_snapshot->'translations','{}'::jsonb)) tr WHERE (tr.value->>'sourceRevision')::int=COALESCE((a.published_snapshot->>'sourceRevision')::int,1) AND (tr.value->>'title' ILIKE $2 OR tr.value->>'synopsis' ILIKE $2))) AND ($3='' OR a.published_snapshot->>'genre'=$3) ORDER BY ${order} LIMIT 100`,
      [q.slice(0, 200), `%${q.slice(0, 200)}%`, genre.slice(0, 50)],
    );
    const viewer = await this.auth.viewer(req);
    const liked = viewer
      ? new Set(
          (
            await this.db.query(
              'SELECT adventure_id FROM adventure_likes WHERE user_id=$1 AND adventure_id=ANY($2::uuid[])',
              [viewer.id, rows.map((row) => row.id)],
            )
          ).map((row) => row.adventure_id),
        )
      : new Set();
    return rows.map((r) => adventureView({ ...r, liked_by_me: liked.has(r.id) }, true));
  }
  @Get('adventures/:slug')
  async detail(
    @Param('slug')
    slug: string,
    @Req()
    req: Request,
    @Query('view')
    view?: string,
  ) {
    if (view !== undefined && view !== 'published') fail(400, 'INVALID_VIEW', 'INVALID_VIEW');
    const rows = await this.db.query(adventureSelect + ' WHERE a.slug=$1', [slug]);
    const row = rows[0];
    if (!row) fail(404, 'NOT_FOUND', 'Приключение не найдено.');
    const publishedOnly = view === 'published';
    if (
      publishedOnly &&
      (row.visibility !== 'public' || !row.published_snapshot || row.status === 'archived')
    )
      fail(404, 'NOT_FOUND', 'Приключение не найдено.');
    // Discovery must use the approved snapshot even for its signed-in author.
    // The default detail route retains its existing owner/invitation behavior.
    const u = await this.auth.viewer(req);
    const access = publishedOnly ? 'public' : await this.content.access(row, u);
    if (!access) fail(404, 'NOT_FOUND', 'Приключение не найдено.');
    const usePublished = access === 'public' || access === 'invited';
    row.liked_by_me = u
      ? (
          await this.db.query(
            'SELECT 1 FROM adventure_likes WHERE user_id=$1 AND adventure_id=$2',
            [u.id, row.id],
          )
        ).length > 0
      : false;
    const result = adventureView(row, usePublished, access !== 'owner', access === 'reviewer');
    const npcIds = result.content.npcIds;
    let npcPreview: Record<string, unknown>[];
    if (access !== 'owner') {
      // Author NPC records are not an explicitly spoiler-safe public cast.
      npcPreview = [];
    } else {
      const npcs = npcIds.length
        ? await this.db.query('SELECT * FROM npcs WHERE id=ANY($1::uuid[])', [npcIds])
        : [];
      npcPreview = npcs.map((r) => {
        const n = entityView(r);
        delete n.secrets;
        delete n.biography;
        delete n.characterProfile;
        if (access !== 'owner') delete n.editRevision;
        return { ...n, ...safeNpcMetadata(npcSchema.parse(r.data)) };
      });
    }
    return {
      ...result,
      access,
      readOnly: access !== 'owner',
      npcs: npcPreview.map((n) => {
        const { characterProfile: _characterProfile, ...safe } = n;
        return {
          ...safe,
          ...safeNpcMetadata(n as unknown as import('@dreamwalk/contracts').NpcMetadata),
        };
      }),
      versions:
        access !== 'owner'
          ? []
          : (
              await this.db.query(
                'SELECT id,version,created_at FROM adventure_versions WHERE adventure_id=$1 ORDER BY version DESC',
                [row.id],
              )
            ).map(camel),
    };
  }
  @Get('creators/:handle')
  async creator(
    @Param('handle')
    handle: string,
  ) {
    const rows = await this.db.query(
      'SELECT id,name,handle,bio,avatar_asset_id,settings FROM users WHERE handle=$1 AND deleted_at IS NULL',
      [handle],
    );
    const u = rows[0];
    if (!u || !(u.settings as Record<string, unknown>).profilePublic)
      fail(404, 'NOT_FOUND', 'Профиль автора скрыт.');
    delete u.settings;
    return {
      creator: camel(u),
      adventures: (
        await this.db.query(
          adventureSelect +
            " WHERE a.owner_id=$1 AND a.visibility='public' AND a.published_snapshot IS NOT NULL AND a.status<>'archived' ORDER BY a.updated_at DESC",
          [u.id],
        )
      ).map((r) => adventureView(r, true)),
    };
  }
  @Get('models')
  async models() {
    return (
      await this.db.query(
        'SELECT id,key,name,description,enabled,version,created_at,updated_at FROM model_profiles WHERE enabled=true ORDER BY name',
      )
    ).map(camel);
  }
  @Get('library')
  async library(
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req);
    const favorites = await this.db.query(
      adventureSelect +
        ` JOIN favorites f ON f.adventure_id=a.id WHERE f.user_id=$1 AND ${readableAdventureSql('$1')} ORDER BY f.created_at DESC`,
      [u.id],
    );
    const shared = await this.db.query(
      adventureSelect +
        " JOIN adventure_invitations i ON i.adventure_id=a.id WHERE i.recipient_id=$1 AND i.status='accepted' AND a.visibility='private' AND a.private_release_id IS NOT NULL AND a.status<>'archived' ORDER BY i.updated_at DESC",
      [u.id],
    );
    return {
      favorites: favorites.map((r) => adventureView(r, r.owner_id !== u.id, r.owner_id !== u.id)),
      shared: shared.map((r) => ({
        ...adventureView(r, true, true),
        access: 'invited',
        readOnly: true,
      })),
      privatePublished: (
        await this.db.query(
          adventureSelect +
            " WHERE a.owner_id=$1 AND a.visibility='private' AND a.private_release_id IS NOT NULL AND a.status<>'archived' ORDER BY a.updated_at DESC",
          [u.id],
        )
      ).map((r) => adventureView(r, true)),
      drafts: (
        await this.db.query(adventureSelect + ' WHERE a.owner_id=$1 ORDER BY a.updated_at DESC', [
          u.id,
        ])
      ).map((r) => adventureView(r)),
      heroes: (
        await this.db.query('SELECT * FROM heroes WHERE owner_id=$1 ORDER BY updated_at DESC', [
          u.id,
        ])
      ).map(entityView),
    };
  }
  @Put('likes/:id')
  async like(@Param('id') id: string, @Req() req: Request) {
    return this.setLike(id, req, true);
  }
  @Delete('likes/:id')
  async unlike(@Param('id') id: string, @Req() req: Request) {
    return this.setLike(id, req, false);
  }
  private async setLike(id: string, req: Request, liked: boolean) {
    const u = await this.auth.require(req);
    z.string().uuid().parse(id);
    return this.db.tx(async (c) => {
      // Lock the story so publication/withdrawal cannot race a new public like.
      const story = (
        await c.query(
          `SELECT a.id FROM adventures a JOIN users u ON u.id=a.owner_id WHERE a.id=$1 AND ${publicAdventureSql} FOR UPDATE OF a`,
          [id],
        )
      ).rows[0];
      if (!story) {
        // Users can remove their own old like even after a story is withdrawn.
        if (liked) fail(404, 'NOT_FOUND', 'Приключение не найдено.');
        await c.query('DELETE FROM adventure_likes WHERE user_id=$1 AND adventure_id=$2', [
          u.id,
          id,
        ]);
        return { likeCount: 0, likedByMe: false };
      }
      if (liked)
        await c.query(
          'INSERT INTO adventure_likes(user_id,adventure_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [u.id, id],
        );
      else
        await c.query('DELETE FROM adventure_likes WHERE user_id=$1 AND adventure_id=$2', [
          u.id,
          id,
        ]);
      const result = (
        await c.query(
          'SELECT count(*)::int AS count FROM adventure_likes l JOIN users u ON u.id=l.user_id AND u.deleted_at IS NULL WHERE l.adventure_id=$1',
          [id],
        )
      ).rows[0];
      return { likeCount: result.count, likedByMe: liked };
    });
  }
  @Put('favorites/:id')
  async favorite(
    @Param('id')
    id: string,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req);
    const row = (await this.db.query(adventureSelect + ' WHERE a.id=$1', [id]))[0];
    if (!row || !(await this.content.access(row, u)))
      fail(404, 'NOT_FOUND', 'Приключение не найдено.');
    await this.db.query(
      'INSERT INTO favorites(user_id,adventure_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [u.id, id],
    );
    return { ok: true };
  }
  @Delete('favorites/:id')
  async unfavorite(
    @Param('id')
    id: string,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req);
    await this.db.query('DELETE FROM favorites WHERE user_id=$1 AND adventure_id=$2', [u.id, id]);
    return { ok: true };
  }
  @Get('heroes')
  async heroes(
    @Req()
    req: Request,
  ) {
    return this.listEntities('heroes', req);
  }
  @Post('heroes')
  async createHero(
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    return this.createEntity('heroes', body, req);
  }
  @Patch('heroes/:id')
  async editHero(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    return this.editEntity('heroes', id, body, req);
  }
  @Delete('heroes/:id')
  async deleteHero(
    @Param('id')
    id: string,
    @Req()
    req: Request,
  ) {
    return this.deleteEntity('heroes', id, req);
  }
  @Get('npcs')
  async npcs(
    @Req()
    req: Request,
  ) {
    return this.listEntities('npcs', req);
  }
  @Get('npcs/:id')
  async npc(
    @Param('id')
    id: string,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req);
    const row = (
      await this.db.query('SELECT * FROM npcs WHERE id=$1 AND owner_id=$2 AND story_id IS NULL', [
        id,
        u.id,
      ])
    )[0];
    if (!row) fail(404, 'NOT_FOUND', 'NPC не найден.');
    return entityView(row);
  }
  @Post('npcs')
  async createNpc(
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    return this.createEntity('npcs', body, req);
  }
  @Patch('npcs/:id')
  async editNpc(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    return this.editEntity('npcs', id, body, req);
  }
  @Delete('npcs/:id')
  async deleteNpc(
    @Param('id')
    id: string,
    @Req()
    req: Request,
  ) {
    return this.deleteEntity('npcs', id, req);
  }
  private async listEntities(table: 'heroes' | 'npcs', req: Request) {
    const u = await this.auth.require(req);
    return (
      await this.db.query(
        `SELECT * FROM ${table} WHERE owner_id=$1 ${table === 'npcs' ? 'AND story_id IS NULL' : ''} ORDER BY updated_at DESC`,
        [u.id],
      )
    ).map(entityView);
  }
  private async createEntity(table: 'heroes' | 'npcs', body: unknown, req: Request) {
    const u = await this.auth.require(req),
      data =
        table === 'heroes'
          ? heroSchema.parse(body)
          : npcSchema.parse({
              ...npcSchema.parse(body),
              sourceLanguage:
                (body as Record<string, unknown>).sourceLanguage ?? u.settings.language,
              sourceRevision: 1,
              translations: {},
            });
    await this.auth.ownedAsset(u.id, data.portraitAssetId);
    if ('characterPackageVersionId' in data && data.characterPackageVersionId) {
      const { manifest } = await this.db.tx((c) =>
        ownedCharacterPackage(c, u.id, String(data.characterPackageVersionId)),
      );
      data.portraitAssetId = manifest.parts.find((p) => p.role === 'portrait')!.uploadId;
    }
    if (
      'modelProfileId' in data &&
      data.modelProfileId &&
      !(await this.db.query('SELECT id FROM model_profiles WHERE id=$1', [data.modelProfileId]))
        .length
    )
      fail(400, 'VALIDATION_FAILED', 'Модель не найдена.');
    return entityView(
      (
        await this.db.query(`INSERT INTO ${table}(owner_id,data) VALUES($1,$2) RETURNING *`, [
          u.id,
          JSON.stringify(data),
        ])
      )[0],
    );
  }
  private async editEntity(table: 'heroes' | 'npcs', id: string, body: unknown, req: Request) {
    if (table === 'npcs') return this.saveNpcOriginal(id, body, req);
    const u = await this.auth.require(req);
    const old = (
      await this.db.query(`SELECT * FROM ${table} WHERE id=$1 AND owner_id=$2`, [id, u.id])
    )[0];
    if (!old) fail(404, 'NOT_FOUND', 'Персонаж не найден.');
    const patch =
      table === 'heroes'
        ? parsePatch(heroSchema.partial(), body)
        : parsePatch(npcSchema.partial(), body);
    const data =
      table === 'heroes'
        ? heroSchema.parse({ ...old.data, ...patch })
        : npcSchema.parse({ ...old.data, ...patch });
    await this.auth.ownedAsset(u.id, data.portraitAssetId);
    if ('characterPackageVersionId' in data && data.characterPackageVersionId) {
      const { manifest } = await this.db.tx((c) =>
        ownedCharacterPackage(c, u.id, String(data.characterPackageVersionId)),
      );
      // An explicit portrait edit is independent of the existing in-world sprite package.
      if (
        Object.hasOwn(patch, 'characterPackageVersionId') &&
        !Object.hasOwn(patch, 'portraitAssetId')
      )
        data.portraitAssetId = manifest.parts.find((p) => p.role === 'portrait')!.uploadId;
    }
    if (
      'modelProfileId' in data &&
      data.modelProfileId &&
      !(await this.db.query('SELECT id FROM model_profiles WHERE id=$1', [data.modelProfileId]))
        .length
    )
      fail(400, 'VALIDATION_FAILED', 'Модель не найдена.');
    return entityView(
      (
        await this.db.query(
          `UPDATE ${table} SET data=$3,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *`,
          [id, u.id, JSON.stringify(data)],
        )
      )[0],
    );
  }
  private async saveNpcOriginal(id: string, body: unknown, req: Request) {
    const user = await this.auth.require(req),
      input = draftPatch(body),
      patch = parsePatch(npcSchema.partial(), input.patch);
    await this.auth.ownedAsset(user.id, patch.portraitAssetId ?? null);
    if (
      patch.modelProfileId &&
      !(await this.db.query('SELECT id FROM model_profiles WHERE id=$1', [patch.modelProfileId]))
        .length
    )
      fail(400, 'VALIDATION_FAILED', 'Model not found.');
    return this.db.tx(async (c) => {
      const old = (
        await c.query(
          'SELECT * FROM npcs WHERE id=$1 AND owner_id=$2 AND story_id IS NULL FOR UPDATE',
          [id, user.id],
        )
      ).rows[0];
      if (!old) fail(404, 'NOT_FOUND', 'NPC not found.');
      checkEditRevision(old, input.expectedEditRevision);
      const original = npcSchema.parse(old.data),
        data = npcSchema.parse({
          ...original,
          ...patch,
          translations: original.translations,
          sourceRevision: original.sourceRevision,
        });
      if (data.characterPackageVersionId) {
        const { manifest } = await ownedCharacterPackage(
          c,
          user.id,
          data.characterPackageVersionId,
        );
        data.portraitAssetId = manifest.parts.find((p) => p.role === 'portrait')!.uploadId;
      }
      if (
        npcTextFields.some((f) => data[f] !== original[f]) ||
        JSON.stringify(data.characterProfile) !== JSON.stringify(original.characterProfile) ||
        data.sourceLanguage !== original.sourceLanguage
      )
        data.sourceRevision++;
      return entityView(
        (
          await c.query('UPDATE npcs SET data=$2,updated_at=now() WHERE id=$1 RETURNING *', [
            id,
            JSON.stringify(data),
          ])
        ).rows[0],
      );
    });
  }
  @Patch('npcs/:id/translations/:locale')
  async npcTranslation(
    @Param('id') id: string,
    @Param('locale') value: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const user = await this.auth.require(req),
      locale = localeSchema.parse(value);
    const b = npcTranslationSchema
      .omit({ sourceRevision: true })
      .extend({
        expectedSourceRevision: z.number().int().min(1),
        expectedEditRevision: expectedEditRevisionSchema,
      })
      .strict()
      .parse(body);
    return this.db.tx(async (c) => {
      const row = (
        await c.query(
          'SELECT * FROM npcs WHERE id=$1 AND owner_id=$2 AND story_id IS NULL FOR UPDATE',
          [id, user.id],
        )
      ).rows[0];
      if (!row) fail(404, 'NOT_FOUND', 'NPC not found.');
      checkEditRevision(row, b.expectedEditRevision);
      const data = npcSchema.parse(row.data);
      if (data.sourceRevision !== b.expectedSourceRevision)
        fail(409, 'SOURCE_REVISION_CONFLICT', 'Original changed.');
      const { expectedSourceRevision, expectedEditRevision: _editRevision, ...fields } = b;
      void _editRevision;
      data.translations[locale] = {
        ...data.translations[locale],
        ...fields,
        sourceRevision: expectedSourceRevision,
      };
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        user.id,
        'npc.translation.save',
        id,
        JSON.stringify({ locale, sourceRevision: data.sourceRevision }),
      ]);
      return entityView(
        (
          await c.query('UPDATE npcs SET data=$2,updated_at=now() WHERE id=$1 RETURNING *', [
            id,
            JSON.stringify(data),
          ])
        ).rows[0],
      );
    });
  }
  private async deleteEntity(table: 'heroes' | 'npcs', id: string, req: Request) {
    const u = await this.auth.require(req);
    if (table === 'npcs') {
      const used = await this.db.query(
        "SELECT id FROM adventures WHERE owner_id=$1 AND data->'content'->'npcIds' ? $2 AND status<>'archived'",
        [u.id, id],
      );
      if (used.length) fail(409, 'STATE_CONFLICT', 'Сначала удалите NPC из приключений.');
    }
    await this.db.query(
      `DELETE FROM ${table} WHERE id=$1 AND owner_id=$2 ${table === 'npcs' ? 'AND story_id IS NULL' : ''}`,
      [id, u.id],
    );
    return { ok: true };
  }
  @Get('studio/adventures')
  async studio(
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req);
    return (
      await this.db.query(adventureSelect + ' WHERE a.owner_id=$1 ORDER BY a.updated_at DESC', [
        u.id,
      ])
    ).map((r) => adventureView(r));
  }
  @Get('studio/adventures/:id')
  async draft(
    @Param('id')
    id: string,
    @Req()
    req: Request,
  ) {
    return adventureView(await this.content.own(id, (await this.auth.require(req)).id));
  }
  @Post('studio/adventures')
  async createAdventure(
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req),
      data = adventureSchema.parse(body);
    if (!Object.prototype.hasOwnProperty.call(body, 'sourceLanguage'))
      data.sourceLanguage = u.settings.language;
    data.sourceRevision = 1;
    data.translations = {};
    if (['published', 'pending_review'].includes(data.status))
      fail(403, 'FORBIDDEN', 'Публикация требует модерации.');
    await this.content.validateReferences(u.id, data);
    const id = randomUUID();
    await this.db.query(
      'INSERT INTO adventures(id,owner_id,slug,title,synopsis,genre,status,data,visibility) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        id,
        u.id,
        `story-${id.slice(0, 8)}`,
        data.title,
        data.synopsis,
        data.genre,
        data.status,
        JSON.stringify(data),
        data.visibility,
      ],
    );
    return adventureView(await this.content.own(id, u.id));
  }
  @Patch('studio/adventures/:id')
  async save(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    return this.content.save(id, (await this.auth.require(req)).id, body);
  }
  @Patch('studio/adventures/:id/translations/:locale')
  async saveTranslation(
    @Param('id') id: string,
    @Param('locale') localeValue: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const u = await this.auth.require(req);
    const locale = localeSchema.parse(localeValue);
    const b = z
      .object({
        title: z.string().trim().max(120).optional(),
        synopsis: z.string().trim().max(4000).optional(),
        tags: z
          .record(z.string().trim().min(1).max(40), z.string().trim().max(40))
          .refine((v) => Object.keys(v).length <= 12)
          .optional(),
        expectedSourceRevision: z.number().int().min(1),
        expectedEditRevision: expectedEditRevisionSchema,
      })
      .strict()
      .parse(body);
    await this.db.tx(async (c) => {
      const row = (
        await c.query('SELECT * FROM adventures WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, u.id])
      ).rows[0];
      if (!row) fail(404, 'NOT_FOUND', 'Приключение не найдено.');
      checkEditRevision(row, b.expectedEditRevision);
      const data = adventureSchema.parse({
        ...row.data,
        status: row.status,
        visibility: row.visibility,
      });
      if (data.sourceRevision !== b.expectedSourceRevision)
        fail(
          409,
          'SOURCE_REVISION_CONFLICT',
          'Оригинал изменился. Обновите страницу перед сохранением перевода.',
        );
      const definitions =
        (await c.query("SELECT value FROM platform_settings WHERE key='taxonomy'")).rows[0]?.value
          .tags ?? [];
      if (
        b.tags &&
        Object.keys(b.tags).some(
          (tag) =>
            !data.tags.includes(tag) ||
            definitions.some(
              (d: { id: string; aliases: string[] }) => d.id === tag || d.aliases.includes(tag),
            ),
        )
      )
        fail(400, 'VALIDATION_FAILED', 'Invalid custom tag translation.');
      const previous =
        data.translations[locale]?.sourceRevision === data.sourceRevision
          ? data.translations[locale]
          : {};
      data.translations = {
        ...data.translations,
        [locale]: {
          ...previous,
          ...(b.title === undefined ? {} : { title: b.title }),
          ...(b.synopsis === undefined ? {} : { synopsis: b.synopsis }),
          ...(b.tags === undefined ? {} : { tags: b.tags }),
          sourceRevision: data.sourceRevision,
        },
      };
      data.status = row.status === 'archived' ? 'archived' : 'draft';
      await c.query('UPDATE adventures SET data=$2,status=$3,updated_at=now() WHERE id=$1', [
        id,
        JSON.stringify(data),
        data.status,
      ]);
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        'adventure.translation.save',
        id,
        JSON.stringify({ locale, sourceRevision: data.sourceRevision }),
      ]);
    });
    return adventureView(await this.content.own(id, u.id));
  }
  @Post('studio/adventures/:id/duplicate')
  async duplicate(
    @Param('id')
    id: string,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req),
      newId = randomUUID();
    await this.db.tx(async (c) => {
      const row = (
        await c.query('SELECT * FROM adventures WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, u.id])
      ).rows[0];
      if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      const data = adventureSchema.parse({
        ...row.data,
        title: `${row.title} — копия`.slice(0, 120),
        status: 'draft',
        visibility: 'private',
        sourceRevision: 1,
        translations: {},
      });
      const npcs = (
        await c.query(
          'SELECT * FROM npcs WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND (story_id IS NULL OR story_id=$3) FOR SHARE',
          [u.id, data.content.npcIds, id],
        )
      ).rows;
      if (npcs.length !== new Set(data.content.npcIds).size) fail(403, 'FORBIDDEN', 'FORBIDDEN');
      await c.query(
        'INSERT INTO adventures(id,owner_id,slug,title,synopsis,genre,status,data,visibility) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          newId,
          u.id,
          `story-${newId.slice(0, 8)}`,
          data.title,
          data.synopsis,
          data.genre,
          'draft',
          JSON.stringify({ ...data, content: { ...data.content, npcIds: [] } }),
          'private',
        ],
      );
      const copies = new Map<string, string>(npcs.map((npc) => [npc.id, randomUUID()]));
      for (const npc of npcs) {
        const npcId = copies.get(npc.id)!;
        await c.query(
          'INSERT INTO npcs(id,owner_id,story_id,source_template_id,data) VALUES($1,$2,$3,$4,$5)',
          [
            npcId,
            u.id,
            newId,
            npc.story_id ? npc.source_template_id : npc.id,
            JSON.stringify({
              ...npc.data,
              ...(npc.data.characterProfile
                ? {
                    characterProfile: remapCopiedCharacterProfile(
                      npc.data.characterProfile,
                      copies,
                    ),
                  }
                : {}),
            }),
          ],
        );
      }
      if (data.content.lorebook)
        data.content.lorebook = remapCopiedStoryLore(data.content.lorebook, copies);
      data.content.npcIds = data.content.npcIds.map((npcId) => copies.get(npcId)!);
      data.content.scenes = remapSceneParticipants(data.content.scenes, copies);
      await c.query('UPDATE adventures SET data=$2 WHERE id=$1', [newId, JSON.stringify(data)]);
    });
    return adventureView(await this.content.own(newId, u.id));
  }
  @Get('studio/adventures/:id/versions')
  async versions(
    @Param('id')
    id: string,
    @Req()
    req: Request,
  ) {
    await this.content.own(id, (await this.auth.require(req)).id);
    return (
      await this.db.query(
        'SELECT id,version,snapshot,created_at FROM adventure_versions WHERE adventure_id=$1 ORDER BY version DESC',
        [id],
      )
    ).map(camel);
  }
  @Post('studio/adventures/:id/submit')
  async submit(
    @Param('id')
    id: string,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req);
    await this.db.tx(async (c) => {
      await this.playable.lockAuthor(c, u.id);
      const row = (
        await c.query('SELECT * FROM adventures WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, u.id])
      ).rows[0];
      if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      if (row.visibility !== 'public') fail(400, 'VALIDATION_FAILED', 'Public visibility required');
      if (row.status === 'pending_review') return;
      if (row.status === 'published') fail(409, 'STATE_CONFLICT', 'Save changes before submission');
      await this.content.validateReferences(u.id, adventureSchema.parse(row.data), true, id);
      const gameVersion = await this.playable.freeze(c, row, 'review');
      await c.query(
        "UPDATE adventures SET status='pending_review',submitted_game_version_id=$2,updated_at=now() WHERE id=$1",
        [id, gameVersion],
      );
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        'adventure.submit',
        id,
        JSON.stringify({ playableVersionId: gameVersion }),
      ]);
    });
    return adventureView(await this.content.own(id, u.id));
  }
  @Post('reports')
  async report(
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req),
      b = z
        .object({ adventureId: z.string().uuid(), reason: z.string().trim().min(10).max(2000) })
        .strict()
        .parse(body);
    const row = (await this.db.query(adventureSelect + ' WHERE a.id=$1', [b.adventureId]))[0];
    if (!row || !(await this.content.access(row, u)))
      fail(404, 'NOT_FOUND', 'Приключение не найдено.');
    return camel(
      (
        await this.db.query(
          'INSERT INTO reports(reporter_id,adventure_id,reason) VALUES($1,$2,$3) RETURNING *',
          [u.id, b.adventureId, b.reason],
        )
      )[0],
    );
  }
}
