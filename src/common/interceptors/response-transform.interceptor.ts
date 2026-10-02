import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { I18nContext, I18nService } from 'nestjs-i18n';
import { map, type Observable } from 'rxjs';
import { translateEvent } from '../utils/translate.util';

interface SuccessEnvelope {
  successCode: string;
  [key: string]: unknown;
}

function isSuccessEnvelope(value: unknown): value is SuccessEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { successCode?: unknown }).successCode === 'string'
  );
}

/**
 * Turns a service's `{ successCode, ...rest }` into `{ message, ...rest }`
 * with the message translated for the caller's locale, so services name an
 * outcome and never write user-facing text. Pure reads carry no successCode
 * and pass through untouched.
 */
@Injectable()
export class ResponseTransformInterceptor implements NestInterceptor {
  constructor(private readonly i18n: I18nService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const lang = I18nContext.current(context)?.lang;
    return next.handle().pipe(
      map((data: unknown) => {
        if (!isSuccessEnvelope(data)) return data;
        const { successCode, ...rest } = data;
        return {
          message: translateEvent(this.i18n, successCode, lang, rest),
          ...rest,
        };
      }),
    );
  }
}
