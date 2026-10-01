import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ACCESS_METADATA,
  type RouteAccess,
} from 'src/common/decorators/access.decorator';
import type { PrismaService } from 'src/prisma/prisma.service';
import { AuthGuard } from '../guards/auth.guard';
import type { TokenService } from '../token.service';

const mockTokens = { verify: jest.fn() };
const mockPrisma = { user: { findUnique: jest.fn() } };

const ACTIVE_MANAGER = {
  isActive: true,
  tokenVersion: 3,
  role: { permissions: ['MANAGE_FUND'] },
};

function contextFor(
  access: RouteAccess | undefined,
  authorization?: string,
): { context: ExecutionContext; request: Record<string, unknown> } {
  const request: Record<string, unknown> = {
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
    mockPrisma.user.findUnique.mockResolvedValue(ACTIVE_MANAGER);

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      errorCode: 'AUTH_PERMISSION_DENIED',
    });
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('answers AUTH_TOKEN_MISSING with no Bearer header', async () => {
    const { context } = contextFor({
      kind: 'permission',
      permission: 'MANAGE_FUND',
    });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      errorCode: 'AUTH_TOKEN_MISSING',
    });
  });

  it('answers AUTH_TOKEN_INVALID for a token that fails verification', async () => {
    const { context } = contextFor(
      { kind: 'permission', permission: 'MANAGE_FUND' },
      'Bearer forged',
    );
    mockTokens.verify.mockResolvedValue(null);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      errorCode: 'AUTH_TOKEN_INVALID',
    });
    expect(mockTokens.verify).toHaveBeenCalledWith('forged', 'access');
  });

  it('treats a token from before a logout or deactivation (stale tokenVersion) as dead', async () => {
    const { context } = contextFor(
      { kind: 'permission', permission: 'MANAGE_FUND' },
      'Bearer old',
    );
    mockTokens.verify.mockResolvedValue({ sub: 'u1', ver: 2, typ: 'access' });
    mockPrisma.user.findUnique.mockResolvedValue(ACTIVE_MANAGER);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      errorCode: 'AUTH_TOKEN_INVALID',
    });
  });

  it('answers AUTH_ACCOUNT_DEACTIVATED for a switched-off account', async () => {
    const { context } = contextFor(
      { kind: 'permission', permission: 'MANAGE_FUND' },
      'Bearer t',
    );
    mockTokens.verify.mockResolvedValue({ sub: 'u1', ver: 3, typ: 'access' });
    mockPrisma.user.findUnique.mockResolvedValue({
      ...ACTIVE_MANAGER,
      isActive: false,
    });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      errorCode: 'AUTH_ACCOUNT_DEACTIVATED',
    });
  });

  it("checks the role's permissions, not who the user is", async () => {
    const { context, request } = contextFor(
      { kind: 'permission', permission: 'MANAGE_FUND' },
      'Bearer t',
    );
    mockTokens.verify.mockResolvedValue({ sub: 'u1', ver: 3, typ: 'access' });
    mockPrisma.user.findUnique.mockResolvedValue({
      ...ACTIVE_MANAGER,
      role: { permissions: ['RECORD_PAYMENTS'] },
    });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      errorCode: 'AUTH_PERMISSION_DENIED',
    });
    expect(request.user).toBeUndefined();
  });

  it('attaches only the user id once the permission is held', async () => {
    const { context, request } = contextFor(
      { kind: 'permission', permission: 'MANAGE_FUND' },
      'bearer t',
    );
    mockTokens.verify.mockResolvedValue({ sub: 'u1', ver: 3, typ: 'access' });
    mockPrisma.user.findUnique.mockResolvedValue(ACTIVE_MANAGER);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({ userId: 'u1' });
  });

  it('lets any active user through an @AnyAuthenticated() route, whatever their role holds', async () => {
    const { context } = contextFor({ kind: 'authenticated' }, 'Bearer t');
    mockTokens.verify.mockResolvedValue({ sub: 'u1', ver: 3, typ: 'access' });
    mockPrisma.user.findUnique.mockResolvedValue({
      ...ACTIVE_MANAGER,
      role: { permissions: [] },
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
