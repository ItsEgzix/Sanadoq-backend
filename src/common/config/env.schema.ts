import { z } from 'zod';

/**
 * Boot-time environment contract. The app refuses to start without a valid
 * DATABASE_URL or JWT_SECRET rather than failing on the first query or the
 * first login. The optional variables' defaults are documented in main.ts and
 * .env.example.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  PORT: z
    .string()
    .regex(/^\d{2,5}$/, 'PORT must be a port number.')
    .optional(),
  // Narrowed on purpose: the pg driver adapter cannot use the
  // prisma+postgres:// URLs that `prisma dev` and Accelerate hand out.
  DATABASE_URL: z
    .string()
    .regex(
      /^postgres(ql)?:\/\//,
      'DATABASE_URL must be a postgres:// URL (the pg driver adapter cannot use prisma+postgres://).',
    ),
  // The Postgres schema the tables live in. Unset: public. Lets tests and
  // verification runs use an isolated schema of the same database.
  DATABASE_SCHEMA: z
    .string()
    .regex(
      /^[a-z_][a-z0-9_]{0,62}$/,
      'DATABASE_SCHEMA must be a plain identifier.',
    )
    .optional(),
  // Signs access and refresh tokens (HS256). 32+ characters so it cannot be
  // brute-forced offline from a captured token.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters.'),
  CORS_ORIGIN: z.url().optional(),
  // How many proxies sit in front of the app. Express trusts exactly that many
  // X-Forwarded-For hops, so the login throttle keys on the real client IP.
  // Unset: 0 — the socket address is the client.
  TRUST_PROXY_HOPS: z
    .string()
    .regex(/^\d$/, 'TRUST_PROXY_HOPS must be a single digit.')
    .optional(),
});

/**
 * Validates the environment for ConfigModule. Returns `config` unchanged, not
 * the parsed object: Nest writes the return value back into process.env, and
 * a Zod object would strip every key it does not declare.
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return config;
}
