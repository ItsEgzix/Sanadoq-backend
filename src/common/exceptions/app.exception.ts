import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * The only way a service reports an expected failure. `errorCode` is a stable
 * key into src/i18n/<locale>/events.json, never prose: the global
 * HttpExceptionFilter translates it, so the same throw reads correctly in
 * Arabic and English. `meta` feeds the message's `{placeholders}` and is
 * echoed to the client only outside production.
 */
export class AppException extends HttpException {
  constructor(
    readonly errorCode: string,
    readonly meta: Record<string, unknown> = {},
    status: number = HttpStatus.BAD_REQUEST,
  ) {
    super({ errorCode, meta }, status);
  }
}
