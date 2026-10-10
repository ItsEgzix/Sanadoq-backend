import type { Prisma } from '../../generated/prisma/client';
import { CONTRIBUTOR_SELECT } from '../contributors/contributor.constant';

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

// ── Terms ────────────────────────────────────────────────────────────────

export const TERM_SELECT = {
  id: true,
  enrollmentId: true,
  fromYear: true,
  fromMonth: true,
  status: true,
  expectedRate: true,
} satisfies Prisma.EnrollmentTermSelect;

export type TermFieldsRow = Prisma.EnrollmentTermGetPayload<{
  select: typeof TERM_SELECT;
}>;

// Date order — what every rule in enrollment-term.util.ts reads them in.
// `id` last only so the order is total.
export const TERM_ORDER_BY = [
  { fromYear: 'asc' },
  { fromMonth: 'asc' },
  { id: 'asc' },
] satisfies Prisma.EnrollmentTermOrderByWithRelationInput[];

// A subscription changes a few times a year at most; this is centuries of
// one enrollment's history, so its list is a plain array.
export const TERM_HISTORY_CAP = 500;

// The program-wide reads (arrears, a year's expected total) hold every term
// of a program's subscribers. A few hundred subscribers with a handful of
// changes each is far below this; reaching it is logged as an error.
export const TERM_SCAN_CAP = 20_000;
