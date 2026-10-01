import { toMoneyString } from 'src/common/utils/money.util';
import type { EnrollmentRow } from './enrollment.constant';

/** An enrollment as the API returns it: money as fixed-scale strings. */
export function toEnrollmentView(enrollment: EnrollmentRow) {
  return {
    ...enrollment,
    expectedRate: toMoneyString(enrollment.expectedRate),
    previousSubscription: toMoneyString(enrollment.previousSubscription),
  };
}

export type EnrollmentView = ReturnType<typeof toEnrollmentView>;
