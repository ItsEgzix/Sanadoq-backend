import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { TokenService } from './../src/auth/token.service';

/**
 * Wiring that unit tests cannot see: the global AuthGuard, Zod pipe,
 * exception filter, response interceptor and i18n resolvers, and route
 * order. Needs the database in .env to be reachable (it connects at boot,
 * and the login check reads one row) but writes nothing. Set DATABASE_SCHEMA
 * to point it at an isolated schema.
 */
describe('App wiring (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers an unknown route with a translated ROUTE_NOT_FOUND body', async () => {
    const res = await request(app.getHttpServer()).get('/nope').expect(404);
    expect(res.body).toMatchObject({
      errorCode: 'ROUTE_NOT_FOUND',
      message: 'This address does not exist.',
      path: '/nope',
    });
  });

  it('refuses fund data without a session before the body is even validated', async () => {
    const res = await request(app.getHttpServer())
      .post('/programs')
      .send({ name: '' })
      .expect(401);
    expect(res.body.errorCode).toBe('AUTH_TOKEN_MISSING');
  });

  it('lets login through the guard to the Zod pipe, which reports VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'not-an-email', password: '' })
      .expect(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
    expect(
      res.body.meta.issues.map((issue: { path: string }) => issue.path),
    ).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('answers an unknown account with the same code as a wrong password', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@example.invalid', password: 'whatever-123' })
      .expect(401);
    expect(res.body.errorCode).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('answers a refresh without the cookie with AUTH_SESSION_EXPIRED', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .expect(401);
    expect(res.body.errorCode).toBe('AUTH_SESSION_EXPIRED');
  });

  it('translates messages for ?lang=ar and for Accept-Language', async () => {
    const byQuery = await request(app.getHttpServer())
      .get('/nope?lang=ar')
      .expect(404);
    const byHeader = await request(app.getHttpServer())
      .get('/programs')
      .set('Accept-Language', 'ar')
      .expect(401);
    expect(byQuery.body.message).toBe('هذا العنوان غير موجود.');
    expect(byHeader.body.message).toBe('سجّل الدخول للمتابعة.');
  });

  // On reads the account check runs beside the handler (AuthGuard) and
  // AccessCheckInterceptor holds the answer. A correctly signed token for an
  // account that does not exist is the revoked-token case end to end.
  describe('a read with a signed token for no live account', () => {
    let token: string;

    beforeAll(async () => {
      token = await app
        .get(TokenService)
        .signAccessToken('00000000-0000-4000-8000-000000000000', 0);
    });

    it('gets the auth error, not the data the handler produced', async () => {
      const res = await request(app.getHttpServer())
        .get('/programs')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
      expect(res.body.errorCode).toBe('AUTH_TOKEN_INVALID');
      expect(Array.isArray(res.body)).toBe(false);
    });

    it('gets the auth error, not the handler’s 404 for an unknown id', async () => {
      const res = await request(app.getHttpServer())
        .get('/programs/00000000-0000-4000-8000-000000000001/summary')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
      expect(res.body.errorCode).toBe('AUTH_TOKEN_INVALID');
    });

    it('is refused before the handler on a write, as before', async () => {
      const res = await request(app.getHttpServer())
        .post('/programs')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '' })
        .expect(401);
      // AUTH_TOKEN_INVALID, not VALIDATION_FAILED: the guard ran first.
      expect(res.body.errorCode).toBe('AUTH_TOKEN_INVALID');
    });
  });
});
