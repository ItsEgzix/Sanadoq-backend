/**
 * Imports the fund's own books from the workbook's revenue sheet (الايرادات)
 * into the protected fund program (اشتراكات الصندوق): one enrollment per
 * person, carrying the yearly pledge (معدل اشتراك سنوي, column E) and the
 * previous subscription (الاشتراك السابق, column D), the month they joined,
 * and every month cell of the sheet's years — a number as a payment, * as ★.
 * How the sheet is read is books-import.util.ts.
 *
 *   npm run seed:fund-eradat -- --file "../CHARITY FUND 2026-2029 (1).xlsx"           dry run
 *   npm run seed:fund-eradat -- --file "../CHARITY FUND 2026-2029 (1).xlsx" --apply   writes
 *
 * Runs after seed:contributors, and each row finds its Contributor by the
 * account number on this sheet. That import folded people who are also on
 * مواساة's sheet into one record under their older number, which on this
 * workbook is always the fund's; were it ever the مواساة one, the row would
 * find no record and the run would stop — it never creates people.
 *
 * Deliberately left out:
 *   - the rows for مواساة, the campaigns and جامع السعيد (4–6). They roll
 *     other programs into the sheet's totals; مواساة's own books are
 *     seed:mwa-eradat's, and how the others belong in the fund's books is not
 *     decided yet;
 *   - every total (each year's إجمالـــي, BG, BH, the الإجمــالي row): the app
 *     computes them. The dry run checks the sheet's totals against what it is
 *     about to write, minus the rows it leaves out.
 *
 * Re-runnable and additive: a second run adds nothing, and a run after
 * someone removed a row or a cell in the app puts it back as the sheet has
 * it, without touching anything else.
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import type { PrismaClient } from '../../generated/prisma/client';
import {
  checkAgainstTotals,
  describePlan,
  FUND_LAYOUT,
  planEnrollment,
  readFrozenAccounts,
  readGrid,
  resolveContributors,
  writeBooks,
} from './books-import.util';
import { openDatabase } from './script.util';
import { readPeople } from './workbook.util';

async function findFund(prisma: PrismaClient) {
  // The raw client: say isDeleted out loud.
  const fund = await prisma.program.findFirst({
    where: { isProtected: true, isDeleted: false },
    select: { id: true, name: true },
  });
  if (!fund) {
    throw new Error('No protected fund program — run the migrations first.');
  }
  return fund;
}

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  if (!values.file) {
    throw new Error('Usage: --file <path to the workbook .xlsx> [--apply]');
  }
  const apply = values.apply;

  console.log(`Reading ${values.file}`);
  const [grid, rows, frozen] = await Promise.all([
    readGrid(values.file, FUND_LAYOUT),
    readPeople(values.file, FUND_LAYOUT.sheet),
    readFrozenAccounts(values.file, FUND_LAYOUT),
  ]);
  const planned = rows.map((row) =>
    planEnrollment(
      grid,
      row,
      frozen.has(row.accountNumber)
        ? { date: frozen.get(row.accountNumber) ?? null }
        : null,
    ),
  );
  describePlan(grid, planned);
  console.log(`Checking against the sheet's الإجمالي row:`);
  const totalsOk = checkAgainstTotals(grid, planned);

  const { prisma, description } = openDatabase(
    process.env.DATABASE_URL,
    process.env.DATABASE_SCHEMA,
  );
  console.log(`${apply ? 'APPLYING to' : 'Dry run against'} ${description}`);
  try {
    const fund = await findFund(prisma);
    console.log(`Program: ${fund.name}`);
    const ids = await resolveContributors(
      prisma,
      planned,
      (p) => p.sheetRow.accountNumber,
    );
    const [enrolledAlready, cellsAlready] = await Promise.all([
      prisma.programEnrollment.count({
        where: { programId: fund.id, contributorId: { in: [...ids.values()] } },
      }),
      prisma.payment.count({
        where: { programId: fund.id, contributorId: { in: [...ids.values()] } },
      }),
    ]);
    console.log(
      `  already in the database: ${enrolledAlready} of these enrollments, ${cellsAlready} cells`,
    );

    if (!apply) {
      console.log(
        totalsOk
          ? 'Nothing written. Re-run with --apply to write.'
          : 'Nothing written. The totals above do not match — check before applying.',
      );
      return;
    }
    if (!totalsOk) {
      throw new Error('The sheet totals do not match — nothing written.');
    }
    const written = await writeBooks(prisma, fund.id, planned, ids);
    console.log(
      `  inserted ${written.enrolled} enrollments (${written.terms} terms) and ${written.cells} cells; ${written.plannedEnrollments - written.enrolled} and ${written.plannedCells - written.cells} were already there`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
