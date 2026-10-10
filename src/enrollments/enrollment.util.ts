import { HttpStatus } from '@nestjs/common';
import { AppException } from '../common/exceptions/app.exception';
import { toMoneyString } from '../common/utils/money.util';
import type { ProgramRow } from '../programs/program.constant';
import type { EnrollmentRow, TermFieldsRow } from './enrollment.constant';

/** An enrollment as the API returns it: money as fixed-scale strings. */
export function toEnrollmentView(enrollment: EnrollmentRow) {
  return {
    ...enrollment,
    expectedRate: toMoneyString(enrollment.expectedRate),
    previousSubscription: toMoneyString(enrollment.previousSubscription),
  };
}

export type EnrollmentView = ReturnType<typeof toEnrollmentView>;

/** A term as the API returns it. */
export function toTermView(term: TermFieldsRow) {
  return { ...term, expectedRate: toMoneyString(term.expectedRate) };
}

/**
 * Only a PERIODIC program is subscribed to. A TEMPORARY one's rows belong to
 * the payment path, which adds and removes them with the gifts; enrolling, a
 * pledge, dormancy or a term there would turn a donor into a subscriber the
 * program does not have.
 */
export function assertTakesEnrollments(program: ProgramRow): void {
  if (program.type === 'PERIODIC') return;
  throw new AppException(
    'ENROLLMENT_PROGRAM_TEMPORARY',
    { programName: program.name },
    HttpStatus.CONFLICT,
  );
}
