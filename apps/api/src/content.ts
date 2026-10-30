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
} from '@dreamwalk/contracts';
import { Db, camel } from './db';
import { Auth } from './auth';
import { fail } from './errors';
export const adventureSelect = `SELECT a.*,u.name AS author_name,u.handle AS author_handle,(SELECT count(*)::int FROM favorites f WHERE f.adventure_id=a.id) AS favorite_count FROM adventures a JOIN users u ON u.id=a.owner_id`;
export const publicAdventureSql =
  "a.visibility='public' AND a.published_snapshot IS NOT NULL AND a.status<>'archived'";
export const readableAdventureSql = (userParameter: string) =>
  `(a.owner_id=${userParameter} OR (${publicAdventureSql}) OR (a.visibility='private' AND a.status<>'archived' AND EXISTS(SELECT 1 FROM adventure_invitations i WHERE i.adventure_id=a.id AND i.recipient_id=${userParameter} AND i.status='accepted')))`;
export function adventureView(
  row: Record<string, unknown>,
  usePublished = false,
  reader = false,
): Adventure {
  const data = (
    usePublished && row.published_snapshot ? row.published_snapshot : row.data
  ) as Record<string, unknown>;
  const metadata = {
    title: (usePublished && row.published_snapshot ? data.title : row.title) as string,
    synopsis: (usePublished && row.published_snapshot ? data.synopsis : row.synopsis) as string,
    sourceLanguage: (data.sourceLanguage ?? 'ru') as Locale,
    sourceRevision: Number(data.sourceRevision ?? 1),
    translations: (data.translations ?? {}) as MetadataTranslations,
  };
  const exposedMetadata = usePublished || reader ? safeAdventureMetadata(metadata) : metadata;
  return {
    ...data,
    ...exposedMetadata,
    id: row.id,
    ownerId: row.owner_id,
    slug: row.slug,
    title: usePublished && row.published_snapshot ? data.title : row.title,
    synopsis: usePublished && row.published_snapshot ? data.synopsis : row.synopsis,
    genre: usePublished && row.published_snapshot ? data.genre : row.genre,
    status: usePublished && row.published_snapshot ? 'published' : row.status,
    visibility: row.visibility,
    version: row.version,
    author: { name: row.author_name, handle: row.author_handle },
    favoriteCount: row.favorite_count ?? 0,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  } as Adventure;
}
function entityView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(row.data as Record<string, unknown>),
    id: row.id,
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
    if (!user) return null;
    const invites = await this.db.query(
      "SELECT id FROM adventure_invitations WHERE adventure_id=$1 AND recipient_id=$2 AND status='accepted'",
      [row.id, user.id],
    );
    return invites.length ? 'invited' : null;
  }
  async validateReferences(userId: string, data: z.infer<typeof adventureSchema>, publish = false) {
    await this.auth.ownedAsset(userId, data.coverAssetId);
    if (data.playersMin > data.playersMax)
      fail(400, 'VALIDATION_FAILED', 'Минимум игроков не может превышать максимум.');
    const c = data.content;
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
        'SELECT id FROM npcs WHERE id=ANY($1::uuid[]) AND owner_id=$2',
        [c.npcIds, userId],
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
    const patch = parsePatch(adventureSchema.partial(), body);
    if (patch.status && ['published', 'pending_review'].includes(patch.status))
      fail(403, 'FORBIDDEN', 'Для публикации отправьте историю на модерацию.');
    await this.db.tx(async (c) => {
      const old = (
        await c.query('SELECT * FROM adventures WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
          id,
          userId,
        ])
      ).rows[0];
      if (!old) fail(404, 'NOT_FOUND', 'Приключение не найдено.');
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
      await this.validateReferences(userId, data);
      await c.query(
        'UPDATE adventures SET title=$2,synopsis=$3,genre=$4,status=$5,data=$6,visibility=$7,published_snapshot=CASE WHEN visibility<>$7 THEN NULL ELSE published_snapshot END,updated_at=now() WHERE id=$1',
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
    });
    return adventureView(await this.own(id, userId));
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
  ) {
    const order =
      sort === 'new'
        ? 'a.created_at DESC'
        : sort === 'updated'
          ? 'a.updated_at DESC'
          : 'favorite_count DESC,a.updated_at DESC';
    const rows = await this.db.query(
      adventureSelect +
        ` WHERE a.visibility='public' AND a.published_snapshot IS NOT NULL AND a.status<>'archived' AND ($1='' OR a.published_snapshot->>'title' ILIKE $2 OR a.published_snapshot->>'synopsis' ILIKE $2 OR EXISTS(SELECT 1 FROM jsonb_each(COALESCE(a.published_snapshot->'translations','{}'::jsonb)) tr WHERE (tr.value->>'sourceRevision')::int=COALESCE((a.published_snapshot->>'sourceRevision')::int,1) AND (tr.value->>'title' ILIKE $2 OR tr.value->>'synopsis' ILIKE $2))) AND ($3='' OR a.published_snapshot->>'genre'=$3) ORDER BY ${order} LIMIT 100`,
      [q.slice(0, 200), `%${q.slice(0, 200)}%`, genre.slice(0, 50)],
    );
    return rows.map((r) => adventureView(r, true));
  }
  @Get('adventures/:slug')
  async detail(
    @Param('slug')
    slug: string,
    @Req()
    req: Request,
  ) {
    const rows = await this.db.query(adventureSelect + ' WHERE a.slug=$1', [slug]);
    const row = rows[0];
    if (!row) fail(404, 'NOT_FOUND', 'Приключение не найдено.');
    const u = await this.auth.current(req);
    const access = await this.content.access(row, u);
    if (!access) fail(404, 'NOT_FOUND', 'Приключение не найдено.');
    const usePublished = access === 'public';
    const result = adventureView(row, usePublished, access !== 'owner');
    const npcIds = result.content.npcIds;
    let npcPreview: Record<string, unknown>[];
    if (usePublished && row.published_snapshot) {
      npcPreview = ((row.published_snapshot as Record<string, unknown>).publicNpcs ?? []) as Record<
        string,
        unknown
      >[];
    } else {
      const npcs = npcIds.length
        ? await this.db.query('SELECT * FROM npcs WHERE id=ANY($1::uuid[])', [npcIds])
        : [];
      npcPreview = npcs.map((r) => {
        const n = entityView(r);
        delete n.secrets;
        delete n.biography;
        return { ...n, ...safeNpcMetadata(npcSchema.parse(r.data)) };
      });
    }
    return {
      ...result,
      access,
      readOnly: access !== 'owner',
      npcs: npcPreview.map((n) => ({
        ...n,
        ...safeNpcMetadata(n as unknown as import('@dreamwalk/contracts').NpcMetadata),
      })),
      versions: (
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
        " JOIN adventure_invitations i ON i.adventure_id=a.id WHERE i.recipient_id=$1 AND i.status='accepted' AND a.visibility='private' AND a.status<>'archived' ORDER BY i.updated_at DESC",
      [u.id],
    );
    return {
      favorites: favorites.map((r) =>
        adventureView(r, r.visibility === 'public' && r.owner_id !== u.id, r.owner_id !== u.id),
      ),
      shared: shared.map((r) => ({
        ...adventureView(r, false, true),
        access: 'invited',
        readOnly: true,
      })),
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
      await this.db.query('SELECT * FROM npcs WHERE id=$1 AND owner_id=$2', [id, u.id])
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
      await this.db.query(`SELECT * FROM ${table} WHERE owner_id=$1 ORDER BY updated_at DESC`, [
        u.id,
      ])
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
      patch = parsePatch(npcSchema.partial(), body);
    await this.auth.ownedAsset(user.id, patch.portraitAssetId ?? null);
    if (
      patch.modelProfileId &&
      !(await this.db.query('SELECT id FROM model_profiles WHERE id=$1', [patch.modelProfileId]))
        .length
    )
      fail(400, 'VALIDATION_FAILED', 'Model not found.');
    return this.db.tx(async (c) => {
      const old = (
        await c.query('SELECT * FROM npcs WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, user.id])
      ).rows[0];
      if (!old) fail(404, 'NOT_FOUND', 'NPC not found.');
      const original = npcSchema.parse(old.data),
        data = npcSchema.parse({
          ...original,
          ...patch,
          translations: original.translations,
          sourceRevision: original.sourceRevision,
        });
      if (
        npcTextFields.some((f) => data[f] !== original[f]) ||
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
      .extend({ expectedSourceRevision: z.number().int().min(1) })
      .strict()
      .parse(body);
    return this.db.tx(async (c) => {
      const row = (
        await c.query('SELECT * FROM npcs WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, user.id])
      ).rows[0];
      if (!row) fail(404, 'NOT_FOUND', 'NPC not found.');
      const data = npcSchema.parse(row.data);
      if (data.sourceRevision !== b.expectedSourceRevision)
        fail(409, 'SOURCE_REVISION_CONFLICT', 'Original changed.');
      const { expectedSourceRevision, ...fields } = b;
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
    await this.db.query(`DELETE FROM ${table} WHERE id=$1 AND owner_id=$2`, [id, u.id]);
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
      })
      .strict()
      .parse(body);
    await this.db.tx(async (c) => {
      const row = (
        await c.query('SELECT * FROM adventures WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, u.id])
      ).rows[0];
      if (!row) fail(404, 'NOT_FOUND', 'Приключение не найдено.');
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
      row = await this.content.own(id, u.id);
    return this.createAdventure(
      {
        ...row.data,
        title: `${row.title} — копия`.slice(0, 120),
        status: 'draft',
        visibility: 'private',
      },
      req,
    );
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
    const u = await this.auth.require(req),
      row = await this.content.own(id, u.id);
    if (row.visibility !== 'public')
      fail(400, 'VALIDATION_FAILED', 'Только публичное приключение отправляется на модерацию.');
    if (row.status === 'pending_review') return adventureView(row);
    if (row.status === 'published')
      fail(409, 'STATE_CONFLICT', 'Эта версия уже опубликована. Сначала сохраните изменения.');
    const data = adventureSchema.parse(row.data);
    await this.content.validateReferences(u.id, data, true);
    await this.db.query(
      "UPDATE adventures SET status='pending_review',updated_at=now() WHERE id=$1",
      [id],
    );
    await this.db.audit(u.id, 'adventure.submit', id);
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
