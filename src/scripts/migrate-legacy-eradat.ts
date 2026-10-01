/**
 * Copies Eradat data from the old Member-shaped schema (the first baseline:
 * Cycle, Member, ProjectAccount, MonthlyPayment) into the Person / Program
 * shape. Only for a database that still holds rows in that old shape — the
 * local `npx prisma dev` server's synthetic demo data, for one.
 *
 *   LEGACY_DATABASE_URL=… npm run migrate:legacy-eradat            dry run — prints the plan
 *   LEGACY_DATABASE_URL=… npm run migrate:legacy-eradat -- --apply writes it
 *
 * Reads LEGACY_DATABASE_URL (old shape, never written) and writes
 * DATABASE_URL (+ DATABASE_SCHEMA), which must already be migrated to the
 * program baseline.
 *
 * Identity is never decided here. Every old member becomes exactly one
 * Person — nothing is merged, however alike two names look. Look-alikes are
 * raised as duplicate flags for a person to confirm or dismiss in the app.
 * The workbook has real near-duplicates (same person, different account
 * numbers in different sheets) and real namesakes; telling them apart is a
 * human call.
 *
 * Mapping:
 *   Member          → Person (account number YYMMNNN from its parts) + a fund
 *                     enrollment carrying its rate, previous subscription and
 *                     status. Soft-deleted members are skipped.
 *   member cells    → monthly cells of the fund program, ★ kept as ★.
 *   ProjectAccount  → a Program running without cycles (a dated ledger).
 *   project cells   → one dated entry per filled month, on the 1st, from the
 *                     free-text payer below: the old rows were monthly totals
 *                     with no payer recorded, and the new books never invent one.
 *   current Cycle   → the fund program's current cycle, if it has none.
 *
 * Re-runnable: every write dedupes on a unique key (account number,
 * enrollment, cell, a deterministic idempotency key, the flag pair) or an
 * existence check, so a second run adds nothing.
 */
import 'dotenv/config';
import { Client } from 'pg';
import type { Prisma } from 'generated/prisma/client';
import { findDuplicatePairs } from 'src/people/person-duplicate.util';
import {
  describeDatabase,
  matchPeopleByAccount,
  openDatabase,
} from './script.util';

const APPLY = process.argv.includes('--apply');
const BATCH = 500;
// The serial part of YYMMNNN; an old serial past this does not fit.
const MAX_SERIAL = 999;
// Who "paid" an old project total. Honest about what the old row was.
const PROJECT_TOTAL_PAYER = 'إجمالي شهري منقول من الكشف القديم';

interface LegacyMember {
  id: string;
  name: string;
  joinYear: number;
  joinMonth: number;
  serial: number;
  previousSubscription: string;
  expectedAnnualRate: string;
  status: 'ACTIVE' | 'DORMANT';
}

interface LegacyCell {
  id: string;
  memberId: string | null;
  projectAccountId: string | null;
  year: number;
  month: number;
  type: 'AMOUNT' | 'STARRED';
  amount: string | null;
}

const accountNumberOf = (m: LegacyMember) =>
  `${String(m.joinYear % 100).padStart(2, '0')}${String(m.joinMonth).padStart(2, '0')}${String(m.serial).padStart(3, '0')}`;

async function readLegacy(url: string) {
  const legacy = new Client({ connectionString: url });
  await legacy.connect();
  try {
    // NUMERIC as text, so no amount passes through a JS float on the way.
    const members = (
      await legacy.query<LegacyMember>(
        `SELECT "id", "name", "joinYear", "joinMonth", "serial",
                "previousSubscription"::text AS "previousSubscription",
                "expectedAnnualRate"::text AS "expectedAnnualRate", "status"::text AS "status"
           FROM "Member" WHERE NOT "isDeleted" ORDER BY "joinYear", "joinMonth", "serial"`,
      )
    ).rows;
    const deletedMembers = Number(
      (
        await legacy.query(
          `SELECT count(*) AS n FROM "Member" WHERE "isDeleted"`,
        )
      ).rows[0].n,
    );
    const projects = (
      await legacy.query<{ id: string; name: string }>(
        `SELECT "id", "name" FROM "ProjectAccount" WHERE NOT "isDeleted" ORDER BY "sortOrder", "id"`,
      )
    ).rows;
    const cells = (
      await legacy.query<LegacyCell>(
        `SELECT "id", "memberId", "projectAccountId", "year", "month",
                "type"::text AS "type", "amount"::text AS "amount"
           FROM "MonthlyPayment"`,
      )
    ).rows;
    const cycle = (
      await legacy.query<{
        startYear: number;
        lengthYears: number;
        endYear: number;
      }>(
        `SELECT "startYear", "lengthYears", "endYear" FROM "Cycle" WHERE "isCurrent"`,
      )
    ).rows[0];
    return { members, deletedMembers, projects, cells, cycle };
  } finally {
    await legacy.end();
  }
}

async function main() {
  const legacyUrl = process.env.LEGACY_DATABASE_URL;
  if (!legacyUrl) throw new Error('LEGACY_DATABASE_URL is not set.');
  const { prisma, description } = openDatabase(
    process.env.DATABASE_URL,
    process.env.DATABASE_SCHEMA,
  );
  console.log(`Reading the old shape from ${describeDatabase(legacyUrl)}`);
  console.log(`${APPLY ? 'APPLYING to' : 'Dry run against'} ${description}`);

  try {
    const legacy = await readLegacy(legacyUrl);
    const fund = await prisma.program.findFirst({
      where: { isProtected: true },
      select: { id: true, name: true },
    });
    if (!fund)
      throw new Error(
        'The target has no protected fund program — run the migrations first.',
      );

    // ── Members → People ──
    const tooLong = legacy.members.filter((m) => m.serial > MAX_SERIAL);
    const members = legacy.members.filter((m) => m.serial <= MAX_SERIAL);
    console.log(
      `Members: ${legacy.members.length} live → ${members.length} people` +
        (tooLong.length
          ? `, ${tooLong.length} skipped (serial over ${MAX_SERIAL}: ${tooLong.map((m) => m.name).join(', ')})`
          : '') +
        (legacy.deletedMembers
          ? `; ${legacy.deletedMembers} deleted members skipped`
          : ''),
    );
    const planned = members.map((m) => ({
      key: m.id,
      name: m.name,
      accountNumber: accountNumberOf(m),
    }));
    const before = await matchPeopleByAccount(prisma, planned);
    if (APPLY && before.missing.length > 0) {
      const { count } = await prisma.person.createMany({
        data: before.missing.map(({ name, accountNumber }) => ({
          name,
          accountNumber,
        })),
        skipDuplicates: true,
      });
      console.log(`  inserted ${count} people`);
    }
    const { ids: personOfMember, conflicts } = APPLY
      ? await matchPeopleByAccount(prisma, planned)
      : {
          ...before,
          // Nothing exists yet in a dry run; a placeholder keeps counts honest.
          ids: new Map([
            ...before.ids,
            ...before.missing.map((p) => [p.key, `planned:${p.key}`] as const),
          ]),
        };
    for (const { planned: person, existingName } of conflicts) {
      console.log(
        `  CONFLICT ${person.accountNumber}: "${person.name}" — that number already belongs to "${existingName}". Skipped with its payments; resolve by hand.`,
      );
    }

    // ── Fund enrollments ──
    const enrollments: Prisma.ProgramEnrollmentCreateManyInput[] =
      members.flatMap((m) => {
        const personId = personOfMember.get(m.id);
        return personId
          ? [
              {
                personId,
                programId: fund.id,
                expectedRate: m.expectedAnnualRate,
                previousSubscription: m.previousSubscription,
                status: m.status,
              },
            ]
          : [];
      });
    console.log(`Fund enrollments: ${enrollments.length} planned`);
    if (APPLY) {
      const { count } = await prisma.programEnrollment.createMany({
        data: enrollments,
        skipDuplicates: true,
      });
      console.log(
        `  inserted ${count}, ${enrollments.length - count} already present`,
      );
    }

    // ── Fund cycle ──
    const current = await prisma.cycle.findFirst({
      where: { programId: fund.id, isCurrent: true },
      select: { startYear: true, endYear: true },
    });
    if (legacy.cycle) {
      console.log(
        `Fund cycle ${legacy.cycle.startYear}–${legacy.cycle.endYear}: ${current ? `the fund already has ${current.startYear}–${current.endYear} as current; left alone` : 'create as current'}`,
      );
      if (APPLY && !current) {
        await prisma.cycle.createMany({
          data: [{ programId: fund.id, ...legacy.cycle, isCurrent: true }],
          skipDuplicates: true,
        });
      }
    }
    const fundWindow = current ?? legacy.cycle;

    // ── Project accounts → ledger programs ──
    const programOfProject = new Map<string, string>();
    for (const project of legacy.projects) {
      const existing = await prisma.program.findFirst({
        where: { name: project.name, isDeleted: false },
        select: { id: true, type: true, hasCycles: true },
      });
      if (existing && existing.type === 'PERIODIC' && existing.hasCycles) {
        // A monthly-grid program of that name already exists; its cells need a
        // payer, which the old totals do not have. A person must decide.
        console.log(
          `Program ${project.name}: exists as a monthly grid — its old totals are NOT copied`,
        );
        continue;
      }
      console.log(
        `Program ${project.name}: ${existing ? 'exists (ledger)' : 'create as a ledger program'}`,
      );
      if (existing) programOfProject.set(project.id, existing.id);
      else if (APPLY) {
        const created = await prisma.program.create({
          data: { name: project.name, type: 'PERIODIC', hasCycles: false },
        });
        programOfProject.set(project.id, created.id);
      } else programOfProject.set(project.id, `planned:${project.id}`);
    }

    // ── Cells ──
    const payments: Prisma.PaymentCreateManyInput[] = [];
    let skippedStars = 0;
    for (const cell of legacy.cells) {
      if (cell.memberId) {
        const personId = personOfMember.get(cell.memberId);
        if (!personId) continue; // a deleted or skipped member's cell
        payments.push({
          programId: fund.id,
          personId,
          year: cell.year,
          month: cell.month,
          isStarred: cell.type === 'STARRED',
          amount: cell.type === 'STARRED' ? null : cell.amount,
        });
      } else if (cell.projectAccountId) {
        const programId = programOfProject.get(cell.projectAccountId);
        if (!programId) continue;
        // A ★ on an aggregate line points at another month's total; a ledger
        // has no months to point at, and the star carries no money anyway.
        if (cell.type === 'STARRED') {
          skippedStars++;
          continue;
        }
        const date = `${cell.year}-${String(cell.month).padStart(2, '0')}-01`;
        payments.push({
          programId,
          payerNameFreetext: PROJECT_TOTAL_PAYER,
          amount: cell.amount,
          year: cell.year,
          paymentDate: new Date(`${date}T00:00:00.000Z`),
          idempotencyKey: `legacy-eradat:${cell.id}`,
        });
      }
    }
    console.log(
      `Payments: ${payments.length} planned (${payments.filter((p) => p.isStarred).length} ★)` +
        (skippedStars ? `; ${skippedStars} ★ on project lines skipped` : ''),
    );
    // Copied as they are, but the fund's books open on its current cycle;
    // cells outside it stay invisible until a cycle covering them is current.
    const outsideWindow = fundWindow
      ? payments.filter(
          (p) =>
            p.programId === fund.id &&
            (p.year < fundWindow.startYear || p.year > fundWindow.endYear),
        ).length
      : 0;
    if (outsideWindow > 0 && fundWindow) {
      console.log(
        `  WARNING ${outsideWindow} fund cells fall outside the current cycle ${fundWindow.startYear}–${fundWindow.endYear}; they are kept but will not show until a cycle covering them is current`,
      );
    }
    if (APPLY) {
      let inserted = 0;
      for (let offset = 0; offset < payments.length; offset += BATCH) {
        const { count } = await prisma.payment.createMany({
          data: payments.slice(offset, offset + BATCH),
          skipDuplicates: true,
        });
        inserted += count;
      }
      console.log(
        `  inserted ${inserted}, ${payments.length - inserted} already present`,
      );
    }

    // ── Duplicate review — flags only, never a merge ──
    // Everyone already in the target plus — in a dry run — the people this
    // run would add, so the preview lists the same pairs --apply would raise.
    const existingPeople = await prisma.person.findMany({
      where: { isDeleted: false },
      select: { id: true, name: true, accountNumber: true },
    });
    const people = APPLY
      ? existingPeople
      : [
          ...existingPeople,
          ...before.missing.map((p) => ({
            id: `planned:${p.key}`,
            name: p.name,
            accountNumber: p.accountNumber,
          })),
        ];
    const pairs = findDuplicatePairs(people);
    console.log(
      `Possible duplicates: ${pairs.length} pairs, raised for review in the app — none merged`,
    );
    for (const pair of pairs) {
      const a = people.find((p) => p.id === pair.personAId);
      const b = people.find((p) => p.id === pair.personBId);
      console.log(
        `  ${a?.accountNumber} ${a?.name}  ~  ${b?.accountNumber} ${b?.name}  [${pair.reasons.join(', ')}]`,
      );
    }
    if (APPLY && pairs.length > 0) {
      const { count } = await prisma.personDuplicateFlag.createMany({
        data: pairs,
        skipDuplicates: true,
      });
      console.log(`  raised ${count} new flags`);
    }
    if (!APPLY) console.log('Nothing written. Re-run with --apply to write.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
