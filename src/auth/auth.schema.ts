import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './auth.constant';

/** A new password. Length is the only rule: composition rules add friction, not strength. */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH);

/** Emails are compared lowercased everywhere (CHECK "User_email_lowercase"). */
export const emailSchema = z.email().max(254).toLowerCase();

/**
 * The claims inside a token. Access and refresh tokens share a secret, so
 * `typ` is what stops a refresh token being replayed as an access token. Parsed
 * after the signature check, because a valid signature proves who issued the
 * token, not that its body has the shape this version of the code expects.
 */
export const tokenClaimsSchema = z.object({
  sub: z.string().min(1).max(64),
  ver: z.number().int().nonnegative(),
  typ: z.enum(['access', 'refresh']),
});

export type TokenClaims = z.infer<typeof tokenClaimsSchema>;
