import type { Prisma } from 'generated/prisma/client';

export const PAYMENT_CELL_SELECT = {
  year: true,
  month: true,
  isStarred: true,
  amount: true,
} satisfies Prisma.PaymentSelect;

export type PaymentCellRow = Prisma.PaymentGetPayload<{
  select: typeof PAYMENT_CELL_SELECT;
}>;

// A dated ledger entry with enough of each payer kind to name it.
export const PAYMENT_ENTRY_SELECT = {
  id: true,
  year: true,
  paymentDate: true,
  amount: true,
  createdAt: true,
  contributorId: true,
  payerNameFreetext: true,
  payerProgramId: true,
  contributor: { select: { name: true, accountNumber: true } },
  // Relation reads are not soft-delete filtered, so a payment from a program
  // deleted since still names it.
  payerProgram: { select: { name: true } },
  recordedBy: { select: { name: true } },
} satisfies Prisma.PaymentSelect;

export type PaymentEntryRow = Prisma.PaymentGetPayload<{
  select: typeof PAYMENT_ENTRY_SELECT;
}>;
