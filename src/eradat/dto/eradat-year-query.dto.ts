import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const eradatYearQuerySchema = z.object({
  // Must fall inside the program's current cycle when it has one. Omitted:
  // this year, clamped into the cycle.
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export class EradatYearQueryDto extends createZodDto(eradatYearQuerySchema) {}
