import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ACCESS_TOKEN_TTL_SEC, REFRESH_TOKEN_TTL_SEC } from './auth.constant';
import { tokenClaimsSchema, type TokenClaims } from './auth.schema';

/**
 * Signs and verifies the two token kinds. Both carry only the user id and the
 * user's tokenVersion; permissions are read from the database per request, so
 * a role change or deactivation takes effect without waiting for expiry.
 */
@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  signAccessToken(userId: string, tokenVersion: number): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, ver: tokenVersion, typ: 'access' },
      { expiresIn: ACCESS_TOKEN_TTL_SEC },
    );
  }

  // jwtid: two refreshes in the same second must not mint byte-identical
  // tokens, or a rotated cookie could not be told from the one it replaced.
  signRefreshToken(userId: string, tokenVersion: number): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, ver: tokenVersion, typ: 'refresh' },
      { expiresIn: REFRESH_TOKEN_TTL_SEC, jwtid: randomUUID() },
    );
  }

  /**
   * The claims of a valid token of the expected kind, or null. Every failure
   * — bad signature, expiry, wrong kind, unexpected shape — collapses to null
   * so callers answer with one error code and leak nothing about which check
   * failed. HS256 is pinned: the token's own header never picks the algorithm.
   */
  async verify(
    token: string,
    expected: TokenClaims['typ'],
  ): Promise<TokenClaims | null> {
    try {
      const payload: unknown = await this.jwt.verifyAsync(token, {
        algorithms: ['HS256'],
      });
      const claims = tokenClaimsSchema.safeParse(payload);
      return claims.success && claims.data.typ === expected
        ? claims.data
        : null;
    } catch {
      return null;
    }
  }
}
