import type { Prisma } from '../../generated/prisma/client';

// The fund, its standing programs and every campaign it has run. The cap
// keeps the sidebar list a plain array and bounds per-program fan-out.
export const PROGRAM_CAP = 100;

export const PROGRAM_SELECT = {
  id: true,
  name: true,
  type: true,
  isProtected: true,
  sortOrder: true,
} satisfies Prisma.ProgramSelect;

export type ProgramRow = Prisma.ProgramGetPayload<{
  select: typeof PROGRAM_SELECT;
}>;

// The fund's membership program first — it is the reason the app exists —
// then the treasurer's chosen order. `id` last so ties never reorder.
export const PROGRAM_ORDER_BY = [
  { isProtected: 'desc' },
  { sortOrder: 'asc' },
  { name: 'asc' },
  { id: 'asc' },
] satisfies Prisma.ProgramOrderByWithRelationInput[];

// Payment and expense years are 2000..2100 (CHECKs "Payment_year_range" and
// "Expense_year_range"), so this bounds a program's distinct years by
// construction.
export const MAX_BOOK_YEARS = 101;
