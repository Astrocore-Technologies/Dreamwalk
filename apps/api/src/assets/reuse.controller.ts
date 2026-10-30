import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Auth } from '../auth';
import { config } from '../config';
import { fail } from '../errors';
import { AssetReuseService } from './reuse.service';
@Controller('api/v1/asset-library')
export class AssetReuseController {
  constructor(
    @Inject(Auth) private auth: Auth,
    @Inject(AssetReuseService) private assets: AssetReuseService,
  ) {}
  @Get() async catalog(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rows = await this.assets.catalog((await this.auth.require(req)).id);
    res.setHeader('X-Result-Limit', '200');
    res.setHeader('X-Results-May-Be-Truncated', String(rows.length >= 200));
    return rows;
  }
  @Get('revisions/:id') async revision(@Req() req: Request, @Param('id') id: string) {
    return this.assets.revision((await this.auth.require(req)).id, id);
  }
  @Get('revisions/:id/grants') async grants(@Req() req: Request, @Param('id') id: string) {
    return this.assets.grants((await this.auth.require(req)).id, id);
  }
  @Post('revisions') async register(@Req() req: Request, @Body() body: unknown) {
    return this.assets.register((await this.auth.require(req)).id, body);
  }
  @Post('search') async search(
    @Req() req: Request,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.assets.search((await this.auth.require(req)).id, body);
    res.setHeader('X-Result-Limit', '50');
    res.setHeader('X-Results-May-Be-Truncated', String(rows.length >= 50));
    return rows;
  }
  @Post('resolve') async resolve(@Req() req: Request, @Body() body: unknown) {
    return this.assets.resolve((await this.auth.require(req)).id, body);
  }
  @Post('revisions/:id/grants') async grant(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.assets.grant((await this.auth.require(req)).id, id, body);
  }
  @Post('revisions/:id/grants/:grantId/revoke') async revoke(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
    @Body() body: unknown,
  ) {
    const b = z.object({ operationId: z.uuid() }).strict().parse(body);
    return this.assets.revoke((await this.auth.require(req)).id, id, grantId, b.operationId);
  }
  @Post('revisions/:id/takedown') async takedown(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = z
      .object({ operationId: z.uuid(), confirm: z.literal(true) })
      .strict()
      .parse(body);
    return this.assets.takedown((await this.auth.require(req)).id, id, b.operationId);
  }
  @Get('stories/:id/draft') async draft(@Req() req: Request, @Param('id') id: string) {
    return this.assets.draft((await this.auth.require(req)).id, id);
  }
  @Put('stories/:id/draft') async save(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.assets.saveDraft((await this.auth.require(req)).id, id, body);
  }
  @Get('campaigns/:id/manifest') async campaignManifest(
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    return this.assets.campaignManifest((await this.auth.require(req)).id, id);
  }
  @Get('versions/:id/manifest') async manifest(@Req() req: Request, @Param('id') id: string) {
    const user = await this.auth.current(req);
    return this.assets.manifest(user?.id ?? null, id, user?.role === 'admin');
  }
  @Get('revisions/:id/file') async file(
    @Req() req: Request,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res() res: Response,
  ) {
    const q = z
      .object({ campaignId: z.uuid().optional(), playableVersionId: z.uuid().optional() })
      .strict()
      .refine((v) => !(v.campaignId && v.playableVersionId))
      .parse(query);
    const user = await this.auth.current(req),
      descriptor = await this.assets.fileDescriptor(
        user?.id ?? null,
        id,
        q,
        user?.role === 'admin',
      );
    if (basename(descriptor.filename) !== descriptor.filename)
      fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND');
    const bytes = await readFile(resolve(config.ASSET_DIR, descriptor.filename)).catch(() =>
      fail(404, 'ASSET_NOT_FOUND', 'ASSET_NOT_FOUND'),
    );
    if (createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256)
      fail(409, 'ASSET_INTEGRITY_FAILED', 'ASSET_INTEGRITY_FAILED');
    res.setHeader('Content-Type', descriptor.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(bytes);
  }
}
