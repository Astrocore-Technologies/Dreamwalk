import 'reflect-metadata';
import { Controller, Get, Inject, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { Db } from './db';
import { Auth, AccountController } from './auth';
import { Content, ContentController } from './content';
import { AdminController } from './admin';
import { AssetsController, AssetUploadGuard } from './assets';
import { InvitationsController } from './invitations';
import { DataRequestsController } from './data-requests';
import { Errors } from './errors';
import { config } from './config';
import { GameService } from './game/game.service';
import { GameController } from './game/game.controller';
import { attachGameSockets } from './game/game.socket';
@Controller('api/v1')
class Health {
  constructor(
    @Inject(Db)
    private db: Db,
  ) {}
  @Get('health')
  async health() {
    await this.db.query('SELECT 1');
    return { status: 'ok', mode: 'platform', aiProvider: 'mock', paymentsEnabled: false };
  }
}
@Module({
  controllers: [
    Health,
    AccountController,
    ContentController,
    AdminController,
    AssetsController,
    InvitationsController,
    DataRequestsController,
    GameController,
  ],
  providers: [Db, Auth, Content, AssetUploadGuard, GameService],
})
class AppModule {}
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: '256kb' }));
  app.useGlobalFilters(new Errors());
  const windows = new Map<
    string,
    {
      count: number;
      reset: number;
    }
  >();
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutation) {
      const origin = req.headers.origin;
      if (origin && origin !== config.WEB_ORIGIN) {
        res
          .status(403)
          .json({ code: 'FORBIDDEN', message: 'Недопустимый источник запроса.', retryable: false });
        return;
      }
      if (
        !(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json') &&
        !(req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data')
      ) {
        res.status(415).json({
          code: 'VALIDATION_FAILED',
          message: 'Требуется JSON или загрузка изображения.',
          retryable: false,
        });
        return;
      }
    }
    const isAuth =
      mutation &&
      (req.path.includes('/auth/') || req.path.includes('/account/email-verification/'));
    const key = `${req.ip}:${isAuth ? 'auth' : 'all'}`,
      now = Date.now(),
      limit = isAuth ? 30 : 600;
    let w = windows.get(key);
    if (!w || w.reset < now) {
      w = { count: 0, reset: now + 60000 };
      windows.set(key, w);
    }
    w.count++;
    if (w.count > limit) {
      res.status(429).json({
        code: 'RATE_LIMITED',
        message: 'Слишком много запросов. Повторите через минуту.',
        retryable: true,
      });
      return;
    }
    if (windows.size > 10000) for (const [k, v] of windows) if (v.reset < now) windows.delete(k);
    next();
  });
  app.enableShutdownHooks();
  attachGameSockets(app.getHttpServer(), app.get(GameService));
  await app.listen(config.API_PORT, '127.0.0.1');
}
void bootstrap();
