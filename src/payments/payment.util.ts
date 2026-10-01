import type { Prisma } from 'generated/prisma/client';
import { toIsoDate } from 'src/common/schemas/date.schema';
import { toMoneyString } from 'src/common/utils/money.util';
import type { PaymentCellRow, PaymentEntryRow } from './payment.constant';
import type { CellPayer, PaymentPayer } from './payment.types';

/**
 * A cell as the API returns it. A starred cell's amount is null — not "0.00" —
 * so nothing downstream can mistake "recorded under another month" for "paid
 * zero".
 */
export function toPaymentCellView(cell: PaymentCellRow) {
  return {
    year: cell.year,
    month: cell.month,
    isStarred: cell.isStarred,
    amount: cell.isStarred ? null : toMoneyString(cell.amount),
  };
}

export type PaymentCellView = ReturnType<typeof toPaymentCellView>;

/** The payer's column, for create data and filters. Exactly one is set. */
export function payerColumns(
  payer: PaymentPayer,
): Pick<
  Prisma.PaymentUncheckedCreateInput,
  'personId' | 'payerProgramId' | 'payerNameFreetext'
> {
  switch (payer.kind) {
    case 'PERSON':
      return { personId: payer.personId };
    case 'PROGRAM':
      return { payerProgramId: payer.programId };
    case 'FREETEXT':
      return { payerNameFreetext: payer.name };
  }
}

/** The unique key of one monthly cell: (program, payer, year, month). */
export function cellUniqueKey(
  programId: string,
  payer: CellPayer,
  year: number,
  month: number,
): Prisma.PaymentWhereUniqueInput {
  return payer.kind === 'PERSON'
    ? {
        programId_personId_year_month: {
          programId,
          personId: payer.personId,
          year,
          month,
        },
      }
    : {
        programId_payerProgramId_year_month: {
          programId,
          payerProgramId: payer.programId,
          year,
          month,
        },
      };
}

/** A dated ledger entry as the API returns it, with its payer named. */
export function toPaymentEntryView(entry: PaymentEntryRow) {
  return {
    id: entry.id,
    year: entry.year,
    // Dated entries always have a date (CHECK "Payment_month_or_date"); the
    // ledger only ever selects rows with month NULL.
    paymentDate: entry.paymentDate ? toIsoDate(entry.paymentDate) : null,
    amount: toMoneyString(entry.amount),
    createdAt: entry.createdAt,
    recordedBy: entry.recordedBy?.name ?? null,
    payer: describePayer(entry),
  };
}

export type PaymentEntryView = ReturnType<typeof toPaymentEntryView>;

function describePayer(entry: PaymentEntryRow) {
  if (entry.personId && entry.person) {
    return {
      kind: 'PERSON' as const,
      personId: entry.personId,
      name: entry.person.name,
      accountNumber: entry.person.accountNumber,
    };
  }
  if (entry.payerProgramId && entry.payerProgram) {
    return {
      kind: 'PROGRAM' as const,
      programId: entry.payerProgramId,
      name: entry.payerProgram.name,
    };
  }
  return { kind: 'FREETEXT' as const, name: entry.payerNameFreetext ?? '' };
}
