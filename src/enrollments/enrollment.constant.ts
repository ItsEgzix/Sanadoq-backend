import type { Prisma } from 'generated/prisma/client';
import { CONTRIBUTOR_SELECT } from 'src/contributors/contributor.constant';

// The enrollment's own columns. Pages of enrollments load their contributors
// in a separate query (EnrollmentService.attachContributors) that can run
// beside the next read, instead of a nested select Prisma would run in
// sequence.
export const ENROLLMENT_FIELDS_SELECT = {
  id: true,
  contributorId: true,
  programId: true,
  expectedRate: true,
  previousSubscription: true,
  status: true,
} satisfies Prisma.ProgramEnrollmentSelect;

export const ENROLLMENT_SELECT = {
  ...ENROLLMENT_FIELDS_SELECT,
  contributor: { select: CONTRIBUTOR_SELECT },
} satisfies Prisma.ProgramEnrollmentSelect;

export type EnrollmentFieldsRow = Prisma.ProgramEnrollmentGetPayload<{
  select: typeof ENROLLMENT_FIELDS_SELECT;
}>;

export type EnrollmentRow = Prisma.ProgramEnrollmentGetPayload<{
  select: typeof ENROLLMENT_SELECT;
}>;

// The workbook's row order: by the contributor's account number. `id` last so
// ties can never reorder between pages.
export const ENROLLMENT_ORDER_BY = [
  { contributor: { accountNumber: 'asc' } },
  { id: 'asc' },
] satisfies Prisma.ProgramEnrollmentOrderByWithRelationInput[];
