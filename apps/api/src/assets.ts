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
import sharp from 'sharp';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Db, camel } from './db';
import { Auth } from './auth';
import { config } from './config';
import { fail } from './errors';
const MAX_ASSETS_PER_USER = 200;
const MAX_ASSET_BYTES_PER_USER = 100 * 1024 * 1024;

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
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype))
      fail(400, 'VALIDATION_FAILED', 'Загрузите PNG, JPEG или WebP размером до 5 МБ.');
    // Do not invoke an SVG/GIF/PDF decoder even if the multipart MIME is forged.
    const header = file.buffer;
    const png =
      header.length >= 8 &&
      header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg =
      header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    const webp =
      header.length >= 12 &&
      header.toString('ascii', 0, 4) === 'RIFF' &&
      header.toString('ascii', 8, 12) === 'WEBP';
    if (!png && !jpeg && !webp)
      fail(400, 'VALIDATION_FAILED', 'Файл не является допустимым растровым изображением.');
    const usage = (
      await this.db.query(
        'SELECT count(*)::int AS count, COALESCE(sum(bytes),0)::bigint AS bytes FROM assets WHERE owner_id=$1',
        [u.id],
      )
    )[0];
    if (
      Number(usage.count) >= MAX_ASSETS_PER_USER ||
      Number(usage.bytes) >= MAX_ASSET_BYTES_PER_USER
    )
      fail(413, 'ASSET_QUOTA_EXCEEDED', 'Достигнут лимит медиа: 200 изображений или 100 МиБ.');
    let bytes: Buffer, width: number, height: number;
    try {
      const meta = await sharp(file.buffer, { limitInputPixels: 4096 * 4096 }).metadata();
      if (
        !['png', 'jpeg', 'webp'].includes(meta.format ?? '') ||
        !meta.width ||
        !meta.height ||
        meta.width > 4096 ||
        meta.height > 4096 ||
        (meta.pages ?? 1) > 1
      )
        fail(
          400,
          'VALIDATION_FAILED',
          'Изображение должно быть статичным и не больше 4096 × 4096.',
        );
      const result = await sharp(file.buffer, { limitInputPixels: 4096 * 4096 })
        .rotate()
        .webp({ quality: 88 })
        .toBuffer({ resolveWithObject: true });
      bytes = result.data;
      width = result.info.width;
      height = result.info.height;
    } catch {
      fail(400, 'VALIDATION_FAILED', 'Файл не является допустимым растровым изображением.');
    }
    const id = randomUUID(),
      filename = `${id}.webp`;
    const filePath = resolve(config.ASSET_DIR, filename);
    let row: Record<string, unknown>;
    try {
      row = await this.db.tx(async (client) => {
        // Lock the owner, not a derived count: concurrent uploads must share one quota.
        const owner = await client.query(
          'SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
          [u.id],
        );
        if (!owner.rows.length) fail(401, 'UNAUTHORIZED', 'Войдите в аккаунт.');
        const stored = (
          await client.query(
            'SELECT count(*)::int AS count, COALESCE(sum(bytes),0)::bigint AS bytes FROM assets WHERE owner_id=$1',
            [u.id],
          )
        ).rows[0];
        if (
          Number(stored.count) >= MAX_ASSETS_PER_USER ||
          Number(stored.bytes) + bytes!.length > MAX_ASSET_BYTES_PER_USER
        )
          fail(413, 'ASSET_QUOTA_EXCEEDED', 'Достигнут лимит медиа: 200 изображений или 100 МиБ.');
        await mkdir(resolve(config.ASSET_DIR), { recursive: true });
        await writeFile(filePath, bytes!, { flag: 'wx' });
        return (
          await client.query(
            "INSERT INTO assets(id,owner_id,filename,mime,width,height,bytes,sha256) VALUES($1,$2,$3,'image/webp',$4,$5,$6,$7) RETURNING id,mime,width,height,created_at",
            [
              id,
              u.id,
              filename,
              width!,
              height!,
              bytes!.length,
              createHash('sha256').update(bytes!).digest('hex'),
            ],
          )
        ).rows[0];
      });
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
