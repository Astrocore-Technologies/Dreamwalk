import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  safeAdventureMetadata,
  type Invitation,
  type AdventureMetadata,
} from '@dreamwalk/contracts';
import { Db } from './db';
import { Auth } from './auth';
import { Content } from './content';
import { fail } from './errors';
const select = `SELECT i.*,a.slug AS adventure_slug,a.title AS adventure_title,a.synopsis AS adventure_synopsis,a.data AS adventure_data,o.name AS owner_name,o.handle AS owner_handle,r.name AS recipient_name,r.handle AS recipient_handle FROM adventure_invitations i JOIN adventures a ON a.id=i.adventure_id JOIN users o ON o.id=i.owner_id JOIN users r ON r.id=i.recipient_id`;
function view(r: Record<string, unknown>): Invitation {
  return {
    id: r.id as string,
    adventureId: r.adventure_id as string,
    adventureSlug: r.adventure_slug as string,
    adventureTitle: r.adventure_title as string,
    adventureMetadata: safeAdventureMetadata({
      ...(r.adventure_data as AdventureMetadata),
      title: r.adventure_title as string,
      synopsis: r.adventure_synopsis as string,
    }),
    owner: {
      id: r.owner_id as string,
      name: r.owner_name as string,
      handle: r.owner_handle as string,
    },
    recipient: {
      id: r.recipient_id as string,
      name: r.recipient_name as string,
      handle: r.recipient_handle as string,
    },
    status: r.status as Invitation['status'],
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
  };
}
@Controller('api/v1')
export class InvitationsController {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Auth) private auth: Auth,
    @Inject(Content) private content: Content,
  ) {}
  @Get('studio/adventures/:id/invitations') async owned(
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    await this.content.own(id, (await this.auth.require(req)).id);
    return (
      await this.db.query(select + ' WHERE i.adventure_id=$1 ORDER BY i.created_at DESC', [id])
    ).map(view);
  }
  @Post('studio/adventures/:id/invitations') async invite(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const u = await this.auth.require(req);
    const b = z
      .object({ handle: z.string().regex(/^[a-z0-9_]{3,30}$/) })
      .strict()
      .parse(body);
    const row = await this.content.own(id, u.id);
    if (row.visibility !== 'private' || row.status === 'archived')
      fail(409, 'STATE_CONFLICT', 'Приглашения доступны только для приватного приключения.');
    const recipient = (
      await this.db.query('SELECT id FROM users WHERE handle=$1 AND deleted_at IS NULL', [b.handle])
    )[0];
    if (!recipient) fail(404, 'NOT_FOUND', 'Пользователь не найден.');
    if (recipient.id === u.id) fail(400, 'VALIDATION_FAILED', 'Автор уже имеет доступ.');
    const inviteId = await this.db.tx(async (c) => {
      const current = (
        await c.query(
          'SELECT visibility,status FROM adventures WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [id, u.id],
        )
      ).rows[0];
      if (!current || current.visibility !== 'private' || current.status === 'archived')
        fail(409, 'STATE_CONFLICT', 'Приключение больше не доступно для приглашения.');
      const existing = (
        await c.query(
          'SELECT id,status FROM adventure_invitations WHERE adventure_id=$1 AND recipient_id=$2',
          [id, recipient.id],
        )
      ).rows[0];
      if (!existing || !['pending', 'accepted'].includes(existing.status)) {
        const count = (
          await c.query(
            "SELECT count(*)::int AS count FROM adventure_invitations WHERE adventure_id=$1 AND status IN('pending','accepted')",
            [id],
          )
        ).rows[0].count;
        if (count >= 50) fail(400, 'VALIDATION_FAILED', 'Не более 50 активных приглашений.');
      }
      const result = (
        await c.query(
          "INSERT INTO adventure_invitations(adventure_id,owner_id,recipient_id) VALUES($1,$2,$3) ON CONFLICT(adventure_id,recipient_id) DO UPDATE SET status=CASE WHEN adventure_invitations.status='accepted' THEN 'accepted' ELSE 'pending' END,updated_at=now() RETURNING id",
          [id, u.id, recipient.id],
        )
      ).rows[0];
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        'invitation.create',
        result.id,
        JSON.stringify({ adventureId: id, recipientId: recipient.id }),
      ]);
      if (!existing || !['pending', 'accepted'].includes(existing.status)) {
        await c.query(
          "INSERT INTO notifications(user_id,title,message,type,payload) VALUES($1,'','','invitation',$2)",
          [
            recipient.id,
            JSON.stringify({
              adventureId: id,
              adventureTitle: row.title,
              inviter: u.name,
              adventureMetadata: safeAdventureMetadata({
                ...(row.data as AdventureMetadata),
                title: row.title as string,
                synopsis: row.synopsis as string,
              }),
            }),
          ],
        );
      }
      return result.id;
    });
    return view((await this.db.query(select + ' WHERE i.id=$1', [inviteId]))[0]);
  }
  @Delete('studio/adventures/:id/invitations/:inviteId') async revoke(
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
    @Req() req: Request,
  ) {
    const u = await this.auth.require(req);
    await this.content.own(id, u.id);
    await this.db.tx(async (c) => {
      await c.query('SELECT id FROM adventures WHERE id=$1 FOR UPDATE', [id]);
      const result = await c.query(
        "UPDATE adventure_invitations SET status='revoked',updated_at=now() WHERE id=$1 AND adventure_id=$2 RETURNING id",
        [inviteId, id],
      );
      if (!result.rows.length) fail(404, 'NOT_FOUND', 'Приглашение не найдено.');
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        'invitation.revoke',
        inviteId,
        JSON.stringify({ adventureId: id }),
      ]);
    });
    return { ok: true };
  }
  @Get('invitations') async received(@Req() req: Request) {
    const u = await this.auth.require(req);
    return (
      await this.db.query(
        select +
          " WHERE i.recipient_id=$1 AND i.status IN('pending','accepted') AND a.visibility='private' AND a.status<>'archived' ORDER BY i.created_at DESC LIMIT 100",
        [u.id],
      )
    ).map(view);
  }
  @Post('invitations/:id/respond') async respond(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const u = await this.auth.require(req),
      b = z
        .object({ decision: z.enum(['accept', 'decline']) })
        .strict()
        .parse(body);
    const existing = (
      await this.db.query(
        'SELECT adventure_id FROM adventure_invitations WHERE id=$1 AND recipient_id=$2',
        [id, u.id],
      )
    )[0];
    if (!existing) fail(404, 'NOT_FOUND', 'Приглашение не найдено.');
    await this.db.tx(async (c) => {
      const adventure = (
        await c.query('SELECT visibility,status FROM adventures WHERE id=$1 FOR UPDATE', [
          existing.adventure_id,
        ])
      ).rows[0];
      if (!adventure || adventure.visibility !== 'private' || adventure.status === 'archived')
        fail(409, 'STATE_CONFLICT', 'Приглашение больше не действует.');
      const result = await c.query(
        "UPDATE adventure_invitations SET status=$3,updated_at=now() WHERE id=$1 AND recipient_id=$2 AND status IN('pending','accepted') RETURNING id",
        [id, u.id, b.decision === 'accept' ? 'accepted' : 'declined'],
      );
      if (!result.rows.length) fail(409, 'STATE_CONFLICT', 'Приглашение больше не действует.');
      await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
        u.id,
        `invitation.${b.decision}`,
        id,
        JSON.stringify({ adventureId: existing.adventure_id }),
      ]);
    });
    return view((await this.db.query(select + ' WHERE i.id=$1', [id]))[0]);
  }
}
