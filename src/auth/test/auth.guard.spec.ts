import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ACCESS_METADATA,
  type RouteAccess,
} from '../../common/decorators/access.decorator';
import type { PrismaService } from '../../prisma/prisma.service';
import { AuthGuard } from '../guards/auth.guard';
import type { TokenService } from '../token.service';

const mockTokens = { verify: jest.fn() };
const mockPrisma = {
  user: { findUnique: jest.fn() },
  role: { findFirst: jest.fn() },
};

// The guard reads the user and their role's permissions as two queries side
// by side; this answers both.
function account({
  isActive = true,
  tokenVersion = 3,
  permissions = ['MANAGE_FUND'],
}: {
  isActive?: boolean;
  tokenVersion?: number;
  permissions?: string[];
} = {}) {
  mockPrisma.user.findUnique.mockResolvedValue({ isActive, tokenVersion });
  mockPrisma.role.findFirst.mockResolvedValue({ permissions });
}

function contextFor(
  access: RouteAccess | undefined,
  authorization?: string,
  method = 'POST',
): { context: ExecutionContext; request: Record<string, unknown> } {
  const request: Record<string, unknown> = {
    method,
    headers: authorization ? { authorization } : {},
  };
  const handler = () => undefined;
  class TestController {}
  if (access) Reflect.defineMetadata(ACCESS_METADATA, access, handler);
  const context = {
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

const MANAGE_FUND: RouteAccess = {
  kind: 'permission',
  permission: 'MANAGE_FUND',
};

describe('AuthGuard', () => {
  let guard: AuthGuard;

  beforeEach(() => {
    jest.resetAllMocks();
    guard = new AuthGuard(
      new Reflector(),
      mockTokens as unknown as TokenService,
      mockPrisma as unknown as PrismaService,
    );
  });

  it('lets a @Public() route through without reading a token or the database', async () => {
    const { context } = contextFor({ kind: 'public' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(mockTokens.verify).not.toHaveBeenCalled();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a route that declares no access rule, even with a valid token — a forgotten decorator fails closed', async () => {
    const { context } = contextFor(undefined, 'Bearer good');
    mockTokens.verify.mockResolvedValue({ sub: 'u1', ver: 3, typ: 'access' });
    account();

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      errorCode: 'AUTH_PERMISSION_DENIED',
    });
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('answers AUTH_TOKEN_MISSING with no Bearer header', async () => {
    const { context } = contextFor(MANAGE_FUND);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      errorCode: 'AUTH_TOKEN_MISSING',
    });
  });

  it('answers AUTH_TOKEN_INVALID for a token that fails verification', async () => {
    const { context } = contextFor(MANAGE_FUND, 'Bearer forged');
    mockTokens.verify.mockResolvedValue(null);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      errorCode: 'AUTH_TOKEN_INVALID',
    });
    expect(mockTokens.verify).toHaveBeenCalledWith('forged', 'access');
  });

  it('refuses a forged or expired token on a read before the handler runs — only the account check is deferred', async () => {
    const { context, request } = contextFor(
      MANAGE_FUND,
      'Bearer forged',
      'GET',
    );
    mockTokens.verify.mockResolvedValue(null);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      errorCode: 'AUTH_TOKEN_INVALID',
    });
    expect(request.pendingAccessCheck).toBeUndefined();
  });

  it('treats a token from before a logout or deactivation (stale tokenVersion) as dead', async () => {
    const { context } = contextFor(MANAGE_FUND, 'Bearer old');
    mockTokens.verify.mockResolvedValue({ sub: 'u1', ver: 2, typ: 'access' });
    account({ tokenVersion: 3 });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      errorCode: 'AUTH_TOKEN_INVALID',
    });
  });

  it('answers AUTH_TOKEN_INVALID for a user that no longer exists', async () => {
    const { context } = contextFor(MANAGE_FUND, 'Bearer t');
    mockTokens.verify.mockResolvedValue({ sub: 'u1', ver: 3, typ: 'access' });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.role.findFirst.mockResolvedValue(null);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      errorCode: 'AUTH_TOKEN_INVALID',
    });
  });

  it('answers AUTH_ACCOUNT_DEACTIVATED for a switched-off account', async () => {
    const { context } = contextFor(MANAGE_FUND, 'Bearer t');
    mockTokens.verify.mockResolvedValue({ sub: 'u1', ver: 3, typ: 'access' });
    account({ isActive: false });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      errorCode: 'AUTH_ACCOUNT_DEACTIVATED',
    });
  });

  it("checks the role's permissions, not who the user is", async () => {
    const { context, request } = contextFor(MANAGE_FUND, 'Bearer t');
    mockTokens.verify.mockResolvedValue({ sub: 'u1', ver: 3, typ: 'access' });
    account({ permissions: ['RECORD_PAYMENTS'] });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      errorCode: 'AUTH_PERMISSION_DENIED',
    });
    expect(request.user).toBeUndefined();
    expect(mockPrisma.role.findFirst).toHaveBeenCalledWith({
      where: { users: { some: { id: 'u1' } } },
      select: { permissions: true },
    });
  });

  it('attaches only the user id once the permission is held', async () => {
    const { context, request } = contextFor(MANAGE_FUND, 'bearer t');
    mockTokens.verify.mockResolvedValue({ sub: 'u1', ver: 3, typ: 'access' });
    account();
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({ userId: 'u1' });
    expect(request.pendingAccessCheck).toBeUndefined();
  });

  it('lets any active user through an @AnyAuthenticated() route, whatever their role holds', async () => {
    const { context } = contextFor({ kind: 'authenticated' }, 'Bearer t');
    mockTokens.verify.mockResolvedValue({ sub: 'u1', ver: 3, typ: 'access' });
    account({ permissions: [] });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  describe('on a read (GET)', () => {
    it('lets the handler start before the account check finishes, and parks the check on the request', async () => {
      const { context, request } = contextFor(MANAGE_FUND, 'Bearer t', 'GET');
      mockTokens.verify.mockResolvedValue({ sub: 'u1', ver: 3, typ: 'access' });
      // An account check that never answers: the guard must not wait on it.
      mockPrisma.user.findUnique.mockReturnValue(new Promise(() => {}));
      mockPrisma.role.findFirst.mockReturnValue(new Promise(() => {}));

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.user).toEqual({ userId: 'u1' });
      expect(request.pendingAccessCheck).toBeInstanceOf(Promise);
    });

    it('settles the parked check to null when the account passes', async () => {
      const { context, request } = contextFor(MANAGE_FUND, 'Bearer t', 'GET');
      mockTokens.verify.mockResolvedValue({ sub: 'u1', ver: 3, typ: 'access' });
      account();

      await guard.canActivate(context);
      await expect(request.pendingAccessCheck).resolves.toBeNull();
    });

    it.each([
      ['a revoked token', { tokenVersion: 9 }, 'AUTH_TOKEN_INVALID'],
      [
        'a switched-off account',
        { isActive: false },
        'AUTH_ACCOUNT_DEACTIVATED',
      ],
      ['a missing permission', { permissions: [] }, 'AUTH_PERMISSION_DENIED'],
    ])(
      'settles the parked check to the error for %s instead of rejecting, so the interceptor can answer with it',
      async (_case, state, errorCode) => {
        const { context, request } = contextFor(MANAGE_FUND, 'Bearer t', 'GET');
        mockTokens.verify.mockResolvedValue({
          sub: 'u1',
          ver: 3,
          typ: 'access',
        });
        account(state);

        await expect(guard.canActivate(context)).resolves.toBe(true);
        await expect(request.pendingAccessCheck).resolves.toMatchObject({
          errorCode,
        });
      },
    );
  });
});
