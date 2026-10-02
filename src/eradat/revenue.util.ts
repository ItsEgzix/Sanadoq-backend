import type { Prisma } from '../../generated/prisma/client';
import {
  roundMoney,
  sumMoney,
  toMoneyString,
  ZERO,
} from '../common/utils/money.util';
import type { PaymentCellRow } from '../payments/payment.constant';
import { toPaymentCellView } from '../payments/payment.util';

/**
 * The books' arithmetic, as pure functions, always for one program at a
 * time. Each formula lives here once; the services only fetch rows and feed
 * them in. Where they sum in SQL instead (program-wide totals), they rely on
 * the same rule these functions apply — a star's amount is NULL — so both
 * paths agree.
 */

/**
 * yearly_total(enrollment, year) = SUM of that enrollment's payments in the
 * year. Stars contribute 0.
 *
 * The star filter repeats CHECK "Payment_amount_matches_star" on purpose: if
 * that constraint were ever dropped, a star carrying a stray amount must
 * still never be counted.
 */
export function yearlyTotal(
  cells: readonly PaymentCellRow[],
  year: number,
): Prisma.Decimal {
  return sumMoney(
    cells
      .filter((cell) => cell.year === year && !cell.isStarred)
      .map((cell) => cell.amount),
  );
}

/**
 * running_total(enrollment) — الإجمالي — = previous_subscription +
 * SUM(yearly_total) over the program's running years: every cycle from its
 * first through the current one, or every year with payments for a program
 * without cycles (see ReadWindow.runningYears). previous_subscription is the
 * treasurer's typed figure for what was paid before this system held the
 * books — never recomputed, and never re-typed when a new cycle starts.
 */
export function runningTotal(
  previousSubscription: Prisma.Decimal,
  yearlyTotals: readonly Prisma.Decimal[],
): Prisma.Decimal {
  return previousSubscription.plus(sumMoney(yearlyTotals));
}

/**
 * collection_ratio(program, year) = SUM(expected_rate over the program's
 * enrollments) ÷ SUM(that year's payments by those enrolled contributors).
 *
 * Per program, never across programs — mirroring the workbook, which kept
 * its project rows out of the fund's ratio. And only pledge-backed money on
 * the actual side: a transfer from another program or a stranger's one-off
 * gift answers no enrollment's pledge, so counting it would make a program
 * look better collected than its pledges are. Both still count as the
 * program's revenue.
 *
 * The direction (expected over actual, so above 1 means under-collected)
 * follows the spec as written for the workbook. null when nothing pledged
 * was collected, rather than an infinity the UI would have to special-case.
 */
export function collectionRatio(
  expectedTotal: Prisma.Decimal,
  pledgedActualTotal: Prisma.Decimal,
): Prisma.Decimal | null {
  if (pledgedActualTotal.isZero()) return null;
  return expectedTotal.dividedBy(pledgedActualTotal);
}

/**
 * months_due(year, now) = how many of the year's months have ended by `now`:
 * 12 for a past year, 0 for a future one, and for the current year the
 * months before this one. A month is owed once it is over, not on its first
 * day — the fund's rule (2026-10-02), so on 2 October a member is measured
 * through September.
 *
 * UTC, like CycleService's default year: the fund keeps no time zone, and the
 * difference is a few hours at the turn of a month.
 */
export function monthsDue(year: number, now: Date): number {
  const thisYear = now.getUTCFullYear();
  if (year < thisYear) return 12;
  if (year > thisYear) return 0;
  return now.getUTCMonth(); // 0-based, so this counts the months already over
}

/**
 * arrears(enrollment, year) — العجز — = the yearly pledge's share for the
 * months due, less what the enrollment paid in that year; never below zero.
 *
 * The fund's rule (2026-10-02): one year at a time, so each January starts
 * from zero and an unpaid 2026 is not carried into 2027. Measured in money,
 * not in empty cells: a ★ month adds nothing here because its money sits in
 * the month it was booked under, and a quarterly or annual lump covers the
 * months it was meant for. Paying ahead of the months due is not a negative
 * arrears — it is simply none.
 */
export function arrears(
  expectedRate: Prisma.Decimal,
  dueMonths: number,
  paidInYear: Prisma.Decimal,
): Prisma.Decimal {
  const owed = roundMoney(expectedRate.times(dueMonths).dividedBy(12));
  const short = owed.minus(paidInYear);
  return short.greaterThan(0) ? short : ZERO;
}

/** The twelve cells of one year, January first; null where nothing was entered. */
export function monthRow<T extends { year: number; month: number | null }>(
  cells: readonly T[],
  year: number,
): Array<T | null> {
  const row: Array<T | null> = Array.from({ length: 12 }, () => null);
  for (const cell of cells) {
    if (cell.year === year && cell.month !== null) row[cell.month - 1] = cell;
  }
  return row;
}

/**
 * One line of a monthly grid for `year`: its twelve cells, that year's
 * total, every window year's total and the running total.
 *
 * openingTotal is what the running total starts from before the current
 * cycle's cells: an enrollment's previous subscription plus what it paid in
 * the program's earlier cycles. Transfer lines (another program paying in)
 * start from their earlier cycles only — a program's own opening balance is
 * not split across its payers.
 */
export function buildGridLine(
  cells: readonly PaymentCellRow[],
  windowYears: readonly number[],
  year: number,
  openingTotal: Prisma.Decimal,
) {
  const totals = new Map(
    windowYears.map((windowYear) => [
      windowYear,
      yearlyTotal(cells, windowYear),
    ]),
  );
  return {
    months: monthRow(cells, year).map(
      (cell) => cell && toPaymentCellView(cell),
    ),
    ...summariseYears(totals, windowYears, year, openingTotal),
  };
}

/**
 * One enrollment's line in a dated ledger: the same totals as a grid line,
 * from per-year sums already computed in SQL, and no month cells.
 */
export function buildLedgerLine(
  yearSums: ReadonlyMap<number, Prisma.Decimal> | undefined,
  windowYears: readonly number[],
  year: number,
  previousSubscription: Prisma.Decimal,
) {
  return {
    months: null,
    ...summariseYears(
      yearSums ?? new Map(),
      windowYears,
      year,
      previousSubscription,
    ),
  };
}

function summariseYears(
  totals: ReadonlyMap<number, Prisma.Decimal>,
  windowYears: readonly number[],
  year: number,
  openingTotal: Prisma.Decimal,
) {
  const yearTotals = windowYears.map((windowYear) => ({
    year: windowYear,
    total: totals.get(windowYear) ?? ZERO,
  }));
  return {
    yearTotal: toMoneyString(totals.get(year)),
    yearTotals: yearTotals.map((entry) => ({
      year: entry.year,
      total: toMoneyString(entry.total),
    })),
    runningTotal: toMoneyString(
      runningTotal(
        openingTotal,
        yearTotals.map((entry) => entry.total),
      ),
    ),
  };
}
