import type { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth.service';
import * as passwordUtil from '../password.util';
import type { TokenService } from '../token.service';

jest.mock('../password.util');
const mockedPassword = jest.mocked(passwordUtil);

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  // The session user's role, read beside the user (findSessionUser).
  role: { findFirst: jest.fn() },
};
const mockTokens = {
  signAccessToken: jest.fn(),
  signRefreshToken: jest.fn(),
  verify: jest.fn(),
};

const USER = {
  id: 'u1',
  email: 'treasurer@example.org',
  name: 'Treasurer',
  isActive: true,
  tokenVersion: 4,
  passwordHash: '$argon2id$stored',
  role: {
    key: 'FUND_MANAGER',
    name: 'Fund manager',
    permissions: ['MANAGE_FUND'],
  },
};

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockPrisma.role.findFirst.mockResolvedValue(USER.role);
    mockTokens.signAccessToken.mockResolvedValue('access');
    mockTokens.signRefreshToken.mockResolvedValue('refresh');
    service = new AuthService(
      mockPrisma as unknown as PrismaService,
      mockTokens as unknown as TokenService,
    );
  });

  describe('login', () => {
    it('spends a dummy hash on an unknown email so it answers as slowly as a wrong password', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({ email: 'ghost@example.org', password: 'whatever-1' }),
      ).rejects.toMatchObject({ errorCode: 'AUTH_INVALID_CREDENTIALS' });
      expect(mockedPassword.simulatePasswordCompare).toHaveBeenCalledWith(
        'whatever-1',
      );
    });

    it('answers a wrong password with the same code as an unknown email, and records no login', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(USER);
      mockedPassword.verifyPassword.mockResolvedValue(false);

      await expect(
        service.login({ email: USER.email, password: 'wrong-password' }),
      ).rejects.toMatchObject({ errorCode: 'AUTH_INVALID_CREDENTIALS' });
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('reveals deactivation only after the right password', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...USER,
        isActive: false,
      });
      mockedPassword.verifyPassword.mockResolvedValue(true);

      await expect(
        service.login({ email: USER.email, password: 'right-password' }),
      ).rejects.toMatchObject({ errorCode: 'AUTH_ACCOUNT_DEACTIVATED' });
      expect(mockTokens.signAccessToken).not.toHaveBeenCalled();
    });

    it('issues both tokens at the current tokenVersion and returns no secrets', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(USER);
      mockedPassword.verifyPassword.mockResolvedValue(true);

      const session = await service.login({
        email: USER.email,
        password: 'right-password',
      });

      expect(mockTokens.signAccessToken).toHaveBeenCalledWith('u1', 4);
      expect(mockTokens.signRefreshToken).toHaveBeenCalledWith('u1', 4);
      expect(session).toMatchObject({
        accessToken: 'access',
        refreshToken: 'refresh',
        successCode: 'AUTH_LOGIN_SUCCESS',
      });
      expect(session.user).not.toHaveProperty('passwordHash');
      expect(session.user).not.toHaveProperty('tokenVersion');
    });
  });

  describe('refresh', () => {
    it('refuses a refresh token minted before the last logout or password change', async () => {
      mockTokens.verify.mockResolvedValue({
        sub: 'u1',
        ver: 3,
        typ: 'refresh',
      });
      mockPrisma.user.findUnique.mockResolvedValue(USER);

      await expect(service.refresh('old-refresh')).rejects.toMatchObject({
        errorCode: 'AUTH_SESSION_EXPIRED',
      });
      expect(mockTokens.signAccessToken).not.toHaveBeenCalled();
    });

    it('refuses a missing cookie without touching the database', async () => {
      await expect(service.refresh(undefined)).rejects.toMatchObject({
        errorCode: 'AUTH_SESSION_EXPIRED',
      });
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('bumps tokenVersion only for the version the cookie was minted at', async () => {
      mockTokens.verify.mockResolvedValue({
        sub: 'u1',
        ver: 4,
        typ: 'refresh',
      });

      await service.logout('refresh');

      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'u1', tokenVersion: 4 },
        data: { tokenVersion: { increment: 1 } },
      });
    });

    it('succeeds with no cookie, writing nothing — the caller is signed out either way', async () => {
      await expect(service.logout(undefined)).resolves.toEqual({
        successCode: 'AUTH_LOGOUT_SUCCESS',
      });
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    it('refuses a wrong current password and changes nothing', async () => {
      mockPrisma.user.findUniqueOrThrow.mockResolvedValue(USER);
      mockedPassword.verifyPassword.mockResolvedValue(false);

      await expect(
        service.changePassword('u1', {
          currentPassword: 'wrong',
          newPassword: 'brand-new-password',
        }),
      ).rejects.toMatchObject({ errorCode: 'AUTH_CURRENT_PASSWORD_WRONG' });
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('stores the new hash and bumps tokenVersion so every other device is signed out', async () => {
      mockPrisma.user.findUniqueOrThrow.mockResolvedValue(USER);
      mockedPassword.verifyPassword.mockResolvedValue(true);
      mockedPassword.hashPassword.mockResolvedValue('$argon2id$new');
      mockPrisma.user.update.mockResolvedValue({ ...USER, tokenVersion: 5 });

      const session = await service.changePassword('u1', {
        currentPassword: 'right',
        newPassword: 'brand-new-password',
      });

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            passwordHash: '$argon2id$new',
            tokenVersion: { increment: 1 },
          },
        }),
      );
      expect(mockTokens.signAccessToken).toHaveBeenCalledWith('u1', 5);
      expect(session.successCode).toBe('AUTH_PASSWORD_CHANGE_SUCCESS');
    });
  });
});
