import type { Prisma } from 'generated/prisma/client';
import { CONTRIBUTOR_SELECT } from 'src/contributors/contributor.constant';

export const ENROLLMENT_SELECT = {
  id: true,
  contributorId: true,
  programId: true,
  expectedRate: true,
  previousSubscription: true,
  status: true,
  contributor: { select: CONTRIBUTOR_SELECT },
} satisfies Prisma.ProgramEnrollmentSelect;

export type EnrollmentRow = Prisma.ProgramEnrollmentGetPayload<{
  select: typeof ENROLLMENT_SELECT;
}>;

// The workbook's row order: by the contributor's account number. `id` last so
// ties can never reorder between pages.
export const ENROLLMENT_ORDER_BY = [
  { contributor: { accountNumber: 'asc' } },
  { id: 'asc' },
] satisfies Prisma.ProgramEnrollmentOrderByWithRelationInput[];
