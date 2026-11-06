import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { mergeMap } from 'rxjs';
import { Auth } from '../auth';
import { resolveReplyLocale } from '../game/reply-locale';
import { CachedTranslations } from './service';

@Injectable()
export class TranslationInterceptor implements NestInterceptor {
  constructor(
    @Inject(CachedTranslations) private readonly translations: CachedTranslations,
    @Inject(Auth) private readonly auth: Auth,
  ) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<Request>();
    const path = req.path.replace(/^\/api\/v1/, '');
    if (
      req.method !== 'GET' ||
      !/^\/(adventures(?:\/[^/]+)?|creators\/[^/]+|library|game\/campaigns\/[0-9a-f-]{36}\/(snapshot|turns\/feed|narrative))$/i.test(
        path,
      )
    )
      return next.handle();
    return next.handle().pipe(
      mergeMap(async (value: unknown) => {
        // Controllers finish their normal authorization/projection before cache access.
        const viewer = await this.auth.viewer(req);
        context.switchToHttp().getResponse<Response>().vary('Accept-Language');
        return this.translations.localize(
          path,
          value,
          resolveReplyLocale(req, undefined, viewer?.settings.language),
          viewer?.id ?? null,
          () =>
            context
              .switchToHttp()
              .getResponse<Response>()
              .setHeader('X-Dreamwalk-Translation-Pending', 'true'),
        );
      }),
    );
  }
}
