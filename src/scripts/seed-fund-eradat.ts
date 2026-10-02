/**
 * Imports the fund's own books from the workbook's revenue sheet (الايرادات)
 * into the protected fund program (اشتراكات الصندوق): one enrollment per
 * person, carrying the yearly pledge (معدل اشتراك سنوي, column E) and the
 * previous subscription (الاشتراك السابق, column D), and every month cell of
 * the sheet's years — a number as a payment, * as ★.
 *
 *   npm run seed:fund-eradat -- --file "../CHARITY FUND 2026-2029 (1).xlsx"           dry run
 *   npm run seed:fund-eradat -- --file "../CHARITY FUND 2026-2029 (1).xlsx" --apply   writes
 *
 * The fund's sheet only; nothing is read from or written for مواساة. Runs
 * after seed:contributors, and each row finds its Contributor by the account
 * number on this sheet. That import folded people who are also on مواساة's
 * sheet into one record under their older number, which on this workbook is
 * always the fund's; were it ever the مواساة one, the row would find no
 * record and the run would stop — it never creates people.
 *
 * Deliberately left out:
 *   - the rows for مواساة, the campaigns and جامع السعيد (4–6). They roll
 *     other programs into the sheet's totals, and how they belong in the
 *     fund's books is not decided yet;
 *   - every total (each year's إجمالـــي, BG, BH, the الإجمــالي row): the app
 *     computes them. The dry run checks the sheet's totals against what it is
 *     about to write, minus the rows it leaves out.
 *
 * Someone listed as frozen on الحسابات الخاملة whose row here is empty — no
 * pledge, no previous subscription, no cell — is enrolled DORMANT. Their
 * frozen balance stays on that sheet: where it goes when someone rejoins is a
 * question still open with the fund. A frozen-listed person whose row here
 * carries figures has rejoined, and this sheet is the newer word: ACTIVE.
 *
 * Re-runnable: enrollments dedupe on (contributor, program) and cells on
 * (program, contributor, year, month), so a second run adds nothing. Rows
 * already in the database are never overwritten — a pledge corrected in the
 * app since stays corrected. Everything is written in one transaction, so a
 * failure leaves nothing half-imported.
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { readSheet } from 'read-excel-file/node';
import { CONTRIBUTOR_ACCOUNT_NUMBER_PATTERN } from '../contributors/contributor.constant';
import { openDatabase } from './script.util';
import {
  accountText,
  cellText,
  FUND_SHEET,
  readPeople,
  type SheetRow,
} from './workbook.util';

const DORMANT_SHEET = 'الحسابات الخاملة';
// The fund's half of the frozen-accounts sheet keeps account numbers in
// column E; مواساة's half, from column J on, has none.
const DORMANT_ACCOUNT_COLUMN = 4;

// Zero-based columns of الايرادات. readGrid() checks the headers above them,
// so a reshaped sheet stops the run instead of filing money in wrong months.
const NAME_COLUMN = 1;
const PREVIOUS_COLUMN = 3; // D
const RATE_COLUMN = 4; // E
const FIRST_MONTH_COLUMN = 5; // F, January of the first year
const YEAR_BLOCK = 13; // twelve months, then the year's إجمالـــي
const ACCOUNT_HEADER = 'رقم الحساب';
const PREVIOUS_HEADER = 'الاشتراك السابق';
const RATE_HEADER = 'معدل اشتراك';
const JANUARY = 'يناير';
const TOTAL_ROW_NAME = 'الإجمالي';
const STAR = '*';
const TATWEEL = /ـ/g;

const BATCH = 500;
// ~1,000 rows in a handful of statements; Neon answers each in ~200 ms from
// the dev machine. Generous, so a slow link fails loudly rather than midway.
const TRANSACTION_TIMEOUT_MS = 120_000;

interface Grid {
  data: unknown[][];
  // Each year of the sheet and the column of its January.
  years: Array<{ year: number; column: number }>;
  totalRow: number | null;
}

interface PlannedCell {
  year: number;
  month: number;
  // null: ★, paid but booked under another month.
  amount: string | null;
}

interface PlannedEnrollment {
  sheetRow: SheetRow;
  previous: string;
  rate: string;
  dormant: boolean;
  // On the frozen list, yet paying again on this sheet.
  rejoined: boolean;
  cells: PlannedCell[];
}

const where = (row: number, column: number) =>
  `${FUND_SHEET} row ${row} column ${String.fromCharCode(65 + column)}`;

const sheetLabel = (value: unknown) => cellText(value).replace(TATWEEL, '');

// A blank figure is zero: الايرادات leaves pledge and previous empty for the
// frozen accounts. Anything but a non-negative number of whole fils stops the
// run, since a guessed amount would sit in the books unnoticed.
function moneyCell(value: unknown, row: number, column: number): string {
  if (value === null || value === undefined || value === '') return '0.00';
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `${where(row, column)}: ${JSON.stringify(value)} is not an amount.`,
    );
  }
  if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) {
    throw new Error(
      `${where(row, column)}: ${value} has more than 2 decimals.`,
    );
  }
  return value.toFixed(2);
}

async function readGrid(file: string): Promise<Grid> {
  const data = (await readSheet(file, FUND_SHEET)) as unknown[][];
  const header = data.findIndex((cells) =>
    sheetLabel(cells[2]).startsWith(ACCOUNT_HEADER),
  );
  const headers = header < 0 ? [] : data[header];
  if (
    header < 1 ||
    sheetLabel(headers[PREVIOUS_COLUMN]) !== PREVIOUS_HEADER ||
    !sheetLabel(headers[RATE_COLUMN]).startsWith(RATE_HEADER)
  ) {
    throw new Error(
      `${FUND_SHEET}: expected "${PREVIOUS_HEADER}" in column D and "${RATE_HEADER}…" in column E of the header row — has the sheet been reshaped?`,
    );
  }

  // The years sit one row above the month names, over each January.
  const years: Grid['years'] = [];
  for (
    let column = FIRST_MONTH_COLUMN;
    typeof data[header - 1][column] === 'number';
    column += YEAR_BLOCK
  ) {
    if (sheetLabel(headers[column]) !== JANUARY) {
      throw new Error(
        `${where(header + 1, column)}: expected "${JANUARY}" under ${String(data[header - 1][column])}.`,
      );
    }
    years.push({ year: data[header - 1][column] as number, column });
  }
  if (years.length === 0) {
    throw new Error(`${FUND_SHEET}: no year found above the month columns.`);
  }

  const totalIndex = data.findIndex(
    (cells, index) =>
      index > header && sheetLabel(cells[NAME_COLUMN]) === TOTAL_ROW_NAME,
  );
  return { data, years, totalRow: totalIndex < 0 ? null : totalIndex + 1 };
}

async function readDormantAccounts(file: string): Promise<Set<string>> {
  const data = (await readSheet(file, DORMANT_SHEET)) as unknown[][];
  const accounts = new Set<string>();
  for (const cells of data) {
    const account = accountText(cells[DORMANT_ACCOUNT_COLUMN]);
    if (CONTRIBUTOR_ACCOUNT_NUMBER_PATTERN.test(account)) accounts.add(account);
  }
  return accounts;
}

function planEnrollment(
  grid: Grid,
  sheetRow: SheetRow,
  frozen: boolean,
): PlannedEnrollment {
  const cells = grid.data[sheetRow.row - 1];
  const planned: PlannedCell[] = [];
  for (const { year, column } of grid.years) {
    for (let month = 1; month <= 12; month++) {
      const at = column + month - 1;
      const value = cells[at];
      if (value === null || value === undefined || value === '') continue;
      if (typeof value === 'string' && value.trim() === STAR) {
        planned.push({ year, month, amount: null });
        continue;
      }
      const amount = moneyCell(value, sheetRow.row, at);
      // An empty cell is the zero; a stored 0 would read as "paid" and is
      // refused by CHECK "Payment_amount_matches_star".
      if (amount !== '0.00') planned.push({ year, month, amount });
    }
  }
  const previous = moneyCell(
    cells[PREVIOUS_COLUMN],
    sheetRow.row,
    PREVIOUS_COLUMN,
  );
  const rate = moneyCell(cells[RATE_COLUMN], sheetRow.row, RATE_COLUMN);
  const empty = previous === '0.00' && rate === '0.00' && planned.length === 0;
  return {
    sheetRow,
    previous,
    rate,
    dormant: frozen && empty,
    rejoined: frozen && !empty,
    cells: planned,
  };
}

const sum = (values: Iterable<number>) => {
  let total = 0;
  for (const value of values) total += value;
  return Math.round(total * 100) / 100;
};
const asNumber = (value: unknown) => (typeof value === 'number' ? value : 0);

/**
 * The sheet's own totals, less the rows this import leaves out, must equal
 * what it is about to write — proof that no person, month or year was read
 * from the wrong place. Printed either way; a mismatch is for a human to read
 * before applying, not a reason to guess.
 */
function checkAgainstTotals(
  grid: Grid,
  planned: readonly PlannedEnrollment[],
): boolean {
  if (grid.totalRow === null) {
    console.log(`  (no ${TOTAL_ROW_NAME} row found — totals not checked)`);
    return true;
  }
  const totals = grid.data[grid.totalRow - 1];
  const imported = new Set(planned.map((p) => p.sheetRow.row));
  const header =
    grid.data.findIndex((cells) =>
      sheetLabel(cells[2]).startsWith(ACCOUNT_HEADER),
    ) + 1;
  // Rows between the header and the total that carry figures but are not
  // imported: the programs on rows 4–6.
  const leftOut = grid.data
    .slice(header, grid.totalRow - 1)
    .map((cells, index) => ({ cells, row: header + index + 1 }))
    .filter(({ row }) => !imported.has(row));

  let ok = true;
  const compare = (label: string, column: number, ours: number) => {
    const expected = sum([
      asNumber(totals[column]),
      ...leftOut.map(({ cells }) => -asNumber(cells[column])),
    ]);
    const match = Math.abs(expected - ours) < 0.005;
    ok &&= match;
    if (!match || ours !== 0) {
      console.log(
        `  ${match ? 'ok      ' : 'MISMATCH'} ${label}: ${ours.toLocaleString('en')}${match ? '' : ` (sheet less rows left out: ${expected.toLocaleString('en')})`}`,
      );
    }
  };
  compare(
    PREVIOUS_HEADER,
    PREVIOUS_COLUMN,
    sum(planned.map((p) => Number(p.previous))),
  );
  compare(RATE_HEADER, RATE_COLUMN, sum(planned.map((p) => Number(p.rate))));
  for (const { year, column } of grid.years) {
    for (let month = 1; month <= 12; month++) {
      compare(
        `${year}-${String(month).padStart(2, '0')}`,
        column + month - 1,
        sum(
          planned.flatMap((p) =>
            p.cells
              .filter((c) => c.year === year && c.month === month)
              .map((c) => Number(c.amount ?? 0)),
          ),
        ),
      );
    }
  }
  return ok;
}

async function findFund(prisma: PrismaClient) {
  // The raw client: say isDeleted out loud.
  const fund = await prisma.program.findFirst({
    where: { isProtected: true, isDeleted: false },
    select: {
      id: true,
      name: true,
      cycles: {
        where: { isCurrent: true },
        select: { startYear: true, endYear: true },
      },
    },
  });
  if (!fund) {
    throw new Error('No protected fund program — run the migrations first.');
  }
  const cycle = fund.cycles[0];
  if (!cycle) {
    throw new Error(
      `${fund.name} has no current cycle. Create it in the app (Cycles), then re-run.`,
    );
  }
  return { id: fund.id, name: fund.name, cycle };
}

/**
 * Each planned row's Contributor id, by account number. A record merged away
 * since seed:contributors resolves to the record a reviewer kept. A missing
 * record, or two rows landing on one record, stops the run: the import never
 * creates people, and two rows on one record would collide on every cell.
 */
async function resolveContributors(
  prisma: PrismaClient,
  planned: readonly PlannedEnrollment[],
): Promise<Map<PlannedEnrollment, string>> {
  const found = await prisma.contributor.findMany({
    where: {
      accountNumber: { in: planned.map((p) => p.sheetRow.accountNumber) },
    },
    select: {
      id: true,
      name: true,
      accountNumber: true,
      isDeleted: true,
      mergedInto: { select: { id: true, name: true, isDeleted: true } },
    },
  });
  const byAccount = new Map(found.map((c) => [c.accountNumber, c]));
  const ids = new Map<PlannedEnrollment, string>();
  const missing: string[] = [];
  const takenBy = new Map<string, PlannedEnrollment>();
  for (const p of planned) {
    const { accountNumber } = p.sheetRow;
    const record = byAccount.get(accountNumber);
    const live = !record
      ? null
      : !record.isDeleted
        ? record
        : record.mergedInto && !record.mergedInto.isDeleted
          ? record.mergedInto
          : null;
    if (!live) {
      missing.push(
        `  row ${p.sheetRow.row} ${accountNumber} ${p.sheetRow.name}${record ? ' (retired)' : ''}`,
      );
      continue;
    }
    if (record?.isDeleted) {
      console.log(
        `  row ${p.sheetRow.row} ${accountNumber} was merged into "${live.name}" — importing onto that record`,
      );
    } else if (live.name !== p.sheetRow.name) {
      console.log(
        `  row ${p.sheetRow.row} ${accountNumber}: stored as "${live.name}", sheet says "${p.sheetRow.name}" — same account, linked`,
      );
    }
    const other = takenBy.get(live.id);
    if (other) {
      throw new Error(
        `Rows ${other.sheetRow.row} and ${p.sheetRow.row} both belong to "${live.name}" — resolve by hand.`,
      );
    }
    takenBy.set(live.id, p);
    ids.set(p, live.id);
  }
  if (missing.length > 0) {
    throw new Error(
      `No contributor for ${missing.length} rows — run seed:contributors first:\n${missing.join('\n')}`,
    );
  }
  return ids;
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
  const [grid, fundRows, dormantAccounts] = await Promise.all([
    readGrid(values.file),
    readPeople(values.file, FUND_SHEET),
    readDormantAccounts(values.file),
  ]);
  const planned = fundRows.map((row) =>
    planEnrollment(grid, row, dormantAccounts.has(row.accountNumber)),
  );

  const dormant = planned.filter((p) => p.dormant);
  const cells = planned.flatMap((p) => p.cells);
  const stars = cells.filter((c) => c.amount === null).length;
  console.log(
    `Years on the sheet: ${grid.years.map((y) => y.year).join(', ')}`,
  );
  console.log(
    `Enrollments: ${planned.length} planned (${planned.length - dormant.length} active, ${dormant.length} dormant — listed on ${DORMANT_SHEET})`,
  );
  for (const p of dormant) {
    console.log(
      `  dormant: row ${p.sheetRow.row} ${p.sheetRow.accountNumber} ${p.sheetRow.name}`,
    );
  }
  for (const p of planned.filter((p) => p.rejoined)) {
    console.log(
      `  active though on ${DORMANT_SHEET}: row ${p.sheetRow.row} ${p.sheetRow.accountNumber} ${p.sheetRow.name} — has a rate and ${p.cells.length} cells here, so rejoined`,
    );
  }
  for (const p of planned.filter((p) => !p.dormant && p.rate === '0.00')) {
    console.log(
      `  no yearly rate: row ${p.sheetRow.row} ${p.sheetRow.accountNumber} ${p.sheetRow.name} — enrolled with 0, set it in the app`,
    );
  }
  console.log(
    `Payment cells: ${cells.length} planned (${cells.length - stars} paid, ${stars} ★)`,
  );
  console.log(`Checking against the sheet's ${TOTAL_ROW_NAME} row:`);
  const totalsOk = checkAgainstTotals(grid, planned);

  const { prisma, description } = openDatabase(
    process.env.DATABASE_URL,
    process.env.DATABASE_SCHEMA,
  );
  console.log(`${apply ? 'APPLYING to' : 'Dry run against'} ${description}`);
  try {
    const fund = await findFund(prisma);
    console.log(
      `Program: ${fund.name}, current cycle ${fund.cycle.startYear}–${fund.cycle.endYear}`,
    );
    // The app refuses writes outside the current cycle; so does this.
    const outside = [...new Set(cells.map((c) => c.year))].filter(
      (year) => year < fund.cycle.startYear || year > fund.cycle.endYear,
    );
    if (outside.length > 0) {
      throw new Error(
        `Cells in ${outside.join(', ')} fall outside the current cycle — fix the cycle first.`,
      );
    }

    const ids = await resolveContributors(prisma, planned);
    const enrollments: Prisma.ProgramEnrollmentCreateManyInput[] = planned.map(
      (p) => ({
        contributorId: ids.get(p)!,
        programId: fund.id,
        expectedRate: p.rate,
        previousSubscription: p.previous,
        status: p.dormant ? 'DORMANT' : 'ACTIVE',
      }),
    );
    const payments: Prisma.PaymentCreateManyInput[] = planned.flatMap((p) =>
      p.cells.map((cell) => ({
        programId: fund.id,
        contributorId: ids.get(p)!,
        year: cell.year,
        month: cell.month,
        amount: cell.amount,
        isStarred: cell.amount === null,
      })),
    );

    const [enrolledAlready, cellsAlready] = await Promise.all([
      prisma.programEnrollment.count({
        where: {
          programId: fund.id,
          contributorId: { in: [...ids.values()] },
        },
      }),
      prisma.payment.count({
        where: {
          programId: fund.id,
          contributorId: { in: [...ids.values()] },
        },
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
    // Enrollments first: every cell's composite FK points at one.
    const written = await prisma.$transaction(
      async (tx) => {
        const enrolled = await tx.programEnrollment.createMany({
          data: enrollments,
          skipDuplicates: true,
        });
        let cellCount = 0;
        for (let i = 0; i < payments.length; i += BATCH) {
          const { count } = await tx.payment.createMany({
            data: payments.slice(i, i + BATCH),
            skipDuplicates: true,
          });
          cellCount += count;
        }
        return { enrolled: enrolled.count, cells: cellCount };
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_TIMEOUT_MS },
    );
    console.log(
      `  inserted ${written.enrolled} enrollments and ${written.cells} cells; ${enrollments.length - written.enrolled} and ${payments.length - written.cells} were already there`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
