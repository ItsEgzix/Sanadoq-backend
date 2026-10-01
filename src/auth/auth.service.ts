import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from 'generated/prisma/client';
import { AppException } from 'src/common/exceptions/app.exception';
import { PrismaService } from 'src/prisma/prisma.service';
import type { ChangePasswordDto } from './dto/change-password.dto';
import type { LoginDto } from './dto/login.dto';
import {
  hashPassword,
  simulatePasswordCompare,
  verifyPassword,
} from './password.util';
import { TokenService } from './token.service';

// What a session needs to know about its user. passwordHash and tokenVersion
// are read for the checks below and stripped before anything is returned.
const SESSION_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  isActive: true,
  tokenVersion: true,
  passwordHash: true,
  role: { select: { key: true, name: true, permissions: true } },
} satisfies Prisma.UserSelect;

type SessionUserRow = Prisma.UserGetPayload<{
  select: typeof SESSION_USER_SELECT;
}>;

function toSessionUser({
  passwordHash: _passwordHash,
  tokenVersion: _tokenVersion,
  isActive: _isActive,
  ...user
}: SessionUserRow) {
  return user;
}

export type SessionUser = ReturnType<typeof toSessionUser>;

export interface IssuedSession {
  accessToken: string;
  // Goes into the httpOnly cookie in AuthController and never into a body.
  refreshToken: string;
  user: SessionUser;
}

/**
 * Sign-in, token refresh, sign-out and password changes. Never touches the
 * HTTP response: AuthController moves the refresh token into its cookie.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: SESSION_USER_SELECT,
    });
    if (!user) {
      // Same CPU as a real check, so an unknown email answers as slowly as a
      // wrong password and the account list cannot be probed by timing.
      await simulatePasswordCompare(dto.password);
      throw this.invalidCredentials();
    }
    if (!(await verifyPassword(user.passwordHash, dto.password))) {
      throw this.invalidCredentials();
    }
    // After the password check on purpose: only someone who already knows
    // the password learns the account exists but is switched off.
    this.assertActive(user);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return {
      ...(await this.issueSession(user)),
      successCode: 'AUTH_LOGIN_SUCCESS',
    };
  }

  /** A fresh access token (and a rotated refresh token) from the cookie's refresh token. */
  async refresh(refreshToken: string | undefined): Promise<IssuedSession> {
    const user = await this.userFromRefreshToken(refreshToken);
    if (!user) {
      throw new AppException(
        'AUTH_SESSION_EXPIRED',
        {},
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.assertActive(user);
    return this.issueSession(user);
  }

  /**
   * Ends every session the user holds, on every device, by bumping
   * tokenVersion. Answers success even for a missing or dead cookie: the
   * caller wanted to be signed out, and is.
   */
  async logout(refreshToken: string | undefined) {
    const claims = refreshToken
      ? await this.tokens.verify(refreshToken, 'refresh')
      : null;
    if (claims) {
      // Conditional on the version so a stale cookie cannot end a session it
      // never belonged to.
      await this.prisma.user.updateMany({
        where: { id: claims.sub, tokenVersion: claims.ver },
        data: { tokenVersion: { increment: 1 } },
      });
    }
    return { successCode: 'AUTH_LOGOUT_SUCCESS' };
  }

  async me(userId: string): Promise<SessionUser> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: SESSION_USER_SELECT,
    });
    return toSessionUser(user);
  }

  /**
   * Bumps tokenVersion with the new hash, which signs out every other device
   * — the usual reason to change a password — and issues this device a
   * fresh session so it stays signed in.
   */
  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: SESSION_USER_SELECT,
    });
    if (!(await verifyPassword(user.passwordHash, dto.currentPassword))) {
      throw new AppException('AUTH_CURRENT_PASSWORD_WRONG');
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(dto.newPassword),
        tokenVersion: { increment: 1 },
      },
      select: SESSION_USER_SELECT,
    });
    return {
      ...(await this.issueSession(updated)),
      successCode: 'AUTH_PASSWORD_CHANGE_SUCCESS',
    };
  }

  private async userFromRefreshToken(
    refreshToken: string | undefined,
  ): Promise<SessionUserRow | null> {
    if (!refreshToken) return null;
    const claims = await this.tokens.verify(refreshToken, 'refresh');
    if (!claims) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: SESSION_USER_SELECT,
    });
    // A version mismatch is a session ended by logout, a password change or
    // deactivation.
    return user && user.tokenVersion === claims.ver ? user : null;
  }

  private async issueSession(user: SessionUserRow): Promise<IssuedSession> {
    const [accessToken, refreshToken] = await Promise.all([
      this.tokens.signAccessToken(user.id, user.tokenVersion),
      this.tokens.signRefreshToken(user.id, user.tokenVersion),
    ]);
    return { accessToken, refreshToken, user: toSessionUser(user) };
  }

  private assertActive(user: SessionUserRow): void {
    if (!user.isActive) {
      throw new AppException(
        'AUTH_ACCOUNT_DEACTIVATED',
        {},
        HttpStatus.FORBIDDEN,
      );
    }
  }

  // One code for unknown email and wrong password alike: telling them apart
  // would confirm which emails have accounts.
  private invalidCredentials(): AppException {
    return new AppException(
      'AUTH_INVALID_CREDENTIALS',
      {},
      HttpStatus.UNAUTHORIZED,
    );
  }
}
