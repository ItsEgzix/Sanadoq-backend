import {
  HttpStatus,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ACCESS_METADATA,
  type RouteAccess,
} from 'src/common/decorators/access.decorator';
import type { AuthenticatedRequest } from 'src/common/decorators/current-user.decorator';
import { AppException } from 'src/common/exceptions/app.exception';
import { PrismaService } from 'src/prisma/prisma.service';
import { TokenService } from '../token.service';

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

/**
 * The one access check, registered globally in app.module.ts. Each route
 * declares what it needs with @Public(), @AnyAuthenticated() or
 * @RequirePermission(); a route declaring nothing is refused, so a forgotten
 * decorator fails closed.
 *
 * Authorisation is a permission lookup on the caller's role — never a
 * comparison against a particular user — so every account holding
 * MANAGE_FUND is equal, and a second role is a Role row.
 *
 * The fund's books are shared by everyone holding MANAGE_FUND: there is no
 * per-user ownership, so services do not scope queries by userId. The
 * permission is the scope. Services take userId only to record who wrote.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(
      ACCESS_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (access?.kind === 'public') return true;
    if (!access) {
      this.logger.error(
        `${context.getClass().name}.${context.getHandler().name} declares no access rule; refusing it.`,
      );
      throw new AppException(
        'AUTH_PERMISSION_DENIED',
        {},
        HttpStatus.FORBIDDEN,
      );
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = BEARER_PATTERN.exec(request.headers.authorization ?? '')?.[1];
    if (!token) {
      throw new AppException('AUTH_TOKEN_MISSING', {}, HttpStatus.UNAUTHORIZED);
    }
    const claims = await this.tokens.verify(token, 'access');
    if (!claims) {
      throw new AppException('AUTH_TOKEN_INVALID', {}, HttpStatus.UNAUTHORIZED);
    }

    // Read per request rather than trusted from the token, so deactivation,
    // logout and a role's permissions take effect on the next call — not
    // when the token happens to expire.
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: {
        isActive: true,
        tokenVersion: true,
        role: { select: { permissions: true } },
      },
    });
    // A version mismatch means the token predates a logout, a password change
    // or a deactivation: dead even though it has not expired.
    if (!user || user.tokenVersion !== claims.ver) {
      throw new AppException('AUTH_TOKEN_INVALID', {}, HttpStatus.UNAUTHORIZED);
    }
    if (!user.isActive) {
      throw new AppException(
        'AUTH_ACCOUNT_DEACTIVATED',
        {},
        HttpStatus.FORBIDDEN,
      );
    }
    if (
      access.kind === 'permission' &&
      !user.role.permissions.includes(access.permission)
    ) {
      throw new AppException(
        'AUTH_PERMISSION_DENIED',
        {},
        HttpStatus.FORBIDDEN,
      );
    }

    request.user = { userId: claims.sub };
    return true;
  }
}
