import type { Prisma } from '../../generated/prisma/client';

// A program's expense sheet: every beneficiary and purpose it has ever paid.
// The fund's busiest sheet has a few dozen lines a year; the cap keeps the
// sheet one plain array and bounds every per-line read.
export const EXPENSE_LINE_CAP = 500;

export const EXPENSE_LINE_SELECT = {
  id: true,
  programId: true,
  name: true,
  category: true,
  sortOrder: true,
} satisfies Prisma.ExpenseLineSelect;

export type ExpenseLineRow = Prisma.ExpenseLineGetPayload<{
  select: typeof EXPENSE_LINE_SELECT;
}>;

export const EXPENSE_CELL_SELECT = {
  lineId: true,
  year: true,
  month: true,
  amount: true,
} satisfies Prisma.ExpenseSelect;

export type ExpenseCellRow = Prisma.ExpenseGetPayload<{
  select: typeof EXPENSE_CELL_SELECT;
}>;

// The workbook's order: lines grouped under their heading, ungrouped lines
// last, then the treasurer's order within a group. `id` last so ties never
// reorder.
export const EXPENSE_LINE_ORDER_BY = [
  { category: { sort: 'asc', nulls: 'last' } },
  { sortOrder: 'asc' },
  { name: 'asc' },
  { id: 'asc' },
] satisfies Prisma.ExpenseLineOrderByWithRelationInput[];
