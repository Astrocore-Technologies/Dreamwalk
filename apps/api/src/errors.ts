import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import type { Response } from 'express';
export class ApiException extends HttpException {
  constructor(status: number, code: string, message: string) {
    super({ code, message, retryable: false }, status);
  }
}
export const fail = (status: number, code: string, message: string): never => {
  throw new ApiException(status, code, message);
};
@Catch()
export class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof ZodError) {
      res
        .status(400)
        .json({
          code: 'VALIDATION_FAILED',
          message: error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '),
          retryable: false,
        });
      return;
    }
    if (error instanceof HttpException) {
      const body = error.getResponse();
      res.status(error.getStatus()).json(
        typeof body === 'object' && 'code' in body
          ? body
          : {
              code: 'REQUEST_FAILED',
              message:
                typeof body === 'string'
                  ? body
                  : (
                      body as {
                        message?: unknown;
                      }
                    ).message,
              retryable: false,
            },
      );
      return;
    }
    const dbCode = (
      error as {
        code?: string;
      }
    )?.code;
    if (dbCode === '23505') {
      res
        .status(409)
        .json({
          code: 'STATE_CONFLICT',
          message: 'Такая запись уже существует. Проверьте email или имя пользователя.',
          retryable: false,
        });
      return;
    }
    if (dbCode === '22P02') {
      res
        .status(400)
        .json({
          code: 'VALIDATION_FAILED',
          message: 'Некорректный идентификатор.',
          retryable: false,
        });
      return;
    }
    console.error('API internal failure', error instanceof Error ? error.name : 'Unknown');
    res
      .status(500)
      .json({
        code: 'INTERNAL_ERROR',
        message: 'Не удалось выполнить запрос. Попробуйте позже.',
        retryable: false,
      });
  }
}
