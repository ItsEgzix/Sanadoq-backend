import type { Prisma } from 'generated/prisma/client';
import { sumMoney, toMoneyString } from 'src/common/utils/money.util';
import { programEntryMode, type EntryMode } from 'src/programs/program.util';
import type { ContributorDetailRow } from './contributor.constant';

/** A contributor with their enrollments, money as fixed-scale strings. */
export function toContributorDetailView({
  enrollments,
  ...contributor
}: ContributorDetailRow) {
  return {
    ...contributor,
    enrollments: enrollments.map(
      ({ program: { name, isProtected, ...shape }, ...enrollment }) => ({
        ...enrollment,
        programName: name,
        programIsProtected: isProtected,
        // TEMPORARY: a donor row — what they gave, never a pledge.
        programType: shape.type,
        entryMode: programEntryMode(shape),
        expectedRate: toMoneyString(enrollment.expectedRate),
        previousSubscription: toMoneyString(enrollment.previousSubscription),
      }),
    ),
  };
}

export type ContributorDetailView = ReturnType<typeof toContributorDetailView>;

/** One group of a contributor's payments to one program in one year. */
export interface YearPaymentGroup {
  month: number | null;
  isStarred: boolean;
  amount: Prisma.Decimal | null;
  count: number;
}

export type MonthMark = 'PAID' | 'STARRED' | null;

/**
 * One enrollment's year at a glance, for the directory: what was paid, how
 * many payments made it up, and — on a monthly grid — which months hold a
 * payment or a ★. A ★ adds nothing to `paid` or `payments`: its amount is
 * NULL by constraint, and it marks money recorded under another month.
 * A dated ledger has no month cells, so `months` is null there.
 */
export function toYearActivity(
  groups: readonly YearPaymentGroup[],
  entryMode: EntryMode,
) {
  const months: MonthMark[] | null =
    entryMode === 'MONTHLY' ? Array<MonthMark>(12).fill(null) : null;
  let payments = 0;
  for (const group of groups) {
    if (!group.isStarred) payments += group.count;
    if (months && group.month !== null) {
      months[group.month - 1] = group.isStarred ? 'STARRED' : 'PAID';
    }
  }
  return {
    paid: toMoneyString(sumMoney(groups.map((group) => group.amount))),
    payments,
    months,
  };
}

export type YearActivityView = ReturnType<typeof toYearActivity>;
