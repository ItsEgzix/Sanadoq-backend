import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createExpenseLineSchema = z.strictObject({
  // The beneficiary or the purpose — "قيم جامع السعيد", "دعم للأخ / عبده سليم".
  name: z.string().trim().min(1).max(200),
  // The heading it sits under, or none. A blank heading is no heading, so the
  // sheet never shows two "ungrouped" groups — CHECK
  // "ExpenseLine_category_not_blank" refuses the empty string anyway.
  // Optional last: before the transform, Zod would make the key required in
  // the parsed type.
  category: z
    .string()
    .trim()
    .max(100)
    .nullable()
    .transform((value) => (value === '' ? null : value))
    .optional(),
  // Omitted: after the program's existing lines.
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});

export class CreateExpenseLineDto extends createZodDto(
  createExpenseLineSchema,
) {}
