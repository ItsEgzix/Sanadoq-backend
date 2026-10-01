import type { Prisma } from 'generated/prisma/client';
import { PERSON_SELECT } from 'src/people/person.constant';

export const ENROLLMENT_SELECT = {
  id: true,
  personId: true,
  programId: true,
  expectedRate: true,
  previousSubscription: true,
  status: true,
  person: { select: PERSON_SELECT },
} satisfies Prisma.ProgramEnrollmentSelect;

export type EnrollmentRow = Prisma.ProgramEnrollmentGetPayload<{
  select: typeof ENROLLMENT_SELECT;
}>;

// The workbook's row order: by the person's account number. `id` last so
// ties can never reorder between pages.
export const ENROLLMENT_ORDER_BY = [
  { person: { accountNumber: 'asc' } },
  { id: 'asc' },
] satisfies Prisma.ProgramEnrollmentOrderByWithRelationInput[];
