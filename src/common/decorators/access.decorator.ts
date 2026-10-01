import { SetMetadata } from '@nestjs/common';
import type { Permission } from 'src/auth/auth.constant';

export const ACCESS_METADATA = 'sanadoq:access';

/**
 * What a route requires, read by AuthGuard. Every route must declare one —
 * the guard rejects a route that declares nothing — so forgetting the
 * decorator fails closed instead of opening the route to any signed-in user.
 */
export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permission: Permission };

/** No sign-in needed: login, token refresh, logout. */
export const Public = () =>
  SetMetadata(ACCESS_METADATA, { kind: 'public' } satisfies RouteAccess);

/**
 * Any active, signed-in user, whatever their role holds — for a user's own
 * account (who am I, change my password), never for fund data.
 */
export const AnyAuthenticated = () =>
  SetMetadata(ACCESS_METADATA, {
    kind: 'authenticated',
  } satisfies RouteAccess);

/**
 * The caller's role must hold `permission`. Checks a permission, never a role
 * or a user id, so a new role is a Role row and not a code change.
 */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(ACCESS_METADATA, {
    kind: 'permission',
    permission,
  } satisfies RouteAccess);
