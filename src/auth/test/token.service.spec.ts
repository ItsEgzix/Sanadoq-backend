import { JwtService } from '@nestjs/jwt';
import { TokenService } from '../token.service';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';

describe('TokenService', () => {
  const jwt = new JwtService({
    secret: SECRET,
    signOptions: { algorithm: 'HS256' },
  });
  const tokens = new TokenService(jwt);

  it('round-trips an access token to its claims', async () => {
    const token = await tokens.signAccessToken('u1', 7);
    await expect(tokens.verify(token, 'access')).resolves.toEqual({
      sub: 'u1',
      ver: 7,
      typ: 'access',
    });
  });

  it('refuses a refresh token presented as an access token — they share a secret, so typ is the fence', async () => {
    const refresh = await tokens.signRefreshToken('u1', 7);
    await expect(tokens.verify(refresh, 'access')).resolves.toBeNull();
  });

  it('mints distinct refresh tokens in the same second', async () => {
    const [a, b] = await Promise.all([
      tokens.signRefreshToken('u1', 7),
      tokens.signRefreshToken('u1', 7),
    ]);
    expect(a).not.toBe(b);
  });

  it('refuses an unsigned token whose header asks for alg "none"', async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: 'u1', ver: 7, typ: 'access' }),
    ).toString('base64url');
    await expect(
      tokens.verify(`${header}.${body}.`, 'access'),
    ).resolves.toBeNull();
  });

  it('refuses a token signed with another secret', async () => {
    const other = new TokenService(
      new JwtService({ secret: 'another-secret-that-is-also-32-chars-long' }),
    );
    const token = await other.signAccessToken('u1', 7);
    await expect(tokens.verify(token, 'access')).resolves.toBeNull();
  });

  it('refuses a validly signed token with an unexpected shape', async () => {
    const token = await jwt.signAsync({ sub: 'u1', typ: 'access' });
    await expect(tokens.verify(token, 'access')).resolves.toBeNull(); // no ver
  });
});
