import type { Prisma } from '../../generated/prisma/client';
import { sumMoney, toMoneyString, ZERO } from '../common/utils/money.util';
import type { PaymentCellRow } from '../payments/payment.constant';
import { toPaymentCellView } from '../payments/payment.util';

/**
 * The books' arithmetic, as pure functions, always for one program at a
 * time. Each formula lives here once — or, for what a subscription owes, in
 * src/enrollments/enrollment-term.util.ts — and the services only fetch rows
 * and feed them in. Where they sum in SQL instead (program-wide totals), they
 * rely on the same rule these functions apply — a star's amount is NULL — so
 * both paths agree.
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
 * running_total — الإجمالي, "the account since joining" — =
 * previous_subscription + every payment the books hold, in any year: the
 * workbook's BH column, previous plus every year on the sheet. So it is the
 * same whichever year is on screen, and money paid ahead into next year's
 * cells is already in it. previous_subscription is the treasurer's typed
 * figure for what was paid before this system held the books — never
 * recomputed.
 */
export function runningTotal(
  previousSubscription: Prisma.Decimal,
  yearlyTotals: readonly Prisma.Decimal[],
): Prisma.Decimal {
  return previousSubscription.plus(sumMoney(yearlyTotals));
}

/**
 * collection_ratio(program, year) — نسبة التحصيل — = that year's payments by
 * the program's subscribers ÷ what their pledges expected for the year
 * (each subscription's months as a member, at its pledge — see owedFor).
 * 0.70 means 70% collected. It is the workbook's own figure (الحساب: اجمالي
 * التحصيل ÷ اجمالي معدل الاشتراك), so the app and the fund's reports quote the
 * same number.
 *
 * Per program, never across programs — mirroring the workbook, which kept
 * its project rows out of the fund's ratio. And only pledge-backed money on
 * the collected side: a transfer from another program or a stranger's
 * one-off gift answers no subscriber's pledge, so counting it would make a
 * program look better collected than its pledges are. Both still count as
 * the program's revenue.
 *
 * null when nothing was pledged, rather than an infinity the UI would have to
 * special-case.
 */
export function collectionRatio(
  collected: Prisma.Decimal,
  expected: Prisma.Decimal,
): Prisma.Decimal | null {
  if (expected.isZero()) return null;
  return collected.dividedBy(expected);
}

/**
 * What the year's pledges still wait for — اجمالي المتبقي — never below zero:
 * a year collected beyond its pledges has nothing remaining, not a negative.
 */
export function remainingForYear(
  expected: Prisma.Decimal,
  collected: Prisma.Decimal,
): Prisma.Decimal {
  const remaining = expected.minus(collected);
  return remaining.greaterThan(0) ? remaining : ZERO;
}

/**
 * months_due(year, now) = how many of the year's months have ended by `now`:
 * 12 for a past year, 0 for a future one, and for the current year the
 * months before this one. A month is owed once it is over, not on its first
 * day — the fund's rule (2026-10-02), so on 2 October a member is measured
 * through September.
 *
 * UTC, like every other "now" in the books: the fund keeps no time zone, and
 * the difference is a few hours at the turn of a month.
 */
export function monthsDue(year: number, now: Date): number {
  const thisYear = now.getUTCFullYear();
  if (year < thisYear) return 12;
  if (year > thisYear) return 0;
  return now.getUTCMonth(); // 0-based, so this counts the months already over
}

/**
 * arrears(enrollment, year) — العجز — = what the subscription owed for the
 * months due (owedFor: only the months it was active, each at its pledge),
 * less what it paid in that year; never below zero.
 *
 * The fund's rule (2026-10-02): one year at a time, so each January starts
 * from zero and an unpaid 2026 is not carried into 2027. Measured in money,
 * not in empty cells: a ★ month adds nothing here because its money sits in
 * the month it was booked under, and a quarterly or annual lump covers the
 * months it was meant for. Paying ahead of the months due is not a negative
 * arrears — it is simply none.
 */
export function arrears(
  owed: Prisma.Decimal,
  paidInYear: Prisma.Decimal,
): Prisma.Decimal {
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
 * One line of a monthly grid for `year`: its twelve cells, that year's total
 * and the running total.
 *
 * openingTotal is everything the running total holds besides this year's
 * cells: an enrollment's previous subscription plus what it paid in every
 * other year. Transfer lines (another program paying in) open on their other
 * years only — a program's own opening balance is not split across its
 * payers.
 */
export function buildGridLine(
  cells: readonly PaymentCellRow[],
  year: number,
  openingTotal: Prisma.Decimal,
) {
  const yearTotal = yearlyTotal(cells, year);
  return {
    months: monthRow(cells, year).map(
      (cell) => cell && toPaymentCellView(cell),
    ),
    yearTotal: toMoneyString(yearTotal),
    runningTotal: toMoneyString(runningTotal(openingTotal, [yearTotal])),
  };
}

/**
 * One donor's line in a dated ledger: the same totals as a grid line, from
 * per-year sums already computed in SQL, and no month cells.
 */
export function buildLedgerLine(
  yearSums: ReadonlyMap<number, Prisma.Decimal> | undefined,
  year: number,
  previousSubscription: Prisma.Decimal,
) {
  const sums = yearSums ?? new Map<number, Prisma.Decimal>();
  return {
    months: null,
    yearTotal: toMoneyString(sums.get(year)),
    runningTotal: toMoneyString(
      runningTotal(previousSubscription, [...sums.values()]),
    ),
  };
}
