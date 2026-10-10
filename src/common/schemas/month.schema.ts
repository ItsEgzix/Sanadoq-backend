import { z } from 'zod';

// Mirrors CHECK "Payment_year_range", "Expense_year_range" and
// "EnrollmentTerm_from_year_range": every dated thing in the books lives in
// the same span of years.
export const bookYearSchema = z.coerce.number().int().min(2000).max(2100);

export const calendarMonthSchema = z.coerce.number().int().min(1).max(12);

/** One month of one year — when a subscription change takes effect. */
export const monthRefSchema = z.object({
  year: bookYearSchema,
  month: calendarMonthSchema,
});
