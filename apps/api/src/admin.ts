import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  modelSchema,
  controlledTagSchema,
  runtimeSchema,
  adventureSchema,
  parsePatch,
  safeNpcMetadata,
} from '@dreamwalk/contracts';
import { Db, camel } from './db';
import { Auth, userView } from './auth';
import { adventureSelect, adventureView, Content, readableAdventureSql } from './content';
import { fail } from './errors';
@Controller('api/v1')
export class AdminController {
  constructor(
    @Inject(Db)
    private db: Db,
    @Inject(Auth)
    private auth: Auth,
    @Inject(Content)
    private content: Content,
  ) {}
  private async walletFor(id: string) {
    const row = (await this.db.query('SELECT balance FROM wallets WHERE user_id=$1', [id]))[0];
    return {
      balance: row?.balance ?? 0,
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
  @Get('store/packages')
  packages() {
    return [
      { id: 'spark', name: 'Искра путешествия', credits: 100, demo: true, available: false },
      { id: 'lantern', name: 'Свет фонаря', credits: 500, demo: true, available: false },
      { id: 'constellation', name: 'Созвездие', credits: 1200, demo: true, available: false },
    ];
  }
  @Get('admin/taxonomy')
  async taxonomy(
    @Req()
    req: Request,
  ) {
    await this.auth.admin(req);
    return (await this.db.query("SELECT value FROM platform_settings WHERE key='taxonomy'"))[0]
      .value;
  }
  @Patch('admin/taxonomy')
  async editTaxonomy(
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.admin(req),
      b = z
        .object({
          genres: z.array(z.string().trim().min(2).max(40)).min(1).max(50),
          tags: z.array(controlledTagSchema).max(100),
        })
        .strict()
        .parse(body);
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
      await c.query("UPDATE platform_settings SET value=$1,updated_at=now() WHERE key='taxonomy'", [
        JSON.stringify(b),
      ]);
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        'taxonomy.update',
        'taxonomy',
        JSON.stringify(b),
      ]);
      return b;
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
        'SELECT (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) AS users,(SELECT count(*)::int FROM adventures) AS adventures,(SELECT count(*)::int FROM adventures WHERE status=\'pending_review\') AS "pendingReview",(SELECT count(*)::int FROM reports WHERE status=\'open\') AS "openReports"',
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
        adventureSelect +
          ` WHERE ($1='' OR a.status=$1) AND ((a.visibility='public' AND (a.status IN('pending_review','published') OR a.published_snapshot IS NOT NULL)) OR ${readableAdventureSql('$2')}) ORDER BY a.updated_at DESC LIMIT 200`,
        [status, u.id],
      )
    ).map((r) =>
      adventureView(
        r,
        r.owner_id !== u.id && r.visibility === 'public' && r.status !== 'pending_review',
      ),
    );
  }
  @Get('admin/npcs')
  async npcs(@Req() req: Request) {
    const u = await this.auth.admin(req);
    const rows = await this.db.query(
      `SELECT n.id,n.owner_id,n.data,n.created_at,n.updated_at FROM npcs n WHERE n.owner_id=$1 OR EXISTS(SELECT 1 FROM adventures a WHERE a.owner_id=n.owner_id AND a.data->'content'->'npcIds' ? n.id::text AND ((a.visibility='public' AND a.status IN('pending_review','published')) OR (a.visibility='private' AND a.status<>'archived' AND EXISTS(SELECT 1 FROM adventure_invitations i WHERE i.adventure_id=a.id AND i.recipient_id=$1 AND i.status='accepted')))) ORDER BY n.updated_at DESC LIMIT 200`,
      [u.id],
    );
    return rows.map((r) => {
      const safe = { ...r.data };
      if (r.owner_id !== u.id) {
        delete safe.secrets;
        delete safe.biography;
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
          reason: z.string().trim().min(3).max(2000),
        })
        .strict()
        .parse(body);
    const pre = (await this.db.query('SELECT * FROM adventures WHERE id=$1', [id]))[0];
    if (!pre || pre.visibility !== 'public') fail(404, 'NOT_FOUND', 'Приключение не найдено.');
    if (b.decision === 'approve')
      await this.content.validateReferences(
        pre.owner_id as string,
        adventureSchema.parse(pre.data),
        true,
      );
    await this.db.tx(async (c) => {
      const row = (await c.query('SELECT * FROM adventures WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (row.visibility !== 'public')
        fail(409, 'STATE_CONFLICT', 'Приватное приключение не публикуется.');
      if (b.decision === 'approve') {
        if (row.status !== 'pending_review')
          fail(409, 'STATE_CONFLICT', 'История должна ожидать модерации.');
        await this.content.validateReferences(
          row.owner_id as string,
          adventureSchema.parse(row.data),
          true,
        );
        const version = Number(row.version) + 1;
        const npcRows = (
          await c.query('SELECT id,data FROM npcs WHERE id=ANY($1::uuid[]) AND owner_id=$2', [
            row.data.content.npcIds,
            row.owner_id,
          ])
        ).rows;
        const publicNpcs = npcRows.map((n) => {
          const { secrets: _secrets, biography: _biography, ...safe } = n.data;
          return { ...safe, ...safeNpcMetadata(n.data), id: n.id };
        });
        const snapshot = { ...row.data, status: 'published', publicNpcs };
        const privateVersion = {
          ...snapshot,
          npcDefinitions: npcRows.map((n) => ({ ...n.data, id: n.id })),
        };
        await c.query(
          'INSERT INTO adventure_versions(adventure_id,version,snapshot) VALUES($1,$2,$3)',
          [id, version, JSON.stringify(privateVersion)],
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
      WHEN a.owner_id=$1 OR (a.visibility='private' AND a.status<>'archived' AND EXISTS(SELECT 1 FROM adventure_invitations i WHERE i.adventure_id=a.id AND i.recipient_id=$1 AND i.status='accepted')) THEN a.title
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
            .min(-100000)
            .max(100000)
            .refine((n) => n !== 0),
          reason: z.string().trim().min(3).max(500),
          idempotencyKey: z.string().min(8).max(120),
        })
        .strict()
        .parse(body);
    await this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [b.idempotencyKey]);
      const prior = (await c.query('SELECT * FROM ledger WHERE source_key=$1', [b.idempotencyKey]))
        .rows[0];
      if (prior) {
        if (prior.user_id !== b.userId || prior.amount !== b.amount || prior.reason !== b.reason)
          fail(409, 'STATE_CONFLICT', 'Ключ операции уже использован с другими данными.');
        return;
      }
      const wallet = (
        await c.query(
          'SELECT w.balance FROM wallets w JOIN users u ON u.id=w.user_id WHERE user_id=$1 AND u.deleted_at IS NULL FOR UPDATE OF w',
          [b.userId],
        )
      ).rows[0];
      if (!wallet) fail(404, 'NOT_FOUND', 'Кошелёк не найден.');
      if (wallet.balance + b.amount < 0)
        fail(409, 'INSUFFICIENT_CREDITS', 'Недостаточно демонстрационных Искр.');
      await c.query('UPDATE wallets SET balance=balance+$2 WHERE user_id=$1', [b.userId, b.amount]);
      await c.query(
        'INSERT INTO ledger(user_id,amount,reason,source_key,actor_id) VALUES($1,$2,$3,$4,$5)',
        [b.userId, b.amount, b.reason, b.idempotencyKey, u.id],
      );
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        'wallet.adjust',
        b.userId,
        JSON.stringify({ amount: b.amount, reason: b.reason, sourceKey: b.idempotencyKey }),
      ]);
    });
    return this.walletFor(b.userId);
  }
}
