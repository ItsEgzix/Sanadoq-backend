import { toMoneyString } from 'src/common/utils/money.util';
import type { PersonDetailRow } from './person.constant';

/** A person with their enrollments, money as fixed-scale strings. */
export function toPersonDetailView({
  enrollments,
  ...person
}: PersonDetailRow) {
  return {
    ...person,
    enrollments: enrollments.map(({ program, ...enrollment }) => ({
      ...enrollment,
      programName: program.name,
      programIsProtected: program.isProtected,
      expectedRate: toMoneyString(enrollment.expectedRate),
      previousSubscription: toMoneyString(enrollment.previousSubscription),
    })),
  };
}

export type PersonDetailView = ReturnType<typeof toPersonDetailView>;
