import type { Prisma } from '../../generated/prisma/client';
import { sumMoney, toMoneyString, ZERO } from '../common/utils/money.util';
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
 * running_total(enrollment) = previous_subscription + SUM(yearly_total) over
 * the program's window — the years of its current cycle, or every year with
 * payments for a program without cycles. previous_subscription is the
 * treasurer's typed figure for everything before that window — never
 * recomputed here.
 */
export function runningTotal(
  previousSubscription: Prisma.Decimal,
  windowYearlyTotals: readonly Prisma.Decimal[],
): Prisma.Decimal {
  return previousSubscription.plus(sumMoney(windowYearlyTotals));
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
 * total, every window year's total and the running total. Transfer lines
 * (another program paying in) pass zero for previousSubscription — a
 * program's own opening balance is not split across its payers.
 */
export function buildGridLine(
  cells: readonly PaymentCellRow[],
  windowYears: readonly number[],
  year: number,
  previousSubscription: Prisma.Decimal,
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
    ...summariseYears(totals, windowYears, year, previousSubscription),
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
  previousSubscription: Prisma.Decimal,
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
        previousSubscription,
        yearTotals.map((entry) => entry.total),
      ),
    ),
  };
}
