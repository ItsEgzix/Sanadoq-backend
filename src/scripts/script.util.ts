import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  type EnrollmentStatus,
  type Prisma,
} from '../../generated/prisma/client';
import { findDuplicatePairs } from '../contributors/contributor-duplicate.util';
import { CONTRIBUTOR_SCAN_CAP } from '../contributors/contributor.constant';
import {
  joinedFromAccountNumber,
  monthIndex,
  type MonthRef,
} from '../enrollments/enrollment-term.util';

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

export interface PlannedContributor {
  key: string;
  name: string;
  accountNumber: string;
}

/**
 * Links planned contributors to existing Contributor rows by account number —
 * but only where the stored record is live and carries the planned name, i.e.
 * it is this script's own row from an earlier run. An account number held under
 * another name, or by a retired record, is reported as a conflict and the
 * planned contributor is skipped: linking to it would merge two identities on
 * the number alone, which only a reviewer may do.
 */
export async function matchContributorsByAccount(
  prisma: PrismaClient,
  planned: readonly PlannedContributor[],
): Promise<{
  ids: Map<string, string>;
  missing: PlannedContributor[];
  conflicts: Array<{ planned: PlannedContributor; existingName: string }>;
}> {
  const existing = await prisma.contributor.findMany({
    where: { accountNumber: { in: planned.map((p) => p.accountNumber) } },
    select: { id: true, name: true, accountNumber: true, isDeleted: true },
  });
  const byAccount = new Map(existing.map((p) => [p.accountNumber, p]));
  const ids = new Map<string, string>();
  const missing: PlannedContributor[] = [];
  const conflicts: Array<{
    planned: PlannedContributor;
    existingName: string;
  }> = [];
  for (const contributor of planned) {
    const found = byAccount.get(contributor.accountNumber);
    if (!found) missing.push(contributor);
    else if (!found.isDeleted && found.name === contributor.name) {
      ids.set(contributor.key, found.id);
    } else {
      conflicts.push({
        planned: contributor,
        existingName: found.isDeleted ? `${found.name} (retired)` : found.name,
      });
    }
  }
  return { ids, missing, conflicts };
}

/**
 * Raises OPEN duplicate flags among every live contributor, by the same rules
 * as the app's scan — and like the scan it only proposes; nothing is merged.
 * A dry run also counts the contributors the script would add (`planned`), so
 * the preview lists the same pairs --apply raises. A dismissed pair is never
 * raised again: the flag's unique pair key makes the insert skip it.
 */
export async function raiseDuplicateFlags(
  prisma: PrismaClient,
  {
    apply,
    planned,
  }: { apply: boolean; planned: readonly PlannedContributor[] },
): Promise<void> {
  const existing = await prisma.contributor.findMany({
    where: { isDeleted: false },
    orderBy: { id: 'asc' },
    take: CONTRIBUTOR_SCAN_CAP + 1,
    select: { id: true, name: true, accountNumber: true },
  });
  if (existing.length > CONTRIBUTOR_SCAN_CAP) {
    throw new Error(
      `More than ${CONTRIBUTOR_SCAN_CAP} contributors; run the duplicate scan from the app instead.`,
    );
  }
  const contributors = apply
    ? existing
    : [
        ...existing,
        ...planned.map((p) => ({
          id: `planned:${p.key}`,
          name: p.name,
          accountNumber: p.accountNumber,
        })),
      ];
  const byId = new Map(contributors.map((c) => [c.id, c]));
  const pairs = findDuplicatePairs(contributors);
  console.log(
    `Possible duplicates: ${pairs.length} pairs, raised for review in the app — none merged`,
  );
  for (const pair of pairs) {
    const a = byId.get(pair.contributorAId);
    const b = byId.get(pair.contributorBId);
    console.log(
      `  ${a?.accountNumber} ${a?.name}  ~  ${b?.accountNumber} ${b?.name}  [${pair.reasons.join(', ')}]`,
    );
  }
  if (apply && pairs.length > 0) {
    const { count } = await prisma.contributorDuplicateFlag.createMany({
      data: pairs,
      skipDuplicates: true,
    });
    console.log(`  raised ${count} new flags`);
  }
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

/** Where an imported subscription starts, and when it was frozen, if ever. */
export interface TermPlan {
  joined: MonthRef;
  dormantFrom: MonthRef | null;
}

// The month the backfill in migration 20261010110000_enrollment_terms
// freezes a dormant subscription from when nothing better is known: January
// 2026, the first year these books hold.
const DEFAULT_DORMANT_FROM: MonthRef = { year: 2026, month: 1 };

interface TermlessEnrollment {
  id: string;
  contributorId: string;
  status: EnrollmentStatus;
  expectedRate: Prisma.Decimal;
  accountNumber: string;
}

/**
 * Writes the joining terms of every subscription in a periodic program that
 * has none yet — what an import's createMany left without history. The
 * same shape the migration backfilled: ACTIVE from the month joined, at the
 * pledge it holds, and for a dormant one DORMANT from the month it was
 * frozen (or, frozen no later than it joined, DORMANT from the start).
 * `plan` gives a row's months; without one, the join comes from the account
 * number and a dormancy starts in January 2026, as in the migration.
 *
 * Re-runnable: only enrollments with no terms at all are touched, so a
 * history a manager has added to since is never written over.
 */
export async function writeMissingTerms(
  prisma: Pick<PrismaClient, 'programEnrollment' | 'enrollmentTerm'>,
  programId: string,
  plan?: (enrollment: TermlessEnrollment) => TermPlan | undefined,
): Promise<number> {
  const termless = await prisma.programEnrollment.findMany({
    where: { programId, program: { type: 'PERIODIC' }, terms: { none: {} } },
    select: {
      id: true,
      contributorId: true,
      status: true,
      expectedRate: true,
      contributor: { select: { accountNumber: true } },
    },
  });
  const terms: Prisma.EnrollmentTermCreateManyInput[] = [];
  for (const { contributor, ...enrollment } of termless) {
    const row = { ...enrollment, accountNumber: contributor.accountNumber };
    const planned = plan?.(row) ?? {
      joined: joinedFromAccountNumber(row.accountNumber),
      dormantFrom: row.status === 'DORMANT' ? DEFAULT_DORMANT_FROM : null,
    };
    const dormantFrom = row.status === 'DORMANT' ? planned.dormantFrom : null;
    const frozenAtStart =
      dormantFrom !== null &&
      monthIndex(dormantFrom) <= monthIndex(planned.joined);
    const term = (from: MonthRef, status: EnrollmentStatus) => ({
      enrollmentId: row.id,
      fromYear: from.year,
      fromMonth: from.month,
      status,
      expectedRate: row.expectedRate,
    });
    terms.push(term(planned.joined, frozenAtStart ? 'DORMANT' : 'ACTIVE'));
    if (dormantFrom && !frozenAtStart) terms.push(term(dormantFrom, 'DORMANT'));
  }
  if (terms.length === 0) return 0;
  const { count } = await prisma.enrollmentTerm.createMany({
    data: terms,
    skipDuplicates: true,
  });
  return count;
}
