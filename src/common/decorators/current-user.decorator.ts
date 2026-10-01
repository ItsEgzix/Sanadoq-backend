import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * The identity AuthGuard attaches to a request — the user id and nothing
 * else. Anything more (role, name) is read from the database when needed, so
 * a stale token can never carry a stale permission.
 */
export interface CurrentUserPayload {
  userId: string;
}

export type AuthenticatedRequest = Request & { user?: CurrentUserPayload };

/**
 * The signed-in user. Only meaningful on routes AuthGuard authenticated;
 * identity never comes from a body field, a param or a header the client sets.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentUserPayload => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // AuthGuard runs first on every non-public route and always sets this;
    // reading it on a @Public() route is a programming error.
    return request.user as CurrentUserPayload;
  },
);
