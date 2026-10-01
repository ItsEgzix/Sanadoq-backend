import { toMoneyString } from 'src/common/utils/money.util';
import type { ContributorDetailRow } from './contributor.constant';

/** A contributor with their enrollments, money as fixed-scale strings. */
export function toContributorDetailView({
  enrollments,
  ...contributor
}: ContributorDetailRow) {
  return {
    ...contributor,
    enrollments: enrollments.map(({ program, ...enrollment }) => ({
      ...enrollment,
      programName: program.name,
      programIsProtected: program.isProtected,
      expectedRate: toMoneyString(enrollment.expectedRate),
      previousSubscription: toMoneyString(enrollment.previousSubscription),
    })),
  };
}

export type ContributorDetailView = ReturnType<typeof toContributorDetailView>;
