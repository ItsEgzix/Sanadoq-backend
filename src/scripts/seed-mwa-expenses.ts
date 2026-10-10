/**
 * Imports مواساة's expenses from the workbook's مصروفات مواساه sheet: one
 * expense line per beneficiary, one cell per month paid out. Into the
 * periodic program named مواساة — created on the first --apply if no live
 * program has the name, exactly as seed:mwa-eradat would. How the sheet is
 * read is expense-import.util.ts.
 *
 *   npm run seed:mwa-expenses -- --file "../CHARITY FUND 2026-2029 (1).xlsx"           dry run
 *   npm run seed:mwa-expenses -- --file "../CHARITY FUND 2026-2029 (1).xlsx" --apply   writes
 *
 * The beneficiaries are names only, never Contributors: the people مواساة
 * supports are not its payers. The yearly history on التراكمي مواساه
 * (2008–2025) is left out — those are totals, with nobody and no month under
 * them, and these books start in 2026.
 *
 * Re-runnable and additive: a second run adds nothing.
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { findOrCreateProgram, MWA_PROGRAM_NAME } from './books-import.util';
import {
  checkExpenseTotals,
  MWA_EXPENSE_SHEET,
  readExpenseSheet,
  writeExpenseSheet,
} from './expense-import.util';
import { openDatabase } from './script.util';

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
  const sheet = await readExpenseSheet(values.file, MWA_EXPENSE_SHEET);
  const cells = sheet.lines.flatMap((line) => line.cells);
  console.log(
    `Years on ${MWA_EXPENSE_SHEET}: ${sheet.years.map((y) => y.year).join(', ')}`,
  );
  console.log(
    `Expense lines: ${sheet.lines.length} planned, ${cells.length} cells`,
  );
  console.log(`Checking against the sheet's الإجمالي row:`);
  const totalsOk = checkExpenseTotals(sheet);

  const { prisma, description } = openDatabase(
    process.env.DATABASE_URL,
    process.env.DATABASE_SCHEMA,
  );
  console.log(`${apply ? 'APPLYING to' : 'Dry run against'} ${description}`);
  try {
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
      const [lines, stored] = await Promise.all([
        prisma.expenseLine.count({ where: { programId: program.id } }),
        prisma.expense.count({ where: { programId: program.id } }),
      ]);
      console.log(
        `  already in the database: ${lines} lines, ${stored} cells. Nothing written. Re-run with --apply to write.`,
      );
      return;
    }
    const written = await writeExpenseSheet(prisma, program.id, sheet.lines);
    console.log(
      `  inserted ${written.created} lines and ${written.cells} cells; ${sheet.lines.length - written.created} and ${written.plannedCells - written.cells} were already there`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
