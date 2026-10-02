/**
 * Creates a sign-in account. This is how the first manager gets in; every
 * later account is created from the Users page inside the app.
 *
 *   npm run create:user -- --email you@example.org --name "Your Name"           dry run
 *   npm run create:user -- --email you@example.org --name "Your Name" --apply   creates it
 *
 * The password is generated here and printed once — nothing to leak into
 * shell history. Change it from your account after signing in.
 * Re-runnable: an email that already has an account is reported and left alone.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { emailSchema } from '../auth/auth.schema';
import { hashPassword } from '../auth/password.util';
import { openDatabase } from './script.util';

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  const email = emailSchema.safeParse(values.email ?? '');
  const name = values.name?.trim();
  if (!email.success || !name) {
    throw new Error('Usage: --email <address> --name "<full name>" [--apply]');
  }

  const { prisma, description } = openDatabase(
    process.env.DATABASE_URL,
    process.env.DATABASE_SCHEMA,
  );
  console.log(
    `${values.apply ? 'APPLYING to' : 'Dry run against'} ${description}`,
  );
  try {
    const existing = await prisma.user.findUnique({
      where: { email: email.data },
      select: { id: true },
    });
    if (existing) {
      console.log(`${email.data} already has an account; nothing to do.`);
      return;
    }
    if (!values.apply) {
      console.log(`Would create ${email.data} (${name}) as FUND_MANAGER.`);
      console.log('Nothing written. Re-run with --apply to create it.');
      return;
    }
    // 16 URL-safe characters: comfortably past the 10-character minimum and
    // easy to type once before changing it.
    const password = randomBytes(12).toString('base64url');
    await prisma.user.create({
      data: {
        email: email.data,
        name,
        passwordHash: await hashPassword(password),
      },
    });
    console.log(`Created ${email.data}.`);
    console.log(`One-time password: ${password}`);
    console.log('Sign in, then change it from your account menu.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
