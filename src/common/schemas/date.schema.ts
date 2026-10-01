import { z } from 'zod';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const toUtcMidnight = (value: string) => new Date(`${value}T00:00:00.000Z`);

/** A Date at midnight UTC back to its `YYYY-MM-DD` form for the wire. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A calendar date, `YYYY-MM-DD`, with no time and no zone — the day the
 * treasurer says the money arrived. Parsed to midnight UTC because Prisma
 * writes a DATE column from the UTC calendar day; parsing in the server's
 * zone could move the payment to the previous day.
 */
export const isoDateSchema = z
  .string()
  .trim()
  .regex(ISO_DATE_PATTERN, 'Must be a date as YYYY-MM-DD.')
  // A round trip, not an Invalid Date check: V8 rolls "2026-02-30" over to
  // 2 March rather than rejecting it, and the payment would land on a day
  // nobody typed.
  .refine((value) => {
    const date = toUtcMidnight(value);
    return !Number.isNaN(date.getTime()) && toIsoDate(date) === value;
  }, 'Must be a real calendar date.')
  .transform(toUtcMidnight);
