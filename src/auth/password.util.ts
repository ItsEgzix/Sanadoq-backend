import * as argon2 from 'argon2';

// Set explicitly so a dependency bump cannot move the security floor (~80ms a
// hash). verify() reads the parameters back out of each stored hash, so
// raising these later is safe for existing passwords.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** False for a wrong password and for a malformed hash alike. */
export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Spends the same CPU as a real check. A login for an unknown email runs
 * this so it answers as slowly as a wrong password for a real one —
 * otherwise unknown emails return ~20× faster and the user list is
 * enumerable by timing. The dummy is hashed at the same parameters, once.
 */
export async function simulatePasswordCompare(password: string): Promise<void> {
  dummyHash ??= argon2.hash('sanadoq-timing-equaliser', ARGON2_OPTIONS);
  await verifyPassword(await dummyHash, password);
}
