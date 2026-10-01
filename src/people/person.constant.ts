import type { Prisma } from 'generated/prisma/client';
import { PROGRAM_CAP } from 'src/programs/program.constant';

// The workbook's YYMMNNN account number. Mirrors CHECK
// "Person_account_number_digits"; the DTO rejects early with a readable
// message, the CHECK is the backstop.
export const PERSON_ACCOUNT_NUMBER_PATTERN = /^\d{7}$/;

// The duplicate scan holds every live person's id, name and account number
// in memory at once. A fund has hundreds; this is a sanity bound, not a quota.
export const PERSON_SCAN_CAP = 20_000;

// Response allowlist. isDeleted/deletedAt stay server-side.
export const PERSON_SELECT = {
  id: true,
  name: true,
  accountNumber: true,
  phone: true,
  email: true,
} satisfies Prisma.PersonSelect;

export type PersonRow = Prisma.PersonGetPayload<{
  select: typeof PERSON_SELECT;
}>;

// A person and every live program they are enrolled in. Bounded by
// PROGRAM_CAP: a person has at most one enrollment per program.
export const PERSON_DETAIL_SELECT = {
  ...PERSON_SELECT,
  enrollments: {
    // Relation filters are not rewritten by the soft-delete extension, so a
    // deleted program's enrollment is excluded here by name.
    where: { program: { isDeleted: false } },
    orderBy: [
      { program: { isProtected: 'desc' } },
      { program: { sortOrder: 'asc' } },
      { id: 'asc' },
    ],
    take: PROGRAM_CAP,
    select: {
      id: true,
      programId: true,
      status: true,
      expectedRate: true,
      previousSubscription: true,
      program: { select: { name: true, isProtected: true } },
    },
  },
} satisfies Prisma.PersonSelect;

export type PersonDetailRow = Prisma.PersonGetPayload<{
  select: typeof PERSON_DETAIL_SELECT;
}>;

// By account number — the workbook's row order — then id so ties never
// reorder between pages.
export const PERSON_ORDER_BY = [
  { accountNumber: 'asc' },
  { id: 'asc' },
] satisfies Prisma.PersonOrderByWithRelationInput[];
