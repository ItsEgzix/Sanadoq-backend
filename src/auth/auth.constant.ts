import type { CookieOptions } from 'express';

/**
 * The single source of truth for auth rules: permissions, token lifetimes,
 * the refresh cookie's attributes and the login throttle.
 */

/**
 * Every permission the code checks. Strings rather than a Prisma enum:
 * Role.permissions stores them as data, so a new role is an INSERT. A new
 * *permission* is a code change by nature — something has to enforce it.
 */
export const PERMISSIONS = {
  // Everything about the fund's books today: programs, people, enrollments,
  // payments, duplicate review, and the user list.
  MANAGE_FUND: 'MANAGE_FUND',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// Keep in step with the Role row the baseline migration seeds and with
// User.roleKey's column default.
export const DEFAULT_ROLE_KEY = 'FUND_MANAGER';

// Short-lived: a stolen access token is useful for minutes. It is the only
// token the browser holds in script-readable memory.
export const ACCESS_TOKEN_TTL_SEC = 15 * 60;

// The refresh token lives in an httpOnly cookie, out of script's reach.
export const REFRESH_TOKEN_TTL_SEC = 14 * 24 * 60 * 60;

export const REFRESH_COOKIE_NAME = 'sanadoq_refresh';

/**
 * Attributes of the refresh cookie. Setting and clearing must pass the same
 * attributes or the browser keeps the old cookie. A function, not a const:
 * NODE_ENV is read after .env loads, not at import time.
 *
 * In production the frontend and the API sit on different sites (two Vercel
 * deployments), so the cookie must be SameSite=None to ride on the
 * frontend's credentialed fetch — which in turn requires Secure. Locally both
 * run on localhost over http, where Lax works and Secure would drop the cookie.
 */
export function refreshCookieOptions(): CookieOptions {
  const crossSite = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: crossSite,
    sameSite: crossSite ? 'none' : 'lax',
    // Only /auth routes ever read it, so it never rides on data requests.
    path: '/auth',
    maxAge: REFRESH_TOKEN_TTL_SEC * 1000,
  };
}

// Slows password guessing: five attempts per minute per client IP. Keyed on
// the real IP only when TRUST_PROXY_HOPS matches the deployment (see main.ts).
export const LOGIN_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
