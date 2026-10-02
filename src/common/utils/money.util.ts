import { Prisma } from '../../../generated/prisma/client';

/**
 * Money and ratio formatting — the single place amounts are rounded for the
 * wire. Amounts travel as fixed-scale decimal strings, never JS numbers, so a
 * running total of thousands of cells cannot pick up float drift on the way
 * to the browser. The frontend displays these strings; it never sums them.
 */

const MONEY_SCALE = 2;
const RATIO_SCALE = 4;

export const ZERO = new Prisma.Decimal(0);

export function toMoneyString(
  value: Prisma.Decimal | null | undefined,
): string {
  return (value ?? ZERO).toFixed(MONEY_SCALE);
}

export function toRatioString(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(RATIO_SCALE);
}

/** Sums nullable decimals, treating null as zero — the same rule SQL SUM applies. */
export function sumMoney(
  values: ReadonlyArray<Prisma.Decimal | null | undefined>,
): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>(
    (total, value) => (value ? total.plus(value) : total),
    ZERO,
  );
}
