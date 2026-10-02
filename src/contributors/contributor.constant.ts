import type { Prisma } from 'generated/prisma/client';
import { PROGRAM_CAP } from 'src/programs/program.constant';

// The workbook's YYMMNNN account number. Mirrors CHECK
// "Contributor_account_number_digits"; the DTO rejects early with a readable
// message, the CHECK is the backstop.
export const CONTRIBUTOR_ACCOUNT_NUMBER_PATTERN = /^\d{7}$/;

// The duplicate scan holds every live contributor's id, name and account number
// in memory at once. A fund has hundreds; this is a sanity bound, not a quota.
export const CONTRIBUTOR_SCAN_CAP = 20_000;

// Response allowlist. isDeleted/deletedAt stay server-side.
export const CONTRIBUTOR_SELECT = {
  id: true,
  name: true,
  accountNumber: true,
  phone: true,
  email: true,
} satisfies Prisma.ContributorSelect;

export type ContributorRow = Prisma.ContributorGetPayload<{
  select: typeof CONTRIBUTOR_SELECT;
}>;

// A contributor and every live program they are enrolled in. Bounded by
// PROGRAM_CAP: a contributor has at most one enrollment per program.
export const CONTRIBUTOR_DETAIL_SELECT = {
  ...CONTRIBUTOR_SELECT,
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
      // type and hasCycles decide the entry mode: whether the directory draws
      // the year as twelve month cells or as a count of dated entries.
      program: {
        select: { name: true, isProtected: true, type: true, hasCycles: true },
      },
    },
  },
} satisfies Prisma.ContributorSelect;

export type ContributorDetailRow = Prisma.ContributorGetPayload<{
  select: typeof CONTRIBUTOR_DETAIL_SELECT;
}>;

// By account number — the workbook's row order — then id so ties never
// reorder between pages.
export const CONTRIBUTOR_ORDER_BY = [
  { accountNumber: 'asc' },
  { id: 'asc' },
] satisfies Prisma.ContributorOrderByWithRelationInput[];
