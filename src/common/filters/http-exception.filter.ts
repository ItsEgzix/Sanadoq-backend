import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { I18nContext, I18nService } from 'nestjs-i18n';
import { ZodValidationException } from 'nestjs-zod';
import { AppException } from 'src/common/exceptions/app.exception';
import { errorMessage } from 'src/common/utils/error.util';
import { translateEvent } from 'src/common/utils/translate.util';

interface DescribedError {
  status: number;
  errorCode: string;
  meta: Record<string, unknown>;
}

// Framework HttpExceptions (unknown route, malformed JSON, oversized body, the
// login throttle's ThrottlerException) carry English prose. Mapping them to
// codes keeps every response translatable.
const STATUS_CODES: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'REQUEST_MALFORMED',
  [HttpStatus.NOT_FOUND]: 'ROUTE_NOT_FOUND',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'REQUEST_TOO_LARGE',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
};

/**
 * Turns anything thrown into `{ errorCode, message, timestamp, path }`, with
 * the message translated for the caller's locale. Registered globally in
 * app.module.ts, which is why controllers carry no try/catch.
 *
 * `meta` is echoed only outside production: in development it carries Zod
 * issues and the ids a failure was about, which in production would hand a
 * prober the shape of the data.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(
    private readonly i18n: I18nService,
    private readonly config: ConfigService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const { status, errorCode, meta } = this.describe(exception, request);
    const lang = I18nContext.current(host)?.lang;
    const exposeMeta = this.config.get<string>('NODE_ENV') !== 'production';
    const visibleMeta = exposeMeta ? meta : this.productionMeta(meta);

    response.status(status).json({
      errorCode,
      message: translateEvent(this.i18n, errorCode, lang, meta),
      timestamp: new Date().toISOString(),
      // `path`, not `url`: a query string can carry values that do not belong
      // in an error body or a log.
      path: request.path,
      ...(Object.keys(visibleMeta).length > 0 ? { meta: visibleMeta } : {}),
    });
  }

  // The one exception to "no meta in production": the blockers of a 409 from
  // assertNoBlockers, which name records the caller can already see and which
  // the UI needs to show what must be detached first.
  private productionMeta(meta: Record<string, unknown>) {
    const details = meta.details as { blockers?: unknown } | undefined;
    return details?.blockers ? { details: { blockers: details.blockers } } : {};
  }

  private describe(exception: unknown, request: Request): DescribedError {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        errorCode: exception.errorCode,
        meta: exception.meta,
      };
    }

    // Ahead of the HttpException branch on purpose: ZodValidationException
    // extends BadRequestException and would otherwise read as REQUEST_MALFORMED.
    if (exception instanceof ZodValidationException) {
      return {
        status: HttpStatus.BAD_REQUEST,
        errorCode: 'VALIDATION_FAILED',
        meta: { issues: this.zodIssues(exception) },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        errorCode: STATUS_CODES[status] ?? 'REQUEST_FAILED',
        meta: {},
      };
    }

    this.logger.error(
      `Unhandled error on ${request.method} ${request.path}: ${errorMessage(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: 'INTERNAL_ERROR',
      meta: {},
    };
  }

  // getZodError() is typed `unknown` because nestjs-zod supports Zod 3 and 4;
  // both expose `issues` with `path` and `message`, and nothing else is read.
  private zodIssues(exception: ZodValidationException) {
    const error = exception.getZodError() as {
      issues?: Array<{ path: PropertyKey[]; message: string }>;
    };
    return (error.issues ?? []).map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
  }
}
