/**
 * Proves the books in the database are the workbook's: every imported sheet
 * is read again, the way its seed reads it, and compared row by row and
 * month by month with what the database holds.
 *
 *   npm run verify:workbook -- --file "../CHARITY FUND 2026-2029 (1).xlsx"
 *
 * Read-only. Checks:
 *   - الايرادات → the protected fund program (seed:fund-eradat);
 *   - ايرادات مواساة → the program مواساة (seed:mwa-eradat);
 *   - مصروفات مواساه → مواساة's expense lines (seed:mwa-expenses).
 * For each person: enrolled, previous subscription, pledge and status; for
 * each month of the sheet's years: the same amount, the same ★, or empty on
 * both sides. Anything the database holds that the sheet does not — another
 * enrollment, a cell in a month the sheet leaves empty, a cell in another
 * year — is reported too. Exits 1 on any difference, so a check that prints
 * nothing but "same" can be trusted.
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import type { PrismaClient } from '../../generated/prisma/client';
import {
  FUND_LAYOUT,
  MWA_LAYOUT,
  MWA_PROGRAM_NAME,
  planEnrollment,
  readFrozenAccounts,
  readGrid,
  resolveContributors,
  type PlannedEnrollment,
  type SheetLayout,
} from './books-import.util';
import { MWA_EXPENSE_SHEET, readExpenseSheet } from './expense-import.util';
import { openDatabase } from './script.util';
import { FUND_SHEET, planContributors, readPeople } from './workbook.util';

type Mark = string | null; // an amount "1000.00", "*" for ★, or null for empty

const cellKey = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, '0')}`;

class Report {
  differences = 0;
  constructor(private readonly title: string) {
    console.log(`\n${title}`);
  }
  differ(line: string) {
    this.differences++;
    // A long list of the same kind of difference says enough after 40.
    if (this.differences <= 40) console.log(`  DIFF ${line}`);
  }
  done(summary: string) {
    console.log(
      this.differences === 0
        ? `  same — ${summary}`
        : `  ${this.differences} differences in ${this.title}`,
    );
    return this.differences;
  }
}

async function verifyRevenue(
  prisma: PrismaClient,
  file: string,
  layout: SheetLayout,
  program: { id: string; name: string },
  accountOf: (p: PlannedEnrollment) => string,
): Promise<number> {
  const report = new Report(`${layout.sheet} → ${program.name}`);
  const [grid, rows, frozen] = await Promise.all([
    readGrid(file, layout),
    readPeople(file, layout.sheet),
    readFrozenAccounts(file, layout),
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
  const ids = await resolveContributors(prisma, planned, accountOf, () => {});
  const [enrollments, payments] = await Promise.all([
    prisma.programEnrollment.findMany({
      where: { programId: program.id },
      select: {
        contributorId: true,
        expectedRate: true,
        previousSubscription: true,
        status: true,
        contributor: { select: { accountNumber: true, name: true } },
      },
    }),
    prisma.payment.findMany({
      where: { programId: program.id, contributorId: { not: null } },
      select: {
        contributorId: true,
        year: true,
        month: true,
        isStarred: true,
        amount: true,
      },
    }),
  ]);
  const enrollmentOf = new Map(enrollments.map((e) => [e.contributorId, e]));
  const marksOf = new Map<string, Map<string, Mark>>();
  for (const payment of payments) {
    if (!payment.contributorId) continue;
    const marks = marksOf.get(payment.contributorId) ?? new Map<string, Mark>();
    marks.set(
      payment.month === null
        ? `dated ${payment.year}`
        : cellKey(payment.year, payment.month),
      payment.isStarred ? '*' : (payment.amount?.toFixed(2) ?? null),
    );
    marksOf.set(payment.contributorId, marks);
  }
  const sheetYears = new Set(grid.years.map((y) => y.year));

  let cellsCompared = 0;
  for (const p of planned) {
    const contributorId = ids.get(p)!;
    const who = `row ${p.sheetRow.row} ${p.sheetRow.accountNumber} ${p.sheetRow.name}`;
    const enrollment = enrollmentOf.get(contributorId);
    if (!enrollment) {
      report.differ(`${who}: not enrolled`);
      continue;
    }
    if (enrollment.previousSubscription.toFixed(2) !== p.previous) {
      report.differ(
        `${who}: previous ${enrollment.previousSubscription.toFixed(2)}, sheet ${p.previous}`,
      );
    }
    if (enrollment.expectedRate.toFixed(2) !== p.rate) {
      report.differ(
        `${who}: pledge ${enrollment.expectedRate.toFixed(2)}, sheet ${p.rate}`,
      );
    }
    if ((enrollment.status === 'DORMANT') !== p.dormant) {
      report.differ(
        `${who}: ${enrollment.status}, sheet ${p.dormant ? 'DORMANT' : 'ACTIVE'}`,
      );
    }
    const sheetMarks = new Map<string, Mark>(
      p.cells.map((c) => [cellKey(c.year, c.month), c.amount ?? '*']),
    );
    const dbMarks = marksOf.get(contributorId) ?? new Map<string, Mark>();
    for (const { year } of grid.years) {
      for (let month = 1; month <= 12; month++) {
        const key = cellKey(year, month);
        const sheet = sheetMarks.get(key) ?? null;
        const db = dbMarks.get(key) ?? null;
        cellsCompared++;
        if (sheet !== db)
          report.differ(
            `${who} ${key}: database ${db ?? 'empty'}, sheet ${sheet ?? 'empty'}`,
          );
      }
    }
    for (const [key, mark] of dbMarks) {
      const year = Number(key.slice(-7, -3));
      if (key.startsWith('dated') || !sheetYears.has(year)) {
        report.differ(`${who} ${key}: database ${mark}, not on the sheet`);
      }
    }
    enrollmentOf.delete(contributorId);
  }
  for (const extra of enrollmentOf.values()) {
    report.differ(
      `${extra.contributor.accountNumber} ${extra.contributor.name}: enrolled, but not on the sheet`,
    );
  }
  return report.done(
    `${planned.length} enrollments, ${cellsCompared} months compared (${payments.length} cells stored)`,
  );
}

async function verifyExpenses(
  prisma: PrismaClient,
  file: string,
  program: { id: string; name: string },
): Promise<number> {
  const report = new Report(`${MWA_EXPENSE_SHEET} → ${program.name} expenses`);
  const [sheet, lines] = await Promise.all([
    readExpenseSheet(file, MWA_EXPENSE_SHEET),
    prisma.expenseLine.findMany({
      where: { programId: program.id },
      select: {
        id: true,
        name: true,
        expenses: { select: { year: true, month: true, amount: true } },
      },
    }),
  ]);
  const byName = new Map(lines.map((line) => [line.name, line]));
  let cellsCompared = 0;
  for (const planned of sheet.lines) {
    const who = `row ${planned.row} ${planned.name}`;
    const line = byName.get(planned.name);
    if (!line) {
      report.differ(`${who}: no expense line`);
      continue;
    }
    const sheetCells = new Map(
      planned.cells.map((c) => [cellKey(c.year, c.month), c.amount]),
    );
    const dbCells = new Map(
      line.expenses.map((e) => [cellKey(e.year, e.month), e.amount.toFixed(2)]),
    );
    for (const { year } of sheet.years) {
      for (let month = 1; month <= 12; month++) {
        const key = cellKey(year, month);
        cellsCompared++;
        const a = sheetCells.get(key) ?? null;
        const b = dbCells.get(key) ?? null;
        if (a !== b)
          report.differ(
            `${who} ${key}: database ${b ?? 'empty'}, sheet ${a ?? 'empty'}`,
          );
        dbCells.delete(key);
      }
    }
    for (const [key, amount] of dbCells)
      report.differ(`${who} ${key}: database ${amount}, not on the sheet`);
    byName.delete(planned.name);
  }
  for (const extra of byName.values())
    report.differ(`${extra.name}: a line not on the sheet`);
  return report.done(
    `${sheet.lines.length} lines, ${cellsCompared} months compared`,
  );
}

async function main() {
  const { values } = parseArgs({ options: { file: { type: 'string' } } });
  if (!values.file)
    throw new Error('Usage: --file <path to the workbook .xlsx>');
  const file = values.file;

  const { prisma, description } = openDatabase(
    process.env.DATABASE_URL,
    process.env.DATABASE_SCHEMA,
  );
  console.log(`Comparing ${file} with ${description}`);
  try {
    // The raw client: say isDeleted out loud.
    const [fund, mwa] = await Promise.all([
      prisma.program.findFirst({
        where: { isProtected: true, isDeleted: false },
        select: { id: true, name: true },
      }),
      prisma.program.findFirst({
        where: {
          name: { equals: MWA_PROGRAM_NAME, mode: 'insensitive' },
          isDeleted: false,
        },
        select: { id: true, name: true },
      }),
    ]);
    let differences = 0;
    if (!fund)
      throw new Error('No protected fund program — run the migrations first.');
    differences += await verifyRevenue(
      prisma,
      file,
      FUND_LAYOUT,
      fund,
      (p) => p.sheetRow.accountNumber,
    );

    if (!mwa) {
      console.log(
        `\nNo live program named ${MWA_PROGRAM_NAME} — run seed:mwa-eradat.`,
      );
      differences++;
    } else {
      const [fundRows, mwaRows] = await Promise.all([
        readPeople(file, FUND_SHEET),
        readPeople(file, MWA_LAYOUT.sheet),
      ]);
      const kept = new Map(
        planContributors(fundRows, mwaRows).folds.map((f) => [
          f.mwa.accountNumber,
          f.kept.accountNumber,
        ]),
      );
      differences += await verifyRevenue(
        prisma,
        file,
        MWA_LAYOUT,
        mwa,
        (p) => kept.get(p.sheetRow.accountNumber) ?? p.sheetRow.accountNumber,
      );
      differences += await verifyExpenses(prisma, file, mwa);
    }
    console.log(
      differences === 0
        ? '\nThe database holds exactly what the workbook does.'
        : `\n${differences} differences in all.`,
    );
    if (differences > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
