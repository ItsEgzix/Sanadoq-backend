/**
 * Importing a program's monthly grid from the workbook — the fund's own
 * revenue sheet (الايرادات) and مواساة's (ايرادات مواساة) — shared by
 * seed:fund-eradat, seed:mwa-eradat and verify:workbook. One enrollment per
 * person, carrying the previous subscription (الاشتراك السابق) and, where the
 * sheet has one, the yearly pledge; every month cell of the sheet's years — a
 * number as a payment, * as ★.
 *
 * The two sheets share their shape and differ in three places, each named in
 * a SheetLayout: which row holds the years, whether there is a pledge column,
 * and where the month columns start. Every column is checked against its
 * header before a figure is read, so a reshaped sheet stops the run instead
 * of filing money in the wrong month.
 *
 * Someone on the frozen-accounts sheet (الحسابات الخاملة) whose row is empty —
 * no pledge, no previous subscription, no cell — is enrolled DORMANT from the
 * month after they were frozen. Their frozen balance stays on that sheet:
 * where it goes when someone rejoins is a question still open with the fund.
 * A frozen-listed person whose row carries figures has rejoined, and the
 * revenue sheet is the newer word: ACTIVE.
 */
import { readSheet } from 'read-excel-file/node';
import type {
  Prisma,
  PrismaClient,
  ProgramType,
} from '../../generated/prisma/client';
import { CONTRIBUTOR_ACCOUNT_NUMBER_PATTERN } from '../contributors/contributor.constant';
import {
  joinedFromAccountNumber,
  type MonthRef,
} from '../enrollments/enrollment-term.util';
import { writeMissingTerms } from './script.util';
import { accountText, cellText, type SheetRow } from './workbook.util';

export const DORMANT_SHEET = 'الحسابات الخاملة';

// The program مواساة's sheets are imported into — its revenue by
// seed:mwa-eradat, its expenses by seed:mwa-expenses.
export const MWA_PROGRAM_NAME = 'مواساة';

const ACCOUNT_COLUMN = 2; // C, on every revenue sheet
const NAME_COLUMN = 1; // B
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
export const TRANSACTION_TIMEOUT_MS = 120_000;

/** Where one revenue sheet keeps what an import reads. Zero-based columns. */
export interface SheetLayout {
  sheet: string;
  // The row of years over each January, counted from the header row (the
  // one with رقم الحساب): the row above on الايرادات, the header row itself
  // on ايرادات مواساة.
  yearRowOffset: number;
  // The row of month names, counted from the header row: the header row on
  // الايرادات, the row below on ايرادات مواساة.
  monthRowOffset: number;
  previousColumn: number;
  // null: the sheet keeps no pledge, so every enrollment imports with 0.
  rateColumn: number | null;
  firstMonthColumn: number;
  // Where this program's people are on الحسابات الخاملة: the fund's half
  // keeps account numbers in E and the freezing date in D, مواساة's in N and M.
  frozenAccountColumn: number;
  frozenDateColumn: number;
}

export const FUND_LAYOUT: SheetLayout = {
  sheet: 'الايرادات',
  yearRowOffset: -1,
  monthRowOffset: 0,
  previousColumn: 3, // D
  rateColumn: 4, // E
  firstMonthColumn: 5, // F, January of the first year
  frozenAccountColumn: 4, // E
  frozenDateColumn: 3, // D
};

export const MWA_LAYOUT: SheetLayout = {
  sheet: 'ايرادات مواساة',
  yearRowOffset: 0,
  monthRowOffset: 1,
  previousColumn: 3, // D
  rateColumn: null,
  firstMonthColumn: 4, // E, January of the first year
  frozenAccountColumn: 13, // N
  frozenDateColumn: 12, // M
};

export interface Grid {
  layout: SheetLayout;
  data: unknown[][];
  // Zero-based index of the header row.
  header: number;
  // Each year of the sheet and the column of its January.
  years: Array<{ year: number; column: number }>;
  // The sheet's own row number of the الإجمالي row, if it has one.
  totalRow: number | null;
}

export interface PlannedCell {
  year: number;
  month: number;
  // null: ★, paid but booked under another month.
  amount: string | null;
}

export interface PlannedEnrollment {
  sheetRow: SheetRow;
  previous: string;
  rate: string;
  dormant: boolean;
  // On the frozen list, yet paying again on this sheet.
  rejoined: boolean;
  // The month this subscription started — the YYMM of this sheet's own
  // account number, the join date for this program — and, when dormant,
  // the first month it was frozen.
  joined: MonthRef;
  dormantFrom: MonthRef | null;
  cells: PlannedCell[];
}

export const sheetLabel = (value: unknown) =>
  cellText(value).replace(TATWEEL, '');

const where = (sheet: string, row: number, column: number) =>
  `${sheet} row ${row} column ${columnName(column)}`;

function columnName(column: number): string {
  let name = '';
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

// A blank figure is zero: the sheets leave pledge and previous empty for the
// frozen accounts. Anything but a non-negative number of whole fils stops the
// run, since a guessed amount would sit in the books unnoticed.
export function moneyCell(
  sheet: string,
  value: unknown,
  row: number,
  column: number,
): string {
  if (value === null || value === undefined || value === '') return '0.00';
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `${where(sheet, row, column)}: ${JSON.stringify(value)} is not an amount.`,
    );
  }
  if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) {
    throw new Error(
      `${where(sheet, row, column)}: ${value} has more than 2 decimals.`,
    );
  }
  return value.toFixed(2);
}

export async function readGrid(
  file: string,
  layout: SheetLayout,
): Promise<Grid> {
  const { sheet } = layout;
  const data = (await readSheet(file, sheet)) as unknown[][];
  const header = data.findIndex((cells) =>
    sheetLabel(cells[ACCOUNT_COLUMN]).startsWith(ACCOUNT_HEADER),
  );
  const headers = header < 0 ? [] : data[header];
  const rateOk =
    layout.rateColumn === null ||
    sheetLabel(headers[layout.rateColumn]).startsWith(RATE_HEADER);
  if (
    header < 0 ||
    sheetLabel(headers[layout.previousColumn]) !== PREVIOUS_HEADER ||
    !rateOk
  ) {
    throw new Error(
      `${sheet}: expected "${PREVIOUS_HEADER}" in column ${columnName(layout.previousColumn)}${layout.rateColumn === null ? '' : ` and "${RATE_HEADER}…" in column ${columnName(layout.rateColumn)}`} of the header row — has the sheet been reshaped?`,
    );
  }

  const yearRow = data[header + layout.yearRowOffset] ?? [];
  const monthRow = data[header + layout.monthRowOffset] ?? [];
  const years: Grid['years'] = [];
  for (
    let column = layout.firstMonthColumn;
    typeof yearRow[column] === 'number';
    column += YEAR_BLOCK
  ) {
    if (sheetLabel(monthRow[column]) !== JANUARY) {
      throw new Error(
        `${where(sheet, header + layout.monthRowOffset + 1, column)}: expected "${JANUARY}" under ${String(yearRow[column])}.`,
      );
    }
    years.push({ year: yearRow[column] as number, column });
  }
  if (years.length === 0) {
    throw new Error(`${sheet}: no year found above the month columns.`);
  }

  // The total row's label sits in column B on الايرادات and A on مواساة's.
  const totalIndex = data.findIndex(
    (cells, index) =>
      index > header &&
      [0, NAME_COLUMN].some((c) => sheetLabel(cells[c]) === TOTAL_ROW_NAME),
  );
  return {
    layout,
    data,
    header,
    years,
    totalRow: totalIndex < 0 ? null : totalIndex + 1,
  };
}

/**
 * The people on this program's half of الحسابات الخاملة, by account number,
 * with the date each was frozen when the sheet gives one.
 */
export async function readFrozenAccounts(
  file: string,
  layout: SheetLayout,
): Promise<Map<string, Date | null>> {
  const data = (await readSheet(file, DORMANT_SHEET)) as unknown[][];
  const accounts = new Map<string, Date | null>();
  for (const cells of data) {
    const account = accountText(cells[layout.frozenAccountColumn]);
    if (!CONTRIBUTOR_ACCOUNT_NUMBER_PATTERN.test(account)) continue;
    const date = cells[layout.frozenDateColumn];
    accounts.set(account, date instanceof Date ? date : null);
  }
  return accounts;
}

// Frozen "on 31 December 2011" means dormant from January 2012; frozen "on
// 1 January 2026" means dormant from January 2026. So: the month of the day
// after. No date: January 2026, the first year these books hold, like the
// migration's backfill.
function dormantFromDate(date: Date | null): MonthRef {
  if (!date) return { year: 2026, month: 1 };
  const next = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
}

export function planEnrollment(
  grid: Grid,
  sheetRow: SheetRow,
  frozen: { date: Date | null } | null,
): PlannedEnrollment {
  const { layout } = grid;
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
      const amount = moneyCell(layout.sheet, value, sheetRow.row, at);
      // An empty cell is the zero; a stored 0 would read as "paid" and is
      // refused by CHECK "Payment_amount_matches_star".
      if (amount !== '0.00') planned.push({ year, month, amount });
    }
  }
  const previous = moneyCell(
    layout.sheet,
    cells[layout.previousColumn],
    sheetRow.row,
    layout.previousColumn,
  );
  const rate =
    layout.rateColumn === null
      ? '0.00'
      : moneyCell(
          layout.sheet,
          cells[layout.rateColumn],
          sheetRow.row,
          layout.rateColumn,
        );
  const empty = previous === '0.00' && rate === '0.00' && planned.length === 0;
  const dormant = frozen !== null && empty;
  return {
    sheetRow,
    previous,
    rate,
    dormant,
    rejoined: frozen !== null && !empty,
    joined: joinedFromAccountNumber(sheetRow.accountNumber),
    dormantFrom: dormant ? dormantFromDate(frozen.date) : null,
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
export function checkAgainstTotals(
  grid: Grid,
  planned: readonly PlannedEnrollment[],
): boolean {
  const { layout } = grid;
  if (grid.totalRow === null) {
    console.log(`  (no ${TOTAL_ROW_NAME} row found — totals not checked)`);
    return true;
  }
  const totals = grid.data[grid.totalRow - 1];
  const imported = new Set(planned.map((p) => p.sheetRow.row));
  // Rows between the header and the total that carry figures but are not
  // imported — the programs on rows 4–6 of الايرادات, say.
  const leftOut = grid.data
    .slice(grid.header + 1, grid.totalRow - 1)
    .map((cells, index) => ({ cells, row: grid.header + index + 2 }))
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
    layout.previousColumn,
    sum(planned.map((p) => Number(p.previous))),
  );
  if (layout.rateColumn !== null) {
    compare(
      RATE_HEADER,
      layout.rateColumn,
      sum(planned.map((p) => Number(p.rate))),
    );
  }
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

/** Prints what the plan holds, the way both seeds report it. */
export function describePlan(
  grid: Grid,
  planned: readonly PlannedEnrollment[],
): void {
  const { sheet } = grid.layout;
  const dormant = planned.filter((p) => p.dormant);
  const cells = planned.flatMap((p) => p.cells);
  const stars = cells.filter((c) => c.amount === null).length;
  console.log(`Years on ${sheet}: ${grid.years.map((y) => y.year).join(', ')}`);
  console.log(
    `Enrollments: ${planned.length} planned (${planned.length - dormant.length} active, ${dormant.length} dormant — listed on ${DORMANT_SHEET})`,
  );
  for (const p of dormant) {
    console.log(
      `  dormant: row ${p.sheetRow.row} ${p.sheetRow.accountNumber} ${p.sheetRow.name}, from ${p.dormantFrom?.year}-${String(p.dormantFrom?.month).padStart(2, '0')}`,
    );
  }
  for (const p of planned.filter((p) => p.rejoined)) {
    console.log(
      `  active though on ${DORMANT_SHEET}: row ${p.sheetRow.row} ${p.sheetRow.accountNumber} ${p.sheetRow.name} — has figures here, so rejoined`,
    );
  }
  if (grid.layout.rateColumn === null) {
    console.log(
      `  ${sheet} keeps no yearly pledge: every enrollment imports with 0 — set pledges in the app to track العجز`,
    );
  } else {
    for (const p of planned.filter((p) => !p.dormant && p.rate === '0.00')) {
      console.log(
        `  no yearly rate: row ${p.sheetRow.row} ${p.sheetRow.accountNumber} ${p.sheetRow.name} — enrolled with 0, set it in the app`,
      );
    }
  }
  console.log(
    `Payment cells: ${cells.length} planned (${cells.length - stars} paid, ${stars} ★)`,
  );
}

/**
 * Each planned row's Contributor id, by the account number its record keeps
 * (`accountOf` — a row's own number, or for someone folded across sheets the
 * older one seed:contributors kept). A record merged away since resolves to
 * the record a reviewer kept. A missing record, or two rows landing on one
 * record, stops the run: the import never creates people, and two rows on
 * one record would collide on every cell.
 */
export async function resolveContributors(
  prisma: PrismaClient,
  planned: readonly PlannedEnrollment[],
  accountOf: (p: PlannedEnrollment) => string,
  log: (line: string) => void = console.log,
): Promise<Map<PlannedEnrollment, string>> {
  const found = await prisma.contributor.findMany({
    where: { accountNumber: { in: planned.map(accountOf) } },
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
    const accountNumber = accountOf(p);
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
      log(
        `  row ${p.sheetRow.row} ${accountNumber} was merged into "${live.name}" — importing onto that record`,
      );
    } else if (accountNumber !== p.sheetRow.accountNumber) {
      log(
        `  row ${p.sheetRow.row} ${p.sheetRow.accountNumber} ${p.sheetRow.name}: one person with ${accountNumber} "${live.name}" — linked to that record`,
      );
    } else if (live.name !== p.sheetRow.name) {
      log(
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

/**
 * A live program by name, created when `apply` is set and none exists. A live
 * program of the other type stops the run: its books keep the other shape.
 * The raw client, so isDeleted is said out loud.
 */
export async function findOrCreateProgram(
  prisma: PrismaClient,
  name: string,
  type: ProgramType,
  apply: boolean,
): Promise<{ id: string; name: string; created: boolean } | null> {
  const found = await prisma.program.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, isDeleted: false },
    select: { id: true, name: true, type: true },
  });
  if (found) {
    if (found.type !== type) {
      throw new Error(
        `${found.name} exists as a ${found.type} program; this import needs ${type}. Fix it in the app first.`,
      );
    }
    return { id: found.id, name: found.name, created: false };
  }
  if (!apply) return null;
  const last = await prisma.program.aggregate({ _max: { sortOrder: true } });
  const created = await prisma.program.create({
    data: { name, type, sortOrder: (last._max.sortOrder ?? 0) + 1 },
    select: { id: true, name: true },
  });
  return { ...created, created: true };
}

/**
 * Writes a program's planned enrollments, their joining terms and every cell,
 * in one transaction — a failure leaves nothing half-imported. Re-runnable:
 * enrollments dedupe on (contributor, program) and cells on (program,
 * contributor, year, month), so a second run adds nothing. Rows already in the
 * database are never overwritten — a pledge corrected in the app since stays
 * corrected — and terms are written only for enrollments that have none.
 */
export async function writeBooks(
  prisma: PrismaClient,
  programId: string,
  planned: readonly PlannedEnrollment[],
  ids: ReadonlyMap<PlannedEnrollment, string>,
) {
  const idOf = (p: PlannedEnrollment) => {
    const id = ids.get(p);
    // resolveContributors throws for every row it could not resolve.
    if (!id) throw new Error(`Row ${p.sheetRow.row} has no contributor.`);
    return id;
  };
  const enrollments: Prisma.ProgramEnrollmentCreateManyInput[] = planned.map(
    (p) => ({
      contributorId: idOf(p),
      programId,
      expectedRate: p.rate,
      previousSubscription: p.previous,
      status: p.dormant ? 'DORMANT' : 'ACTIVE',
    }),
  );
  const payments: Prisma.PaymentCreateManyInput[] = planned.flatMap((p) =>
    p.cells.map((cell) => ({
      programId,
      contributorId: idOf(p),
      year: cell.year,
      month: cell.month,
      amount: cell.amount,
      isStarred: cell.amount === null,
    })),
  );
  const byContributor = new Map(planned.map((p) => [idOf(p), p]));

  return prisma.$transaction(
    async (tx) => {
      // Enrollments first: every cell's composite FK points at one.
      const enrolled = await tx.programEnrollment.createMany({
        data: enrollments,
        skipDuplicates: true,
      });
      const terms = await writeMissingTerms(tx, programId, (enrollment) => {
        const p = byContributor.get(enrollment.contributorId);
        return p && { joined: p.joined, dormantFrom: p.dormantFrom };
      });
      let cells = 0;
      for (let i = 0; i < payments.length; i += BATCH) {
        const { count } = await tx.payment.createMany({
          data: payments.slice(i, i + BATCH),
          skipDuplicates: true,
        });
        cells += count;
      }
      return {
        enrolled: enrolled.count,
        terms,
        cells,
        plannedEnrollments: enrollments.length,
        plannedCells: payments.length,
      };
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_TIMEOUT_MS },
  );
}
