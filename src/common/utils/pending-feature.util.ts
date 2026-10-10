import { HttpStatus } from '@nestjs/common';
import { AppException } from '../exceptions/app.exception';

/**
 * The failure for a flow whose rules the fund has not confirmed yet —
 * collector assignment, today. Each such flow already has its service method,
 * so wiring it up later replaces one `throw` instead of reshaping a module. 501 rather
 * than 400: the request is fine, the server cannot do it yet.
 */
export function pendingFeature(feature: string): AppException {
  return new AppException(
    'FEATURE_PENDING_CONFIRMATION',
    { feature },
    HttpStatus.NOT_IMPLEMENTED,
  );
}
