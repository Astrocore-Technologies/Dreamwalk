import {
  Controller,
  Injectable,
  CanActivate,
  ExecutionContext,
  UseGuards,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { normalizeRaster, storeRasterTx } from './assets/raster';
import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Db, camel } from './db';
import { Auth } from './auth';
import { config } from './config';
import { fail } from './errors';

@Injectable()
export class AssetUploadGuard implements CanActivate {
  constructor(@Inject(Auth) private readonly auth: Auth) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.auth.require(context.switchToHttp().getRequest<Request>());
    return true;
  }
}

@Controller('api/v1/assets')
export class AssetsController {
  constructor(
    @Inject(Db)
    private db: Db,
    @Inject(Auth)
    private auth: Auth,
  ) {}
  @Get()
  async list(
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req);
    return (
      await this.db.query(
        'SELECT id,mime,width,height,created_at FROM assets WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 200',
        [u.id],
      )
    ).map((r) => ({ ...camel(r), url: `/api/v1/assets/${r.id}/file` }));
  }
  @Post()
  @UseGuards(AssetUploadGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  async upload(
    @UploadedFile()
    file: Express.Multer.File,
    @Req()
    req: Request,
  ) {
    const u = await this.auth.require(req);
    if (!file) fail(400, 'VALIDATION_FAILED', 'VALIDATION_FAILED');
    const raster = await normalizeRaster(file.buffer, file.mimetype);
    const id = randomUUID(),
      filePath = resolve(config.ASSET_DIR, `${id}.webp`);
    let row: Record<string, unknown>;
    try {
      row = await this.db.tx((c) => storeRasterTx(c, u.id, id, raster));
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      throw error;
    }
    return { ...camel(row), url: `/api/v1/assets/${id}/file` };
  }
  @Get(':id/file')
  async file(
    @Param('id')
    id: string,
    @Req()
    req: Request,
    @Res()
    res: Response,
  ) {
    const row = (await this.db.query('SELECT * FROM assets WHERE id=$1', [id]))[0];
    if (
      !row ||
      (
        await this.db.query(
          'SELECT 1 FROM art_asset_revisions r JOIN art_asset_takedowns t ON t.revision_id=r.id WHERE r.upload_id=$1 LIMIT 1',
          [id],
        )
      ).length
    )
      fail(404, 'NOT_FOUND', 'Изображение не найдено.');
    const u = await this.auth.current(req);
    let allowed = u?.id === row.owner_id;
    if (!allowed) {
      const references = await this.db.query(
        `SELECT a.id FROM adventures a WHERE a.status<>'archived' AND (
        (a.visibility='public' AND a.published_snapshot IS NOT NULL AND (a.published_snapshot->>'coverAssetId'=$1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(a.published_snapshot->'publicNpcs','[]'::jsonb)) n WHERE n->>'portraitAssetId'=$1)))
        OR (((a.visibility='private' AND EXISTS(SELECT 1 FROM adventure_invitations i WHERE i.adventure_id=a.id AND i.recipient_id=$2::uuid AND i.status='accepted')) OR (a.visibility='public' AND a.status='pending_review' AND $3::boolean)) AND (a.data->>'coverAssetId'=$1 OR EXISTS(SELECT 1 FROM npcs n WHERE n.owner_id=a.owner_id AND a.data->'content'->'npcIds' ? n.id::text AND n.data->>'portraitAssetId'=$1)))
      ) UNION ALL SELECT id FROM users WHERE avatar_asset_id=$1::uuid AND deleted_at IS NULL AND settings->>'profilePublic'='true'`,
        [id, u?.id ?? null, u?.role === 'admin'],
      );
      allowed = references.length > 0;
    }
    if (!allowed) fail(404, 'NOT_FOUND', 'Изображение не найдено.');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.send(await readFile(resolve(config.ASSET_DIR, row.filename as string)));
  }
}
