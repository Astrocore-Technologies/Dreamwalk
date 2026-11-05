import { resolveReplyLocale } from './game/reply-locale';
import { CachedTranslations, PostgresTranslationCache } from './translation/service';
import { TranslationInterceptor } from './translation/interceptor';
import {
  activateRegisteredReleaseDeployment,
  releaseDeploymentId,
  ReleaseDeploymentReadiness,
} from './generation/release-deployment';
import { PaidStartService } from './game/paid-start.service';
import { PaidStartController } from './game/paid-start.controller';
import { StoryAuthoringController } from './story-authoring/controller';
import { StoryNpcService } from './story-authoring/npcs';
import { PrivateReleaseService } from './story-authoring/private-release';
import { StoryBuildService } from './game/story-build.service';
import { StoryBuildController } from './game/story-build.controller';
import { storyPlanDefinition } from './game/story-plan';
import { SpatialPlannerService } from './visual-authoring/spatial-planner';
import { spatialPlanDefinition } from './visual-authoring/spatial-plan';
import { createAuthoringTextEngine } from './live-test/authoring-text';
import { LiveTestController } from './live-test/controller';
import { KnownAuthoringSettlement } from './live-test/known-authoring-settlement';
import { LiveTestService } from './live-test/service';
import { GenerationAuthority } from './generation/service';
import { readGenerationConfig } from './generation/config';
import { readLiveTestConfig } from './live-test/config';
import { VisualAuthoringController } from './visual-authoring/controller';
import { VisualAuthoringService } from './visual-authoring/service';
import { ImageGenerationService } from './image-generation/service';
import { ImageGenerationController } from './image-generation/controller';
import 'reflect-metadata';
import { Controller, Get, Inject, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { Db } from './db';
import { Auth, AccountController } from './auth';
import { GoogleAuthController } from './google-auth';
import { Content, ContentController } from './content';
import { AdminController } from './admin';
import { AssetsController, AssetUploadGuard } from './assets';
import { AssetReuseController } from './assets/reuse.controller';
import { AssetReuseService } from './assets/reuse.service';
import { InvitationsController } from './invitations';
import { DataRequestsController } from './data-requests';
import { Errors, fail } from './errors';
import { config } from './config';
import { ingressAllowed, requestOriginAllowed, ENFORCE_BROWSER_ORIGIN } from './ingress';
import { PlayableService } from './game/playable.service';
import { PlayableController } from './game/playable.controller';
import { GameService } from './game/game.service';
import { NpcAiService } from './ai/npc-ai.service';
import { GameController } from './game/game.controller';
import { KnownNpcSettlement } from './game/known-npc-settlement';
import { attachGameSockets } from './game/game.socket';
const releaseReadiness = new ReleaseDeploymentReadiness(process.env.GENERATION_MODE === 'release');
@Controller('api/v1')
class Health {
  constructor(
    @Inject(Db)
    private db: Db,
  ) {}
  @Get('health')
  async health() {
    if (!releaseReadiness.ready)
      fail(503, 'GENERATION_RELEASE_STARTING', 'GENERATION_RELEASE_STARTING');
    await this.db.query('SELECT 1');
    return {
      status: 'ok',
      mode: 'platform',
      aiProvider:
        process.env.GENERATION_MODE === 'release'
          ? 'release-configured'
          : process.env.GENERATION_MODE === 'owner'
            ? 'owner-configured'
            : process.env.LIVE_TEST_ENABLED === 'true'
              ? 'openai-manual'
              : 'mock',
      paymentsEnabled: false,
    };
  }
}
@Module({
  controllers: [
    PaidStartController,
    StoryAuthoringController,
    Health,
    LiveTestController,
    VisualAuthoringController,
    StoryBuildController,
    AccountController,
    GoogleAuthController,
    ContentController,
    AdminController,
    AssetsController,
    AssetReuseController,
    ImageGenerationController,
    InvitationsController,
    DataRequestsController,
    GameController,
    PlayableController,
  ],
  providers: [
    StoryNpcService,
    PrivateReleaseService,
    Db,
    TranslationInterceptor,
    {
      provide: CachedTranslations,
      inject: [Db],
      useFactory: (db: Db) => new CachedTranslations(new PostgresTranslationCache(db)),
    },
    {
      provide: GenerationAuthority,
      inject: [Db],
      useFactory: (db: Db) => {
        const owner = readGenerationConfig(process.env);
        if (owner.mode !== 'disabled' && process.env.LIVE_TEST_ENABLED === 'true')
          throw new Error('GENERATION_MODES_CONFLICT');
        return new GenerationAuthority(
          db,
          owner.mode !== 'disabled' ? owner : readLiveTestConfig(),
        );
      },
    },
    // Compatibility token only; ordinary mode uses the generic authority above.
    { provide: LiveTestService, useExisting: GenerationAuthority },
    VisualAuthoringService,
    StoryBuildService,
    PaidStartService,
    {
      provide: 'STORY_BUILD_ENGINE',
      inject: [Db, GenerationAuthority],
      useFactory: (db: Db, live: GenerationAuthority) =>
        createAuthoringTextEngine(db, live, storyPlanDefinition),
    },
    SpatialPlannerService,
    {
      provide: 'AUTHORING_TEXT_ENGINE',
      inject: [Db, GenerationAuthority],
      useFactory: (db: Db, live: GenerationAuthority) =>
        createAuthoringTextEngine(db, live, spatialPlanDefinition),
    },
    Auth,
    Content,
    AssetUploadGuard,
    AssetReuseService,
    ImageGenerationService,
    NpcAiService,
    GameService,
    KnownNpcSettlement,
    KnownAuthoringSettlement,
    PlayableService,
  ],
})
class AppModule {}
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app
    .get(ImageGenerationService)
    .setLiveAuthorizer((client, owner, sessionId, input) =>
      app.get(GenerationAuthority).authorizeImage(client, owner, sessionId, input),
    );
  app
    .get(ImageGenerationService)
    .setReleaseResultAuthorizer((client, actor, authorizationId, revision, hash) =>
      app
        .get(GenerationAuthority)
        .authorizeReleaseResult(client, actor, authorizationId, revision, hash),
    );
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Health exposes no private data; all other paths require the trusted web ingress.
    if (req.method === 'GET' && req.path === '/api/v1/health') return next();
    if (
      !ingressAllowed(
        req.headers['x-dreamwalk-ingress'],
        config.DREAMWALK_INGRESS_SECRET,
        config.DREAMWALK_REQUIRE_INGRESS_SECRET,
      )
    ) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(403).json({ code: 'FORBIDDEN', message: 'Forbidden', retryable: false });
      return;
    }
    next();
  });
  app.use(json({ limit: '256kb' }));
  app.useGlobalFilters(new Errors());
  app.useGlobalInterceptors(app.get(TranslationInterceptor));
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
      if (
        ENFORCE_BROWSER_ORIGIN &&
        !requestOriginAllowed(
          origin,
          config.WEB_ORIGIN,
          config.NODE_ENV === 'production' || config.DREAMWALK_REQUIRE_INGRESS_SECRET,
        )
      ) {
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
      (mutation &&
        (req.path.includes('/auth/') || req.path.includes('/account/email-verification/'))) ||
      ['/api/v1/auth/google/start', '/api/v1/auth/google/callback'].includes(req.path);
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
  attachGameSockets(app.getHttpServer(), app.get(GameService), async (req, id, snapshot) => {
    const viewer = await app.get(Auth).require(req);
    return app
      .get(CachedTranslations)
      .localize(
        `/game/campaigns/${id}/snapshot`,
        snapshot,
        resolveReplyLocale(req, undefined, viewer.settings.language),
        viewer.id,
      );
  });
  await app.listen(config.API_PORT, config.API_HOST);
  const generation = readGenerationConfig(process.env);
  if (generation.mode === 'release') {
    try {
      await releaseReadiness.activate(() =>
        app
          .get(Db)
          .tx((c) =>
            activateRegisteredReleaseDeployment(
              c,
              generation,
              releaseDeploymentId(process.env.RAILWAY_DEPLOYMENT_ID),
            ),
          ),
      );
    } catch (error) {
      await app.close();
      throw error;
    }
  }
}
void bootstrap();
