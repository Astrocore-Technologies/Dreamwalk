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
  Req,
  Res,
} from '@nestjs/common';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  registerSchema,
  loginSchema,
  profileSchema,
  settingsSchema,
  parsePatch,
  type User,
} from '@dreamwalk/contracts';
import { Db, camel } from './db';
import { config } from './config';
import { fail } from './errors';
import { mailEnabled, sendAccountMail } from './mail';
const scrypt = promisify(scryptCb);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [type, salt, key] = stored.split(':');
  if (type !== 'scrypt' || !salt || !key) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(key, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function userView(row: Record<string, unknown>): User {
  const u = camel(row);
  delete u.passwordHash;
  delete u.deletedAt;
  delete u.tokenHash;
  return { ...u, settings: settingsSchema.parse(row.settings ?? {}) } as unknown as User;
}
function cookieToken(req: Request) {
  return (req.headers.cookie ?? '')
    .split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith('dreamwalk_session='))
    ?.slice(18);
}
export const tokenHash = (v: string) => createHash('sha256').update(v).digest('hex');
@Injectable()
export class Auth {
  constructor(
    @Inject(Db)
    readonly db: Db,
  ) {}
  async current(req: Request): Promise<User | null> {
    const token = cookieToken(req);
    if (!token || token.length !== 64) return null;
    const rows = await this.db.query(
      'SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.deleted_at IS NULL',
      [tokenHash(token)],
    );
    if (rows[0])
      await this.db.query(
        "UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1 AND expires_at>now() AND last_seen_at<now()-interval '1 minute' AND EXISTS(SELECT 1 FROM users u WHERE u.id=sessions.user_id AND u.deleted_at IS NULL)",
        [tokenHash(token)],
      );
    return rows[0] ? userView(rows[0]) : null;
  }
  async require(req: Request) {
    return (await this.current(req)) ?? fail(401, 'UNAUTHORIZED', 'Войдите в аккаунт.');
  }
  async admin(req: Request) {
    const u = await this.require(req);
    if (u.role !== 'admin') fail(403, 'FORBIDDEN', 'Доступ только для администратора.');
    return u;
  }
  async session(user: User, req: Request, res: Response) {
    const token = randomBytes(32).toString('hex');
    await this.db.query(
      "INSERT INTO sessions(user_id,token_hash,user_agent,expires_at) VALUES($1,$2,$3,now()+interval '14 days')",
      [user.id, tokenHash(token), (req.headers['user-agent'] ?? '').slice(0, 300)],
    );
    res.cookie('dreamwalk_session', token, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 14 * 86400000,
    });
  }
  async ownedAsset(userId: string, id: string | null | undefined) {
    if (!id) return;
    const rows = await this.db.query('SELECT id FROM assets WHERE id=$1 AND owner_id=$2', [
      id,
      userId,
    ]);
    if (!rows.length) fail(403, 'FORBIDDEN', 'Изображение недоступно.');
  }
  async currentSessionId(req: Request) {
    const token = cookieToken(req);
    if (!token) return null;
    const rows = await this.db.query('SELECT id FROM sessions WHERE token_hash=$1', [
      tokenHash(token),
    ]);
    return rows[0]?.id as string | undefined;
  }
}
@Controller('api/v1')
export class AccountController {
  constructor(
    @Inject(Auth)
    private auth: Auth,
    @Inject(Db)
    private db: Db,
  ) {}
  @Get('auth/me')
  async me(
    @Req()
    req: Request,
  ) {
    return { user: await this.auth.current(req) };
  }
  @Post('auth/register')
  async register(
    @Body()
    body: unknown,
    @Req()
    req: Request,
    @Res({ passthrough: true })
    res: Response,
  ) {
    const b = registerSchema.parse(body);
    const hash = await hashPassword(b.password);
    const row = await this.db.tx(async (c) => {
      const r = await c.query(
        'INSERT INTO users(email,password_hash,name,handle,settings) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [b.email, hash, b.name, b.handle, JSON.stringify(settingsSchema.parse({}))],
      );
      await c.query('INSERT INTO wallets(user_id) VALUES($1)', [r.rows[0].id]);
      await c.query(
        "INSERT INTO notifications(user_id,title,message,type,payload) VALUES($1,'','','welcome','{}')",
        [r.rows[0].id],
      );
      return r.rows[0];
    });
    const user = userView(row);
    await this.auth.session(user, req, res);
    return { user };
  }
  @Post('auth/login')
  async login(
    @Body()
    body: unknown,
    @Req()
    req: Request,
    @Res({ passthrough: true })
    res: Response,
  ) {
    const b = loginSchema.parse(body);
    const rows = await this.db.query('SELECT * FROM users WHERE email=$1 AND deleted_at IS NULL', [
      b.email,
    ]);
    const hash = rows[0]?.password_hash as string | undefined;
    const valid = await verifyPassword(
      b.password,
      hash ?? 'scrypt:00000000000000000000000000000000:' + '00'.repeat(64),
    );
    if (!rows[0] || !valid) fail(401, 'UNAUTHORIZED', 'Неверный email или пароль.');
    const user = userView(rows[0]);
    await this.auth.session(user, req, res);
    return { user };
  }
  @Post('auth/logout')
  async logout(
    @Req()
    req: Request,
    @Res({ passthrough: true })
    res: Response,
  ) {
    const id = await this.auth.currentSessionId(req);
    if (id) await this.db.query('DELETE FROM sessions WHERE id=$1', [id]);
    res.clearCookie('dreamwalk_session', { path: '/' });
    return { ok: true };
  }
  private async requestEmail(email: string, purpose: 'reset' | 'verify') {
    if (!mailEnabled) return { ok: true, code: 'EMAIL_DELIVERY_UNAVAILABLE' };
    const token = randomBytes(32).toString('hex');
    const recipient = await this.db.tx(async (c) => {
      await c.query(
        "DELETE FROM auth_email_cooldowns WHERE (address_hash,purpose) IN (SELECT address_hash,purpose FROM auth_email_cooldowns WHERE requested_at < now()-interval '1 day' LIMIT 1000)",
      );
      await c.query(
        "DELETE FROM auth_email_tokens WHERE token_hash IN (SELECT token_hash FROM auth_email_tokens WHERE expires_at < now()-interval '1 day' LIMIT 1000)",
      );
      // Persist a cooldown even for nonexistent addresses: identical response and rate semantics.
      const allowed = await c.query(
        "INSERT INTO auth_email_cooldowns(address_hash,purpose) VALUES($1,$2) ON CONFLICT(address_hash,purpose) DO UPDATE SET requested_at=now() WHERE auth_email_cooldowns.requested_at < now()-interval '1 minute' RETURNING address_hash",
        [tokenHash(email), purpose],
      );
      if (!allowed.rowCount) return null;
      const row = (
        await c.query('SELECT * FROM users WHERE email=$1 AND deleted_at IS NULL FOR UPDATE', [
          email,
        ])
      ).rows[0];
      if (!row || (purpose === 'verify' && row.email_verified)) return null;
      await c.query('DELETE FROM auth_email_tokens WHERE user_id=$1 AND purpose=$2', [
        row.id,
        purpose,
      ]);
      await c.query(
        "INSERT INTO auth_email_tokens(token_hash,user_id,purpose,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes')",
        [tokenHash(token), row.id, purpose],
      );
      return row;
    });
    if (recipient) {
      // Delivery is deliberately detached from the uniform response; never log tokens or SMTP errors.
      void sendAccountMail(email, purpose, token, recipient.settings?.language ?? 'en').catch(
        async () => {
          await this.db
            .query('DELETE FROM auth_email_tokens WHERE token_hash=$1', [tokenHash(token)])
            .catch(() => undefined);
        },
      );
    }
    return { ok: true, code: 'REQUEST_ACCEPTED' };
  }
  @Post('auth/reset-password')
  async reset(@Body() body: unknown) {
    const b = z
      .object({
        email: z
          .email()
          .max(254)
          .transform((v) => v.toLowerCase()),
      })
      .strict()
      .parse(body);
    return this.requestEmail(b.email, 'reset');
  }
  @Post('account/email-verification/request')
  async requestVerification(@Req() req: Request) {
    const user = await this.auth.require(req);
    return this.requestEmail(user.email, 'verify');
  }
  private async consumeEmailToken(token: unknown, purpose: 'reset' | 'verify', password?: string) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
      fail(400, 'TOKEN_INVALID', 'Invalid token.');
    const passwordHash = password ? await hashPassword(password) : undefined;
    await this.db.tx(async (c) => {
      const candidate = (
        await c.query('SELECT user_id FROM auth_email_tokens WHERE token_hash=$1', [
          tokenHash(token as string),
        ])
      ).rows[0];
      if (!candidate) fail(400, 'TOKEN_INVALID', 'Invalid token.');
      // Match request/password/deletion lock order: user first, then bearer row.
      const user = (
        await c.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [
          candidate.user_id,
        ])
      ).rows[0];
      if (!user) fail(400, 'TOKEN_INVALID', 'Invalid token.');
      const row = (
        await c.query(
          'SELECT user_id FROM auth_email_tokens WHERE token_hash=$1 AND user_id=$2 AND purpose=$3 AND used_at IS NULL AND expires_at>now() FOR UPDATE',
          [tokenHash(token as string), user.id, purpose],
        )
      ).rows[0];
      if (!row) fail(400, 'TOKEN_INVALID', 'Invalid token.');
      await c.query('UPDATE auth_email_tokens SET used_at=now() WHERE token_hash=$1', [
        tokenHash(token as string),
      ]);
      if (purpose === 'reset') {
        await c.query('UPDATE users SET password_hash=$2 WHERE id=$1', [row.user_id, passwordHash]);
        await c.query('DELETE FROM sessions WHERE user_id=$1', [row.user_id]);
      } else {
        await c.query('UPDATE users SET email_verified=true WHERE id=$1', [row.user_id]);
      }
    });
    return { ok: true };
  }
  @Post('auth/reset-password/confirm')
  async confirmReset(@Body() body: unknown) {
    const b = z
      .object({ token: z.unknown(), password: z.string().min(10).max(128) })
      .strict()
      .parse(body);
    return this.consumeEmailToken(b.token, 'reset', b.password);
  }
  @Post('auth/verify-email')
  async verifyEmail(@Body() body: unknown) {
    const b = z.object({ token: z.unknown() }).strict().parse(body);
    return this.consumeEmailToken(b.token, 'verify');
  }
  @Patch('account/profile')
  async profile(
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req),
      b = profileSchema.parse(body);
    await this.auth.ownedAsset(u.id, b.avatarAssetId);
    const rows = await this.db.query(
      'UPDATE users SET name=$2,handle=$3,bio=$4,avatar_asset_id=$5 WHERE id=$1 RETURNING *',
      [
        u.id,
        b.name ?? u.name,
        b.handle ?? u.handle,
        b.bio ?? u.bio,
        b.avatarAssetId === undefined ? u.avatarAssetId : b.avatarAssetId,
      ],
    );
    return userView(rows[0]);
  }
  @Patch('account/settings')
  async settings(
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req),
      b = parsePatch(settingsSchema.partial().strict(), body);
    const rows = await this.db.query('UPDATE users SET settings=$2 WHERE id=$1 RETURNING *', [
      u.id,
      JSON.stringify({ ...u.settings, ...b }),
    ]);
    return userView(rows[0]);
  }
  @Post('account/onboarding')
  async onboarding(
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req);
    const b = z
      .object({
        name: z.string().trim().min(2).max(60).optional(),
        genres: z.array(z.string().max(50)).max(12).optional(),
        purpose: z.enum(['play', 'create', 'both']).optional(),
        profilePublic: z.boolean().optional(),
      })
      .strict()
      .parse(body);
    const { name, ...settings } = b;
    const rows = await this.db.query(
      'UPDATE users SET name=$2,settings=$3,onboarded=true WHERE id=$1 RETURNING *',
      [u.id, name ?? u.name, JSON.stringify({ ...u.settings, ...settings })],
    );
    return userView(rows[0]);
  }
  @Get('account/sessions')
  async sessions(
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req),
      current = await this.auth.currentSessionId(req);
    return (
      await this.db.query(
        'SELECT id,created_at,last_seen_at,user_agent FROM sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC',
        [u.id],
      )
    ).map((r) => ({ ...camel(r), current: r.id === current }));
  }
  @Delete('account/sessions/:id')
  async revoke(
    @Param('id')
    id: string,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req);
    await this.db.query('DELETE FROM sessions WHERE id=$1 AND user_id=$2', [id, u.id]);
    return { ok: true };
  }
  @Post('account/password')
  async password(
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req),
      b = z
        .object({ currentPassword: z.string().max(128), newPassword: z.string().min(10).max(128) })
        .strict()
        .parse(body);
    const row = (await this.db.query('SELECT password_hash FROM users WHERE id=$1', [u.id]))[0];
    if (!(await verifyPassword(b.currentPassword, row.password_hash as string)))
      fail(403, 'FORBIDDEN', 'Неверный текущий пароль.');
    const hash = await hashPassword(b.newPassword),
      id = await this.auth.currentSessionId(req);
    await this.db.tx(async (c) => {
      await c.query('UPDATE users SET password_hash=$2 WHERE id=$1', [u.id, hash]);
      await c.query('DELETE FROM sessions WHERE user_id=$1 AND id<>$2', [u.id, id]);
      await c.query("DELETE FROM auth_email_tokens WHERE user_id=$1 AND purpose='reset'", [u.id]);
    });
    return { ok: true };
  }
  @Post('account/export')
  async exportData(
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req);
    return this.db.tx(async (c) => {
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [u.id]);
      const existing = (
        await c.query(
          "SELECT id,status,created_at FROM data_requests WHERE user_id=$1 AND kind='export' AND status='requested'",
          [u.id],
        )
      ).rows;
      return camel(
        existing[0] ??
          (
            await c.query(
              "INSERT INTO data_requests(user_id,kind) VALUES($1,'export') RETURNING id,status,created_at",
              [u.id],
            )
          ).rows[0],
      );
    });
  }
  @Delete('account')
  async remove(
    @Body()
    body: unknown,
    @Req()
    req: Request,
    @Res({ passthrough: true })
    res: Response,
  ) {
    const u = await this.auth.require(req),
      b = z
        .object({ password: z.string().max(128), confirmation: z.enum(['DELETE', 'УДАЛИТЬ']) })
        .strict()
        .parse(body);
    const row = (await this.db.query('SELECT password_hash FROM users WHERE id=$1', [u.id]))[0];
    if (!(await verifyPassword(b.password, row.password_hash as string)))
      fail(403, 'FORBIDDEN', 'Неверный пароль.');
    await this.db.tx(async (c) => {
      await c.query(
        "UPDATE users SET email=$2,handle=$3,name='Deleted account',bio='',password_hash='',avatar_asset_id=NULL,settings='{}',deleted_at=now() WHERE id=$1",
        [u.id, `${u.id}@deleted.invalid`, `deleted_${u.id.replace(/-/g, '')}`],
      );
      await c.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);
      await c.query('DELETE FROM auth_email_tokens WHERE user_id=$1', [u.id]);
      await c.query('DELETE FROM auth_email_cooldowns WHERE address_hash=$1', [tokenHash(u.email)]);
      await c.query('DELETE FROM favorites WHERE user_id=$1', [u.id]);
      await c.query('DELETE FROM notifications WHERE user_id=$1', [u.id]);
      await c.query('DELETE FROM heroes WHERE owner_id=$1', [u.id]);
      await c.query('DELETE FROM npcs WHERE owner_id=$1', [u.id]);
      await c.query(
        "UPDATE adventures SET status='archived',published_snapshot=NULL,title='Deleted content',synopsis='',data='{}' WHERE owner_id=$1",
        [u.id],
      );
      await c.query(
        "INSERT INTO data_requests(user_id,kind,status) VALUES($1,'deletion','requested')",
        [u.id],
      );
    });
    res.clearCookie('dreamwalk_session', { path: '/' });
    return { ok: true };
  }
  @Get('notifications')
  async notifications(
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req);
    return (
      await this.db.query(
        'SELECT id,title,message,type,payload,read,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
        [u.id],
      )
    ).map(camel);
  }
  @Patch('notifications/:id')
  async readNotification(
    @Param('id')
    id: string,
    @Body()
    body: unknown,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req);
    z.object({ read: z.literal(true) }).parse(body);
    await this.db.query('UPDATE notifications SET read=true WHERE id=$1 AND user_id=$2', [
      id,
      u.id,
    ]);
    return { ok: true };
  }
}
