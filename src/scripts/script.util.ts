import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from 'generated/prisma/client';

/**
 * Shared by the one-off scripts: open a client on DATABASE_URL (and
 * DATABASE_SCHEMA, like the app) and say which database is about to be
 * touched before anything is. Scripts use the raw client — they write
 * deliberately, and must see soft-deleted rows to stay re-runnable.
 */
export function openDatabase(
  url: string | undefined,
  schema: string | undefined,
  label = 'DATABASE_URL',
): { prisma: PrismaClient; description: string } {
  if (!url) throw new Error(`${label} is not set.`);
  return {
    prisma: new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }, { schema }),
    }),
    description: describeDatabase(url, schema),
  };
}

export interface PlannedPerson {
  key: string;
  name: string;
  accountNumber: string;
}

/**
 * Links planned people to existing Person rows by account number — but only
 * where the stored record is live and carries the planned name, i.e. it is
 * this script's own row from an earlier run. An account number held under
 * another name, or by a retired record, is reported as a conflict and the
 * planned person is skipped: linking to it would merge two identities on the
 * number alone, which only a reviewer may do.
 */
export async function matchPeopleByAccount(
  prisma: PrismaClient,
  planned: readonly PlannedPerson[],
): Promise<{
  ids: Map<string, string>;
  missing: PlannedPerson[];
  conflicts: Array<{ planned: PlannedPerson; existingName: string }>;
}> {
  const existing = await prisma.person.findMany({
    where: { accountNumber: { in: planned.map((p) => p.accountNumber) } },
    select: { id: true, name: true, accountNumber: true, isDeleted: true },
  });
  const byAccount = new Map(existing.map((p) => [p.accountNumber, p]));
  const ids = new Map<string, string>();
  const missing: PlannedPerson[] = [];
  const conflicts: Array<{ planned: PlannedPerson; existingName: string }> = [];
  for (const person of planned) {
    const found = byAccount.get(person.accountNumber);
    if (!found) missing.push(person);
    else if (!found.isDeleted && found.name === person.name) {
      ids.set(person.key, found.id);
    } else {
      conflicts.push({
        planned: person,
        existingName: found.isDeleted ? `${found.name} (retired)` : found.name,
      });
    }
  }
  return { ids, missing, conflicts };
}

/** Host, database and schema — never credentials. */
export function describeDatabase(url: string, schema?: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname} (schema ${schema ?? 'public'})`;
  } catch {
    return '(unparseable database URL)';
  }
}
