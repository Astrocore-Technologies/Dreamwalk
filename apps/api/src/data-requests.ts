import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Db, camel } from './db';
import { Auth } from './auth';
import { fail } from './errors';
import { z } from 'zod';

@Controller('api/v1/account/exports')
export class DataRequestsController {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Auth) private auth: Auth,
  ) {}
  @Get()
  async list(@Req() req: Request) {
    const user = await this.auth.require(req);
    return (
      await this.db.query(
        `SELECT id, CASE WHEN expires_at<=now() THEN 'expired' ELSE status END AS status, created_at,completed_at,expires_at FROM data_requests WHERE user_id=$1 AND kind='export' ORDER BY created_at DESC LIMIT 50`,
        [user.id],
      )
    ).map(camel);
  }
  @Get(':id/download')
  async download(@Req() req: Request, @Param('id') id: string, @Res() res: Response) {
    const user = await this.auth.require(req);
    z.uuid().parse(id);
    const row = (
      await this.db.query(
        `SELECT artifact FROM data_requests WHERE id=$1 AND user_id=$2 AND kind='export' AND status='completed' AND expires_at>now()`,
        [id, user.id],
      )
    )[0];
    if (!row?.artifact) fail(404, 'NOT_FOUND', 'Export unavailable.');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'attachment; filename="dreamwalk-export.json"');
    res.json(row.artifact);
  }
}
