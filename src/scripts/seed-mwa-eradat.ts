/**
 * Imports مواساة's revenue from the workbook's ايرادات مواساة sheet into a
 * periodic program named مواساة — created on the first --apply if no live
 * program has the name. One enrollment per person, carrying the previous
 * subscription (الاشتراك السابق, column D) and the month they joined مواساة,
 * and every month cell of the sheet's years. How the sheet is read is
 * books-import.util.ts.
 *
 *   npm run seed:mwa-eradat -- --file "../CHARITY FUND 2026-2029 (1).xlsx"           dry run
 *   npm run seed:mwa-eradat -- --file "../CHARITY FUND 2026-2029 (1).xlsx" --apply   writes
 *
 * The sheet keeps no yearly pledge, so every enrollment imports with a pledge
 * of 0: nothing is invented, and العجز stays empty until the fund sets
 * pledges in the app.
 *
 * Runs after seed:contributors. People on both this sheet and the fund's were
 * folded there into one record under their older account number (the fold
 * rule in workbook.util.ts), so each row here is linked to the record its
 * fold kept, and the month it joined مواساة still comes from this sheet's
 * own number. It never creates people.
 *
 * Left out: the totals (the app computes them), and the frozen balances on
 * الحسابات الخاملة — the 790,000 the fund's sheet adds to مواساة's previous
 * subscriptions. Where a frozen balance goes when someone rejoins is still
 * open with the fund, so they stay on that sheet, as for the fund's own
 * frozen accounts.
 *
 * Re-runnable and additive, like seed:fund-eradat.
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import {
  checkAgainstTotals,
  describePlan,
  findOrCreateProgram,
  MWA_LAYOUT,
  MWA_PROGRAM_NAME,
  planEnrollment,
  readFrozenAccounts,
  readGrid,
  resolveContributors,
  writeBooks,
} from './books-import.util';
import { openDatabase } from './script.util';
import { FUND_SHEET, planContributors, readPeople } from './workbook.util';

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
  const [grid, fundRows, rows, frozen] = await Promise.all([
    readGrid(values.file, MWA_LAYOUT),
    readPeople(values.file, FUND_SHEET),
    readPeople(values.file, MWA_LAYOUT.sheet),
    readFrozenAccounts(values.file, MWA_LAYOUT),
  ]);
  // The same fold seed:contributors applied, so each row lands on the record
  // that import kept for it.
  const { folds } = planContributors(fundRows, rows);
  const keptAccount = new Map(
    folds.map((fold) => [fold.mwa.accountNumber, fold.kept.accountNumber]),
  );
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
    const ids = await resolveContributors(
      prisma,
      planned,
      (p) =>
        keptAccount.get(p.sheetRow.accountNumber) ?? p.sheetRow.accountNumber,
    );
    if (!totalsOk) {
      if (apply)
        throw new Error('The sheet totals do not match — nothing written.');
      console.log(
        'Nothing written. The totals above do not match — check before applying.',
      );
      return;
    }
    const program = await findOrCreateProgram(
      prisma,
      MWA_PROGRAM_NAME,
      'PERIODIC',
      apply,
    );
    if (!program) {
      console.log(
        `Program: ${MWA_PROGRAM_NAME} does not exist yet — --apply creates it (periodic). Nothing written.`,
      );
      return;
    }
    console.log(
      `Program: ${program.name}${program.created ? ' (created)' : ''}`,
    );
    if (!apply) {
      const [enrolledAlready, cellsAlready] = await Promise.all([
        prisma.programEnrollment.count({ where: { programId: program.id } }),
        prisma.payment.count({ where: { programId: program.id } }),
      ]);
      console.log(
        `  already in the database: ${enrolledAlready} enrollments, ${cellsAlready} cells. Nothing written. Re-run with --apply to write.`,
      );
      return;
    }
    const written = await writeBooks(prisma, program.id, planned, ids);
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
