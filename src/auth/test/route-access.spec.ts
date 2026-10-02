import { PATH_METADATA } from '@nestjs/common/constants';
import { ACCESS_METADATA } from '../../common/decorators/access.decorator';
import { CycleController } from '../../cycles/cycle.controller';
import { EnrollmentController } from '../../enrollments/enrollment.controller';
import { EradatController } from '../../eradat/eradat.controller';
import { PaymentController } from '../../payments/payment.controller';
import { ContributorDuplicateController } from '../../contributors/contributor-duplicate.controller';
import { ContributorController } from '../../contributors/contributor.controller';
import { ProgramController } from '../../programs/program.controller';
import { UserController } from '../../users/user.controller';
import { AuthController } from '../auth.controller';

const CONTROLLERS = [
  AuthController,
  UserController,
  ProgramController,
  CycleController,
  ContributorDuplicateController,
  ContributorController,
  EnrollmentController,
  PaymentController,
  EradatController,
];

function routeHandlers(controller: new (...args: never[]) => unknown) {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => ({ name, handler: proto[name] }))
    .filter(
      ({ handler }) =>
        typeof handler === 'function' &&
        Reflect.getMetadata(PATH_METADATA, handler) !== undefined,
    );
}

// AuthGuard refuses any route without an access rule. This keeps that from
// ever surfacing as a 403 in production: a new route without a decorator
// fails here first.
describe('route access declarations', () => {
  it.each(CONTROLLERS.map((c) => [c.name, c] as const))(
    '%s declares an access rule on every route',
    (_name, controller) => {
      const handlers = routeHandlers(controller);
      expect(handlers.length).toBeGreaterThan(0);
      const undeclared = handlers
        .filter(
          ({ handler }) =>
            Reflect.getMetadata(ACCESS_METADATA, handler as object) ===
              undefined &&
            Reflect.getMetadata(ACCESS_METADATA, controller) === undefined,
        )
        .map(({ name }) => name);
      expect(undeclared).toEqual([]);
    },
  );

  it('opens only sign-in, refresh and sign-out to callers without a session', () => {
    const publicRoutes = CONTROLLERS.flatMap((controller) =>
      routeHandlers(controller)
        .filter(
          ({ handler }) =>
            (
              Reflect.getMetadata(ACCESS_METADATA, handler as object) as
                { kind: string } | undefined
            )?.kind === 'public',
        )
        .map(({ name }) => `${controller.name}.${name}`),
    );
    expect(publicRoutes.sort()).toEqual([
      'AuthController.login',
      'AuthController.logout',
      'AuthController.refresh',
    ]);
  });
});
