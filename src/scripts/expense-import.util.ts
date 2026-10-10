/**
 * Reading a program's expense sheet from the workbook — مصروفات مواساه — and
 * writing it as ExpenseLines and their monthly cells. Shared by
 * seed:mwa-expenses and verify:workbook.
 *
 * The sheet is a monthly grid like the revenue sheets: one row per
 * beneficiary (column B), each year's twelve months and its إجمالـــي, the
 * years in the row above the month names. Every row with a name becomes one
 * line with no heading — مواساة's payouts are all monthly support — and every
 * non-empty month one cell. The totals are the app's to compute; the sheet's
 * الإجمالي row is only checked against.
 */
import { readSheet } from 'read-excel-file/node';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import {
  moneyCell,
  sheetLabel,
  TRANSACTION_TIMEOUT_MS,
} from './books-import.util';
import { cellText } from './workbook.util';

export const MWA_EXPENSE_SHEET = 'مصروفات مواساه';

const NAME_COLUMN = 1; // B
const FIRST_MONTH_COLUMN = 2; // C, January of the first year
const YEAR_BLOCK = 13;
const NAME_HEADER = 'الإسم';
const JANUARY = 'يناير';
const TOTAL_ROW_NAME = 'الإجمالي';

export interface PlannedExpenseLine {
  row: number;
  name: string;
  cells: Array<{ year: number; month: number; amount: string }>;
}

export interface ExpenseSheet {
  data: unknown[][];
  years: Array<{ year: number; column: number }>;
  totalRow: number | null;
  lines: PlannedExpenseLine[];
}

export async function readExpenseSheet(
  file: string,
  sheet: string,
): Promise<ExpenseSheet> {
  const data = (await readSheet(file, sheet)) as unknown[][];
  const header = data.findIndex(
    (cells) => sheetLabel(cells[NAME_COLUMN]) === NAME_HEADER,
  );
  if (header < 1) {
    throw new Error(
      `${sheet}: expected "${NAME_HEADER}" in column B of a header row under the years — has the sheet been reshaped?`,
    );
  }
  const yearRow = data[header - 1];
  const years: ExpenseSheet['years'] = [];
  for (
    let column = FIRST_MONTH_COLUMN;
    typeof yearRow[column] === 'number';
    column += YEAR_BLOCK
  ) {
    if (sheetLabel(data[header][column]) !== JANUARY) {
      throw new Error(
        `${sheet} row ${header + 1}: expected "${JANUARY}" under ${String(yearRow[column])}.`,
      );
    }
    years.push({ year: yearRow[column] as number, column });
  }
  if (years.length === 0) {
    throw new Error(`${sheet}: no year found above the month columns.`);
  }

  const totalIndex = data.findIndex(
    (cells, index) =>
      index > header &&
      [0, NAME_COLUMN].some((c) => sheetLabel(cells[c]) === TOTAL_ROW_NAME),
  );
  const end = totalIndex < 0 ? data.length : totalIndex;
  const lines: PlannedExpenseLine[] = [];
  const seen = new Map<string, number>();
  for (let index = header + 1; index < end; index++) {
    const row = index + 1;
    const name = cellText(data[index][NAME_COLUMN]);
    if (!name) continue;
    // Lines are matched by name on a re-run, so two rows with one name would
    // land on one line and collide on every month.
    const other = seen.get(name);
    if (other !== undefined) {
      throw new Error(
        `${sheet} rows ${other} and ${row} are both "${name}" — rename one first.`,
      );
    }
    seen.set(name, row);
    const cells: PlannedExpenseLine['cells'] = [];
    for (const { year, column } of years) {
      for (let month = 1; month <= 12; month++) {
        const amount = moneyCell(
          sheet,
          data[index][column + month - 1],
          row,
          column + month - 1,
        );
        // An empty cell is the zero; CHECK "Expense_amount_positive" refuses
        // a stored 0.
        if (amount !== '0.00') cells.push({ year, month, amount });
      }
    }
    lines.push({ row, name, cells });
  }
  return {
    data,
    years,
    totalRow: totalIndex < 0 ? null : totalIndex + 1,
    lines,
  };
}

/** The sheet's own month totals must equal what is about to be written. */
export function checkExpenseTotals(sheet: ExpenseSheet): boolean {
  if (sheet.totalRow === null) {
    console.log(`  (no ${TOTAL_ROW_NAME} row found — totals not checked)`);
    return true;
  }
  const totals = sheet.data[sheet.totalRow - 1];
  let ok = true;
  for (const { year, column } of sheet.years) {
    for (let month = 1; month <= 12; month++) {
      const expected =
        typeof totals[column + month - 1] === 'number'
          ? (totals[column + month - 1] as number)
          : 0;
      const ours =
        Math.round(
          sheet.lines
            .flatMap((line) => line.cells)
            .filter((cell) => cell.year === year && cell.month === month)
            .reduce((total, cell) => total + Number(cell.amount), 0) * 100,
        ) / 100;
      const match = Math.abs(expected - ours) < 0.005;
      ok &&= match;
      if (!match || ours !== 0) {
        console.log(
          `  ${match ? 'ok      ' : 'MISMATCH'} ${year}-${String(month).padStart(2, '0')}: ${ours.toLocaleString('en')}${match ? '' : ` (sheet: ${expected.toLocaleString('en')})`}`,
        );
      }
    }
  }
  return ok;
}

/**
 * Writes the planned lines and cells into a program, in one transaction.
 * Re-runnable: a line is found again by its name among the program's
 * ungrouped lines, and cells dedupe on (line, year, month), so a second run
 * adds nothing and a cell changed in the app since is left as it is.
 */
export async function writeExpenseSheet(
  prisma: PrismaClient,
  programId: string,
  lines: readonly PlannedExpenseLine[],
) {
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.expenseLine.findMany({
        where: { programId, category: null },
        select: { id: true, name: true },
      });
      const idByName = new Map(existing.map((line) => [line.name, line.id]));
      let created = 0;
      for (const [index, line] of lines.entries()) {
        if (idByName.has(line.name)) continue;
        const { id } = await tx.expenseLine.create({
          data: { programId, name: line.name, sortOrder: index + 1 },
          select: { id: true },
        });
        idByName.set(line.name, id);
        created++;
      }
      const cells: Prisma.ExpenseCreateManyInput[] = lines.flatMap((line) =>
        line.cells.map((cell) => ({
          programId,
          lineId: idByName.get(line.name) ?? '',
          ...cell,
        })),
      );
      const { count } = await tx.expense.createMany({
        data: cells,
        skipDuplicates: true,
      });
      return { created, cells: count, plannedCells: cells.length };
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_TIMEOUT_MS },
  );
}
