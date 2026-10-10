import type { Prisma } from '../../generated/prisma/client';
import { sumMoney, toMoneyString, ZERO } from '../common/utils/money.util';
import type { ExpenseCellRow, ExpenseLineRow } from './expense.constant';

/**
 * Twelve months of money, January first: what one line paid out, or what
 * the program paid to one other program. A month with nothing is zero.
 */
export type MonthAmounts = Prisma.Decimal[];

export function emptyMonths(): MonthAmounts {
  return Array.from({ length: 12 }, () => ZERO);
}

/** An expense line's row for one year: its twelve cells and their total. */
export function toExpenseLineView(
  line: ExpenseLineRow,
  cells: readonly ExpenseCellRow[],
) {
  const months: Array<string | null> = Array.from({ length: 12 }, () => null);
  for (const cell of cells) months[cell.month - 1] = toMoneyString(cell.amount);
  return {
    ...line,
    months,
    yearTotal: toMoneyString(sumMoney(cells.map((cell) => cell.amount))),
  };
}

export type ExpenseLineView = ReturnType<typeof toExpenseLineView>;

/** One month's amounts as wire strings, January first. */
export function toMonthStrings(months: MonthAmounts): string[] {
  return months.map((amount) => toMoneyString(amount));
}
