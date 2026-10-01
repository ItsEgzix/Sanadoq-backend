import { z } from 'zod';

// Up to 12 integer digits and 2 decimals — the Decimal(14, 2) columns. Kept as
// a string end to end: parsing "1200.10" into a JS number first would round
// some cents before Prisma.Decimal ever saw them.
const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * A non-negative money amount in the fund's booking currency. Accepts a JSON
 * number or a numeric string and always yields the string form.
 */
export const moneySchema = z
  .union([z.string().trim().max(20), z.number().nonnegative()])
  .transform((value) => String(value))
  .refine((value) => MONEY_PATTERN.test(value), {
    message: 'Must be a non-negative amount with at most 2 decimals.',
  });

/** A money amount that must be greater than zero (a filled payment cell). */
export const positiveMoneySchema = moneySchema.refine(
  (value) => Number(value) > 0,
  { message: 'Must be greater than zero. Clear the cell instead.' },
);
