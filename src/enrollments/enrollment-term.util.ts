import type { EnrollmentStatus, Prisma } from '../../generated/prisma/client';
import { roundMoney, sumMoney } from '../common/utils/money.util';

/**
 * A periodic subscription's dated terms, as pure functions: which months a
 * subscriber owed for, and at what pledge. Each rule lives here once; the
 * arrears, the expected totals and the guards on every change all read them.
 *
 * A term says "from this month on, this status at this yearly pledge" and
 * holds until the next term starts. Before the first term the subscriber had
 * not joined and owed nothing. See EnrollmentTerm in prisma/schema.prisma.
 */

export interface TermRow {
  fromYear: number;
  fromMonth: number;
  status: EnrollmentStatus;
  expectedRate: Prisma.Decimal;
}

export interface MonthRef {
  year: number;
  month: number;
}

/** A month as one number — year × 12 + (month − 1) — so "earlier" is `<`. */
export function monthIndex({ year, month }: MonthRef): number {
  return year * 12 + month - 1;
}

export function fromMonthIndex(index: number): MonthRef {
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function termStart(term: TermRow): MonthRef {
  return { year: term.fromYear, month: term.fromMonth };
}

// Where an enrollment with no terms started: always, at what it holds now.
// The migration backfilled every enrollment that existed, and every path in
// the API and the imports writes a joining term, so this is a safety net for
// rows a dev script made — they keep reading as they did before terms
// existed instead of as never having joined.
const FALLBACK_START: MonthRef = { year: 2000, month: 1 };

/** The one term an enrollment without terms is read as. */
export function fallbackTerm(enrollment: {
  status: EnrollmentStatus;
  expectedRate: Prisma.Decimal;
}): TermRow {
  return {
    fromYear: FALLBACK_START.year,
    fromMonth: FALLBACK_START.month,
    status: enrollment.status,
    expectedRate: enrollment.expectedRate,
  };
}

/** An enrollment's terms, or the one it is read as when it has none. */
export function termsOrFallback(
  enrollment: { status: EnrollmentStatus; expectedRate: Prisma.Decimal },
  terms: readonly TermRow[] | undefined,
): readonly TermRow[] {
  return terms && terms.length > 0 ? terms : [fallbackTerm(enrollment)];
}

/** "2026-03" — how a month is named in messages, the same in every language. */
export function formatMonth({ year, month }: MonthRef): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * The month a change made now may start in at the latest: this one. UTC, like
 * every other "now" in the books — the fund keeps no time zone.
 */
export function currentMonth(now = new Date()): MonthRef {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

/**
 * When a contributor joined, read from their account number (رقم الحساب,
 * YYMMNNN): the only record of a start month the workbook keeps. A month
 * outside 1..12 falls back to January, and a date after this month is pulled
 * back to it, since no term may start later. The same rule as the backfill in
 * migration 20261010110000_enrollment_terms, so an imported subscriber and a
 * migrated one start alike.
 */
export function joinedFromAccountNumber(
  accountNumber: string,
  now = new Date(),
): MonthRef {
  const year = 2000 + Number(accountNumber.slice(0, 2));
  const month = Number(accountNumber.slice(2, 4));
  const joined = {
    year: Number.isInteger(year) ? year : 2000,
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : 1,
  };
  return fromMonthIndex(
    Math.min(monthIndex(joined), monthIndex(currentMonth(now))),
  );
}

/**
 * The term in effect in each month of `year`, January first; null for the
 * months before the subscriber joined. `terms` must be in date order, as
 * every read loads them.
 */
export function termsByMonth(
  terms: readonly TermRow[],
  year: number,
): Array<TermRow | null> {
  const months: Array<TermRow | null> = [];
  let index = 0;
  let current: TermRow | null = null;
  for (let month = 1; month <= 12; month++) {
    const at = monthIndex({ year, month });
    while (index < terms.length && monthIndex(termStart(terms[index])) <= at) {
      current = terms[index];
      index++;
    }
    months.push(current);
  }
  return months;
}

/**
 * owed(terms, year, months) = Σ, over the first `months` months of `year`
 * that a term says were ACTIVE, of that term's yearly pledge ÷ 12 — rounded
 * once, at the end, to the money scale every stored amount has.
 *
 * So a 12,000 pledge owes 9,000 through September; joining in June owes from
 * June; a dormancy from May stops the count from May; and a pledge raised in
 * July counts at the new rate from July. With `months` = 12 it is the year's
 * expected total.
 */
export function owedFor(
  terms: readonly TermRow[],
  year: number,
  months: number,
): Prisma.Decimal {
  const active = termsByMonth(terms, year)
    .slice(0, Math.max(0, Math.min(12, months)))
    .filter((term): term is TermRow => term?.status === 'ACTIVE')
    .map((term) => term.expectedRate);
  return roundMoney(sumMoney(active).dividedBy(12));
}

/**
 * Where a new change starting at `from` goes in a history whose latest term
 * is `latest`:
 *   APPEND  — after it, the usual case;
 *   REPLACE — in the same month, so it takes that term's place: a second
 *             change in one month is a correction of the first, not a
 *             one-month-long term;
 *   BEFORE  — earlier than the latest term, refused: terms are appended in
 *             date order, which is what keeps the latest one in effect today;
 *   FUTURE  — after the current month, refused for the same reason. A change
 *             for next January is made in January.
 */
export function placeChange(
  latest: TermRow | null,
  from: MonthRef,
  now = new Date(),
): 'APPEND' | 'REPLACE' | 'BEFORE' | 'FUTURE' {
  const at = monthIndex(from);
  if (at > monthIndex(currentMonth(now))) return 'FUTURE';
  if (!latest) return 'APPEND';
  const last = monthIndex(termStart(latest));
  if (at < last) return 'BEFORE';
  return at === last ? 'REPLACE' : 'APPEND';
}

/** Whether two terms say the same thing, so the later one adds nothing. */
export function sameTerms(a: TermRow, b: TermRow): boolean {
  return a.status === b.status && a.expectedRate.equals(b.expectedRate);
}
