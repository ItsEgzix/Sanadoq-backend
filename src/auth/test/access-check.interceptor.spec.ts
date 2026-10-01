import { HttpStatus, type ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError, type Observable } from 'rxjs';
import { AppException } from 'src/common/exceptions/app.exception';
import { AccessCheckInterceptor } from '../access-check.interceptor';

function contextWith(pendingAccessCheck?: Promise<Error | null>) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ pendingAccessCheck }) }),
  } as unknown as ExecutionContext;
}

const run = (
  pending: Promise<Error | null> | undefined,
  handler: () => Observable<unknown>,
) =>
  lastValueFrom(
    new AccessCheckInterceptor().intercept(contextWith(pending), {
      handle: handler,
    }),
  );

const revoked = () =>
  new AppException('AUTH_TOKEN_INVALID', {}, HttpStatus.UNAUTHORIZED);

describe('AccessCheckInterceptor', () => {
  it('passes a write straight through — its check already ran in the guard', async () => {
    await expect(run(undefined, () => of({ ok: true }))).resolves.toEqual({
      ok: true,
    });
  });

  it('holds a read’s response until the account check passes', async () => {
    let pass!: () => void;
    const pending = new Promise<Error | null>((resolve) => {
      pass = () => resolve(null);
    });
    let done = false;
    const response = run(pending, () => of({ rows: [1] })).then((body) => {
      done = true;
      return body;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    pass();
    await expect(response).resolves.toEqual({ rows: [1] });
  });

  it('replaces the data with the check’s error when the token turns out revoked', async () => {
    await expect(
      run(Promise.resolve(revoked()), () => of({ secret: 'books' })),
    ).rejects.toMatchObject({ errorCode: 'AUTH_TOKEN_INVALID' });
  });

  it('answers a revoked token with the auth error, not the handler’s 404 — no hint about which ids exist', async () => {
    const notFound = new AppException(
      'PROGRAM_NOT_FOUND',
      {},
      HttpStatus.NOT_FOUND,
    );
    await expect(
      run(Promise.resolve(revoked()), () => throwError(() => notFound)),
    ).rejects.toMatchObject({ errorCode: 'AUTH_TOKEN_INVALID' });
  });

  it('lets the handler’s own error through once the check has passed', async () => {
    const notFound = new AppException(
      'PROGRAM_NOT_FOUND',
      {},
      HttpStatus.NOT_FOUND,
    );
    await expect(
      run(Promise.resolve(null), () => throwError(() => notFound)),
    ).rejects.toBe(notFound);
  });
});
