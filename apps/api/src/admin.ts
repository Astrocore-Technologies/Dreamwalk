import {
  adminAdventureAccessSql,
  adminDeletionRevisionSql,
  deletedStories,
  removeStory,
  restoreStory,
} from './admin-story-deletion';
import { directorStyleUpdateSchema } from '@dreamwalk/contracts/dist/director-style';
import {
  readDirectorCatalog,
  saveDirectorCatalog,
  directorProfile,
  profileStyle,
} from './ai/director-style';
import { SPARK_RATE_VERSION } from '@dreamwalk/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  modelSchema,
  runtimeSchema,
  adventureSchema,
  parsePatch,
  safeNpcMetadata,
  readerStoryContent,
} from '@dreamwalk/contracts';
import { Db, camel } from './db';
import { Auth, userView } from './auth';
import { adventureSelect, adventureView, Content } from './content';
import { fail } from './errors';
import { taxonomyUpdateSchema } from '@dreamwalk/contracts/dist/taxonomy';
import { normalizeTaxonomy, mergeTaxonomy } from './taxonomy';
import { NpcAiService } from './ai/npc-ai.service';
import { AssetReuseService } from './assets/reuse.service';
@Controller('api/v1')
export class AdminController {
  constructor(
    @Inject(Db)
    private db: Db,
    @Inject(Auth)
    private auth: Auth,
    @Inject(Content)
    private content: Content,
    @Inject(NpcAiService)
    private npcAi: NpcAiService,
    @Inject(AssetReuseService) private art: AssetReuseService,
  ) {}
  @Get('admin/directors')
  async directors(@Req() req: Request) {
    await this.auth.admin(req);
    return readDirectorCatalog(this.db);
  }
  @Patch('admin/directors')
  async editDirectors(@Body() body: unknown, @Req() req: Request) {
    const user = await this.auth.admin(req);
    return saveDirectorCatalog(this.db, user.id, body);
  }
  // Compatibility for the first admin panel: change only the current default profile.
  @Get('admin/director-style')
  async directorStyle(@Req() req: Request) {
    await this.auth.admin(req);
    const catalog = await readDirectorCatalog(this.db);
    return profileStyle(catalog, directorProfile(catalog));
  }
  @Patch('admin/director-style')
  async editDirectorStyle(@Body() body: unknown, @Req() req: Request) {
    const user = await this.auth.admin(req);
    const { expectedRevision, ...style } = directorStyleUpdateSchema.parse(body);
    const catalog = await readDirectorCatalog(this.db);
    if (catalog.revision !== expectedRevision)
      fail(409, 'DIRECTOR_STYLE_STALE', 'DIRECTOR_STYLE_STALE');
    const next = await saveDirectorCatalog(this.db, user.id, {
      expectedRevision,
      defaultProfileId: catalog.defaultProfileId,
      profiles: catalog.profiles.map((profile) =>
        profile.id === catalog.defaultProfileId ? { ...profile, ...style } : profile,
      ),
    });
    return profileStyle(next, directorProfile(next));
  }
  @Get('admin/npc-ai/metrics')
  async npcAiMetrics(@Req() req: Request) {
    await this.auth.admin(req);
    return this.npcAi.metrics();
  }
  private async walletFor(id: string) {
    const row = (
      await this.db.query(
        `SELECT w.balance, COALESCE((SELECT SUM(j.credits) FROM npc_ai_jobs j
       WHERE j.payer_user_id=w.user_id AND j.reservation_status='held'),0)::bigint AS held
       FROM wallets w WHERE w.user_id=$1`,
        [id],
      )
    )[0];
    return {
      balance: row?.balance ?? 0,
      reserved: Number(row?.held ?? 0),
      available: (row?.balance ?? 0) - Number(row?.held ?? 0),
      mode: 'demo',
      ledger: (
        await this.db.query(
          'SELECT id,amount,reason,source_key,created_at FROM ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200',
          [id],
        )
      ).map(camel),
    };
  }
  @Get('wallet')
  async wallet(
    @Req()
    req: Request,
  ) {
    return this.walletFor((await this.auth.require(req)).id);
  }
  @Get('sparks/wallet')
  async sparksWallet(@Req() req: Request) {
    const owner = (await this.auth.require(req)).id;
    return this.sparksWalletFor(owner);
  }
  @Get('currencies/wallet')
  async currenciesWallet(@Req() req: Request) {
    const ownerId = (await this.auth.require(req)).id;
    const row = (
      await this.db.query(
        `
      SELECT w.balance_subunits,w.held_subunits,
        COALESCE((SELECT json_agg(entry) FROM (
          SELECT id::text,kind,amount_subunits::text,created_at
          FROM dream_ledger WHERE owner_id=$1 ORDER BY id DESC LIMIT 100
        ) entry),'[]'::json) AS ledger
      FROM (SELECT $1::uuid AS owner_id) owner LEFT JOIN dream_wallets w USING(owner_id)`,
        [ownerId],
      )
    )[0];
    const balance = BigInt(row?.balance_subunits ?? '0'),
      held = BigInt(row?.held_subunits ?? '0');
    return {
      sparks: await this.sparksWalletFor(ownerId),
      dreams: {
        ownerId,
        currency: 'dreams',
        balanceSubunits: balance.toString(),
        heldSubunits: held.toString(),
        availableSubunits: (balance - held).toString(),
        subunitsPerDream: '10000',
        spendingAvailable: true,
        ledger: row.ledger.map(camel),
      },
    };
  }
  private async sparksWalletFor(owner: string) {
    const row = (
      await this.db.query(
        `SELECT w.enabled,w.balance_subunits,w.held_subunits,
          COALESCE((SELECT json_agg(entry) FROM (
            SELECT id::text,kind,amount_subunits::text,created_at,
              CASE WHEN kind IN ('admin_credit','admin_debit') THEN evidence->>'reason' END AS reason
            FROM spark_ledger WHERE owner_id=$1 ORDER BY id DESC LIMIT 100
          ) entry),'[]'::json) AS ledger
         FROM (SELECT $1::uuid AS owner_id) owner LEFT JOIN spark_wallets w USING(owner_id)`,
        [owner],
      )
    )[0];
    const balance = BigInt(row?.balance_subunits ?? '0'),
      held = BigInt(row?.held_subunits ?? '0');
    return {
      ownerId: owner,
      enabled: row?.enabled ?? false,
      balanceSubunits: balance.toString(),
      heldSubunits: held.toString(),
      availableSubunits: (balance - held).toString(),
      subunitsPerSpark: '10000',
      rateVersion: SPARK_RATE_VERSION,
      purchaseAvailable: false,
      ledger: row.ledger.map(camel),
    };
  }
  @Get('store/packages')
  packages() {
    return [
      { id: 'spark', name: 'Искра путешествия', credits: 100, demo: true, available: false },
      { id: 'lantern', name: 'Свет фонаря', credits: 500, demo: true, available: false },
      { id: 'constellation', name: 'Созвездие', credits: 1200, demo: true, available: false },
    ];
  }
  @Get('taxonomy')
  async publicTaxonomy() {
    return normalizeTaxonomy(
      (await this.db.query("SELECT value FROM platform_settings WHERE key='taxonomy'"))[0].value,
    );
  }
  @Get('admin/taxonomy')
  async taxonomy(
    @Req()
    req: Request,
  ) {
    await this.auth.admin(req);
    return this.publicTaxonomy();
  }
  @Patch('admin/taxonomy')
  async editTaxonomy(
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.admin(req),
      b = taxonomyUpdateSchema.parse(body);
    if (
      new Set(b.genres).size !== b.genres.length ||
      new Set(b.tags.map((tag) => tag.id)).size !== b.tags.length
    )
      fail(400, 'VALIDATION_FAILED', 'Жанры и теги не должны повторяться.');
    const names = new Map<string, string>();
    for (const tag of b.tags)
      for (const name of [tag.id, ...tag.aliases]) {
        if (names.has(name) && names.get(name) !== tag.id)
          fail(400, 'VALIDATION_FAILED', 'Ambiguous tag alias.');
        names.set(name, tag.id);
      }
    return this.db.tx(async (c) => {
      const old = (
        await c.query("SELECT value FROM platform_settings WHERE key='taxonomy' FOR UPDATE")
      ).rows[0].value;
      if (
        old.tags.some(
          (tag: { id: string; aliases: string[] }) =>
            !b.tags.some(
              (next) =>
                next.id === tag.id && tag.aliases.every((alias) => next.aliases.includes(alias)),
            ),
        )
      )
        fail(400, 'VALIDATION_FAILED', 'Existing tag identifiers and aliases must be preserved.');
      const next = mergeTaxonomy(old, b);
      await c.query("UPDATE platform_settings SET value=$1,updated_at=now() WHERE key='taxonomy'", [
        JSON.stringify(next),
      ]);
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        'taxonomy.update',
        'taxonomy',
        JSON.stringify(next),
      ]);
      return next;
    });
  }
  @Get('admin/overview')
  async overview(
    @Req()
    req: Request,
  ) {
    await this.auth.admin(req);
    return (
      await this.db.query(
        'SELECT (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) AS users,(SELECT count(*)::int FROM adventures WHERE deleted_at IS NULL) AS adventures,(SELECT count(*)::int FROM adventures WHERE status=\'pending_review\') AS "pendingReview",(SELECT count(*)::int FROM reports WHERE status=\'open\') AS "openReports"',
      )
    )[0];
  }
  @Get('admin/users')
  async users(
    @Req()
    req: Request,
    @Query('q')
    q = '',
  ) {
    await this.auth.admin(req);
    return (
      await this.db.query(
        'SELECT * FROM users WHERE deleted_at IS NULL AND (email ILIKE $1 OR name ILIKE $1 OR handle ILIKE $1) ORDER BY created_at DESC LIMIT 200',
        [`%${q.slice(0, 100)}%`],
      )
    ).map(userView);
  }
  @Patch('admin/users/:id')
  async userRole(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.admin(req),
      b = z
        .object({ role: z.enum(['user', 'admin']) })
        .strict()
        .parse(body);
    if (u.id === id && b.role !== 'admin')
      fail(400, 'VALIDATION_FAILED', 'Нельзя снять собственные права администратора.');
    const row = await this.db.tx(async (c) => {
      const r = await c.query(
        'UPDATE users SET role=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING *',
        [id, b.role],
      );
      if (!r.rows[0]) fail(404, 'NOT_FOUND', 'Пользователь не найден.');
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        'user.role',
        id,
        JSON.stringify(b),
      ]);
      return r.rows[0];
    });
    return userView(row);
  }
  @Get('admin/adventures')
  async adventures(@Req() req: Request, @Query('status') status = '') {
    const u = await this.auth.admin(req);
    return (
      await this.db.query(
        adventureSelect.replace(
          'SELECT a.*,',
          `SELECT a.*,${adminDeletionRevisionSql()} AS deletion_revision,`,
        ) +
          ` WHERE ($1='' OR CASE WHEN a.visibility='private' AND a.owner_id<>$2 THEN 'published' ELSE a.status END=$1) AND a.deleted_at IS NULL AND ${adminAdventureAccessSql('$2')} ORDER BY a.updated_at DESC LIMIT 200`,
        [status, u.id],
      )
    ).map((r) => ({
      deletionRevision: r.deletion_revision,
      ...adventureView(
        r,
        r.owner_id !== u.id && (r.visibility === 'private' || r.status !== 'pending_review'),
        r.owner_id !== u.id,
        r.owner_id !== u.id && r.visibility === 'public' && r.status === 'pending_review',
      ),
    }));
  }
  @Get('admin/adventures/deleted')
  async deletedAdventures(@Req() req: Request) {
    return deletedStories(this.db, (await this.auth.admin(req)).id);
  }
  @Delete('admin/adventures/:id')
  async removeAdventure(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const admin = await this.auth.admin(req);
    return removeStory(this.db, admin.id, id, body, (client, owner) =>
      this.art.lockAuthor(client, owner),
    );
  }
  @Post('admin/adventures/:id/restore')
  async restoreAdventure(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const admin = await this.auth.admin(req);
    return restoreStory(this.db, admin.id, id, body, (client, owner) =>
      this.art.lockAuthor(client, owner),
    );
  }
  @Get('admin/npcs')
  async npcs(@Req() req: Request) {
    const u = await this.auth.admin(req);
    const rows = await this.db.query(
      `WITH visible AS (
        SELECT n.id::text AS id,n.owner_id,n.data,n.created_at,n.updated_at,
          CASE WHEN n.owner_id=$1 THEN 0 ELSE 1 END AS priority
        FROM npcs n WHERE n.owner_id=$1 OR EXISTS(
          SELECT 1 FROM adventures a WHERE a.owner_id=n.owner_id
          AND (n.story_id IS NULL OR n.story_id=a.id)
          AND a.data->'content'->'npcIds' ? n.id::text
          AND a.visibility='public' AND a.status IN('pending_review','published'))
      ), chosen AS (SELECT DISTINCT ON (id) * FROM visible ORDER BY id,priority,updated_at DESC)
      SELECT id,owner_id,data,created_at,updated_at FROM chosen ORDER BY updated_at DESC,id LIMIT 200`,
      [u.id],
    );
    return rows.map((r) => {
      const safe = { ...r.data };
      if (r.owner_id !== u.id) {
        delete safe.secrets;
        delete safe.biography;
        delete safe.characterProfile;
        Object.assign(safe, safeNpcMetadata(r.data));
      }
      return { ...safe, ...camel({ ...r, data: undefined }) };
    });
  }
  @Post('admin/adventures/:id/moderate')
  async moderate(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.admin(req),
      b = z
        .object({
          decision: z.enum(['approve', 'reject', 'quarantine']),
          reviewedPlayableVersionId: z.uuid().nullable().optional(),
          reason: z.string().trim().min(3).max(2000),
        })
        .strict()
        .parse(body);
    const pre = (
      await this.db.query('SELECT * FROM adventures WHERE id=$1 AND deleted_at IS NULL', [id])
    )[0];
    if (!pre || pre.visibility !== 'public') fail(404, 'NOT_FOUND', 'Приключение не найдено.');
    if (b.decision === 'approve')
      await this.content.validateReferences(
        pre.owner_id as string,
        adventureSchema.parse(pre.data),
        true,
        id,
      );
    await this.db.tx(async (c) => {
      await this.art.lockAuthor(c, String(pre.owner_id));
      const row = (
        await c.query('SELECT * FROM adventures WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [
          id,
        ])
      ).rows[0];
      if (!row) fail(404, 'NOT_FOUND', 'NOT_FOUND');
      if (row.visibility !== 'public')
        fail(409, 'STATE_CONFLICT', 'Приватное приключение не публикуется.');
      if (b.decision === 'approve') {
        if (row.status !== 'pending_review')
          fail(409, 'STATE_CONFLICT', 'История должна ожидать модерации.');
        if (
          row.submitted_game_version_id &&
          b.reviewedPlayableVersionId !== row.submitted_game_version_id
        )
          fail(409, 'STALE_REVIEW', 'Reload the submitted playable review before approval.');
        if (row.submitted_game_version_id)
          await this.art.assertPinsAvailable(c, row.submitted_game_version_id);
        await this.content.validateReferences(
          row.owner_id as string,
          adventureSchema.parse(row.data),
          true,
          id,
        );
        const version = Number(row.version) + 1;
        const npcRows = (
          await c.query('SELECT id,data FROM npcs WHERE id=ANY($1::uuid[]) AND owner_id=$2', [
            row.data.content.npcIds,
            row.owner_id,
          ])
        ).rows;
        const publicNpcs = npcRows.map((n) => {
          const {
            secrets: _secrets,
            biography: _biography,
            characterProfile: _characterProfile,
            ...safe
          } = n.data;
          return { ...safe, ...safeNpcMetadata(n.data), id: n.id };
        });
        const snapshot = {
          ...row.data,
          content: readerStoryContent(row.data.content),
          status: 'published',
          publicNpcs,
          playableVersionId: row.submitted_game_version_id ?? null,
        };
        const privateVersion = {
          ...snapshot,
          content: row.data.content,
          npcDefinitions: npcRows.map((n) => ({ ...n.data, id: n.id })),
        };
        const savedVersion = await c.query(
          'INSERT INTO adventure_versions(adventure_id,version,snapshot) VALUES($1,$2,$3) RETURNING id',
          [id, version, JSON.stringify(privateVersion)],
        );
        if (row.submitted_game_version_id)
          await c.query(
            'INSERT INTO game_playable_approvals(playable_version_id,adventure_version_id) VALUES($1,$2)',
            [row.submitted_game_version_id, savedVersion.rows[0].id],
          );
        await c.query(
          "UPDATE adventures SET version=$2,status='published',published_snapshot=$3,updated_at=now() WHERE id=$1",
          [id, version, JSON.stringify(snapshot)],
        );
      } else if (b.decision === 'reject') {
        await c.query("UPDATE adventures SET status='draft',updated_at=now() WHERE id=$1", [id]);
      } else {
        await c.query(
          "UPDATE adventures SET status='archived',published_snapshot=NULL,updated_at=now() WHERE id=$1",
          [id],
        );
      }
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        `adventure.${b.decision}`,
        id,
        JSON.stringify({ reason: b.reason }),
      ]);
      await c.query(
        "INSERT INTO notifications(user_id,title,message,type,payload) VALUES($1,'','','moderation',$2)",
        [
          row.owner_id,
          JSON.stringify({ title: row.title, reason: b.reason, decision: b.decision }),
        ],
      );
    });
    return adventureView((await this.db.query(adventureSelect + ' WHERE a.id=$1', [id]))[0]);
  }
  @Get('admin/reports')
  async reports(@Req() req: Request) {
    const u = await this.auth.admin(req);
    return (
      await this.db.query(
        `SELECT r.*,CASE
      WHEN a.owner_id=$1 THEN a.title
      WHEN a.visibility='private' AND a.private_release_id IS NOT NULL AND a.status<>'archived' AND EXISTS(SELECT 1 FROM adventure_invitations i WHERE i.adventure_id=a.id AND i.recipient_id=$1 AND i.status='accepted') THEN (SELECT pr.snapshot->>'title' FROM adventure_private_releases pr WHERE pr.id=a.private_release_id)
      WHEN a.visibility='public' AND a.status='pending_review' THEN a.title
      WHEN a.visibility='public' AND a.published_snapshot IS NOT NULL AND a.status<>'archived' THEN a.published_snapshot->>'title'
      ELSE NULL END AS adventure_title
      FROM reports r JOIN adventures a ON a.id=r.adventure_id ORDER BY r.created_at DESC LIMIT 200`,
        [u.id],
      )
    ).map(camel);
  }
  @Patch('admin/reports/:id')
  async resolve(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.admin(req),
      b = z
        .object({
          status: z.enum(['resolved', 'dismissed']),
          resolution: z.string().trim().min(3).max(2000),
        })
        .strict()
        .parse(body);
    return this.db.tx(async (c) => {
      const r = await c.query(
        'UPDATE reports SET status=$2,resolution=$3 WHERE id=$1 RETURNING *',
        [id, b.status, b.resolution],
      );
      if (!r.rows[0]) fail(404, 'NOT_FOUND', 'Жалоба не найдена.');
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        'report.resolve',
        id,
        JSON.stringify(b),
      ]);
      return camel(r.rows[0]);
    });
  }
  @Get('admin/audit')
  async audit(
    @Req()
    req: Request,
  ) {
    await this.auth.admin(req);
    return (
      await this.db.query(
        'SELECT a.*,u.name AS actor_name FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 200',
      )
    ).map(camel);
  }
  @Get('admin/models')
  async models(
    @Req()
    req: Request,
  ) {
    await this.auth.admin(req);
    return (await this.db.query('SELECT * FROM model_profiles ORDER BY name')).map(camel);
  }
  @Post('admin/models')
  async createModel(
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.admin(req),
      b = modelSchema.parse(body);
    return this.db.tx(async (c) => {
      const row = (
        await c.query(
          'INSERT INTO model_profiles(key,name,description,instructions,enabled) VALUES($1,$2,$3,$4,$5) RETURNING *',
          [b.key, b.name, b.description, b.instructions, b.enabled],
        )
      ).rows[0];
      await c.query(
        'INSERT INTO model_profile_versions(model_id,version,snapshot) VALUES($1,1,$2)',
        [row.id, JSON.stringify(b)],
      );
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        'model.create',
        row.id,
        JSON.stringify({ key: b.key }),
      ]);
      return camel(row);
    });
  }
  @Patch('admin/models/:id')
  async editModel(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.admin(req),
      patch = parsePatch(modelSchema.partial(), body);
    return this.db.tx(async (c) => {
      const old = (await c.query('SELECT * FROM model_profiles WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!old) fail(404, 'NOT_FOUND', 'Профиль не найден.');
      const b = modelSchema.parse({
        key: old.key,
        name: old.name,
        description: old.description,
        instructions: old.instructions,
        enabled: old.enabled,
        ...patch,
      });
      const row = (
        await c.query(
          'UPDATE model_profiles SET key=$2,name=$3,description=$4,instructions=$5,enabled=$6,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
          [id, b.key, b.name, b.description, b.instructions, b.enabled],
        )
      ).rows[0];
      await c.query(
        'INSERT INTO model_profile_versions(model_id,version,snapshot) VALUES($1,$2,$3)',
        [id, row.version, JSON.stringify(b)],
      );
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        'model.update',
        id,
        JSON.stringify({ version: row.version }),
      ]);
      return camel(row);
    });
  }
  @Get('admin/runtimes')
  async runtimes(
    @Req()
    req: Request,
  ) {
    await this.auth.admin(req);
    return (await this.db.query('SELECT * FROM runtime_profiles ORDER BY created_at')).map(camel);
  }
  private validateRuntime(b: z.infer<typeof runtimeSchema>) {
    if (b.provider !== b.endpointId)
      fail(400, 'VALIDATION_FAILED', 'Endpoint должен соответствовать провайдеру.');
    if (b.provider !== 'mock' && b.enabled)
      fail(400, 'VALIDATION_FAILED', 'Реальные провайдеры отключены на этапе платформы.');
  }
  @Post('admin/runtimes')
  async createRuntime(
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.admin(req),
      b = runtimeSchema.parse(body);
    this.validateRuntime(b);
    return this.db.tx(async (c) => {
      const row = (
        await c.query(
          'INSERT INTO runtime_profiles(name,provider,model,enabled,endpoint_id,max_input_tokens,max_output_tokens,timeout_ms,concurrency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [
            b.name,
            b.provider,
            b.model,
            b.enabled,
            b.endpointId,
            b.maxInputTokens,
            b.maxOutputTokens,
            b.timeoutMs,
            b.concurrency,
          ],
        )
      ).rows[0];
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        'runtime.create',
        row.id,
        JSON.stringify({ provider: b.provider }),
      ]);
      return camel(row);
    });
  }
  @Patch('admin/runtimes/:id')
  async editRuntime(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.admin(req),
      patch = parsePatch(runtimeSchema.partial(), body);
    return this.db.tx(async (c) => {
      const old = (await c.query('SELECT * FROM runtime_profiles WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!old) fail(404, 'NOT_FOUND', 'Runtime не найден.');
      const b = runtimeSchema.parse({
        name: old.name,
        provider: old.provider,
        model: old.model,
        enabled: old.enabled,
        endpointId: old.endpoint_id,
        maxInputTokens: old.max_input_tokens,
        maxOutputTokens: old.max_output_tokens,
        timeoutMs: old.timeout_ms,
        concurrency: old.concurrency,
        ...patch,
      });
      this.validateRuntime(b);
      const row = (
        await c.query(
          'UPDATE runtime_profiles SET name=$2,provider=$3,model=$4,enabled=$5,endpoint_id=$6,max_input_tokens=$7,max_output_tokens=$8,timeout_ms=$9,concurrency=$10,updated_at=now() WHERE id=$1 RETURNING *',
          [
            id,
            b.name,
            b.provider,
            b.model,
            b.enabled,
            b.endpointId,
            b.maxInputTokens,
            b.maxOutputTokens,
            b.timeoutMs,
            b.concurrency,
          ],
        )
      ).rows[0];
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        'runtime.update',
        id,
        JSON.stringify({ provider: b.provider }),
      ]);
      return camel(row);
    });
  }
  @Post('admin/credits')
  async credits(
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.admin(req),
      b = z
        .object({
          userId: z.string().uuid(),
          amount: z
            .number()
            .int()
            .min(-922337203685477)
            .max(922337203685477)
            .refine((n) => n !== 0),
          reason: z.string().trim().min(3).max(500),
          idempotencyKey: z.string().min(8).max(120),
        })
        .strict()
        .parse(body);
    const delta = BigInt(b.amount) * 10000n;
    const eventKey = `admin-adjust:v1:${b.idempotencyKey}`;
    await this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [eventKey]);
      const prior = (await c.query('SELECT * FROM spark_ledger WHERE event_key=$1', [eventKey]))
        .rows[0];
      if (prior) {
        if (
          prior.owner_id !== b.userId ||
          prior.kind !== (delta > 0n ? 'admin_credit' : 'admin_debit') ||
          BigInt(prior.amount_subunits) !== (delta > 0n ? delta : -delta) ||
          prior.evidence.reason !== b.reason ||
          prior.evidence.actorId !== u.id
        )
          fail(409, 'STATE_CONFLICT', 'Ключ операции уже использован с другими данными.');
        return;
      }
      const target = (
        await c.query(
          'SELECT id,starter_sparks_eligible,starter_dreams_eligible FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE',
          [b.userId],
        )
      ).rows[0];
      if (!target) fail(404, 'NOT_FOUND', 'Кошелёк не найден.');
      // Do not create a wallet before the recipient's verification-only welcome gift.
      if (target.starter_sparks_eligible || target.starter_dreams_eligible)
        fail(
          409,
          'SPARKS_RECIPIENT_VERIFICATION_REQUIRED',
          'Сначала получатель должен подтвердить почту.',
        );
      await c.query(
        'INSERT INTO spark_wallets(owner_id,enabled) VALUES($1,true) ON CONFLICT(owner_id) DO NOTHING',
        [b.userId],
      );
      const wallet = (
        await c.query(
          'SELECT balance_subunits,held_subunits FROM spark_wallets WHERE owner_id=$1 FOR UPDATE',
          [b.userId],
        )
      ).rows[0];
      const next = BigInt(wallet.balance_subunits) + delta;
      if (next < BigInt(wallet.held_subunits))
        fail(409, 'INSUFFICIENT_SPARKS', 'Недостаточно Искр.');
      if (next > 9223372036854775807n)
        fail(409, 'STATE_CONFLICT', 'Баланс превышает допустимую точность.');
      // Enforce actual Sparks accounting for explicitly adjusted wallets, never free-provider opt-out.
      await c.query('UPDATE spark_wallets SET balance_subunits=$2,enabled=true WHERE owner_id=$1', [
        b.userId,
        next.toString(),
      ]);
      const evidence = {
        actorId: u.id,
        reason: b.reason,
        amount: b.amount,
        idempotencyKey: b.idempotencyKey,
      };
      await c.query(
        'INSERT INTO spark_ledger(owner_id,hold_id,event_key,kind,amount_subunits,evidence) VALUES($1,NULL,$2,$3,$4,$5)',
        [
          b.userId,
          eventKey,
          delta > 0n ? 'admin_credit' : 'admin_debit',
          (delta > 0n ? delta : -delta).toString(),
          JSON.stringify(evidence),
        ],
      );
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        'sparks.adjust',
        b.userId,
        JSON.stringify(evidence),
      ]);
    });
    return this.sparksWalletFor(b.userId);
  }
}
