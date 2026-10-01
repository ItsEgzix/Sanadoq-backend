import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, from, mergeMap, type Observable } from 'rxjs';
import type { AuthenticatedRequest } from 'src/common/decorators/current-user.decorator';

/**
 * The second half of AuthGuard's deferred check on reads: the handler has run
 * while the account check was still in flight, and nothing leaves until that
 * check has passed. When it failed, its error replaces whatever the handler
 * produced — data and errors alike, so a revoked token cannot even learn
 * which ids exist from a 404.
 *
 * Registered first among the global interceptors in app.module.ts, so it is
 * the outermost and decides last.
 */
@Injectable()
export class AccessCheckInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const pending = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>().pendingAccessCheck;
    if (!pending) return next.handle();

    const settled = async (): Promise<void> => {
      const failure = await pending;
      if (failure) throw failure;
    };
    return next.handle().pipe(
      // Before mergeMap on purpose: a check failure thrown on the success
      // path must not loop back through here and be awaited twice.
      catchError((err: unknown) =>
        from(
          settled().then(() => {
            throw err;
          }),
        ),
      ),
      mergeMap((body: unknown) => from(settled().then(() => body))),
    );
  }
}
