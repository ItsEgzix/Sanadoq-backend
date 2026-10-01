import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const cellCoordinatesSchema = z.object({
  programId: z.string().max(64),
  // Mirrors CHECK "Payment_year_range".
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

export const personCellParamsSchema = cellCoordinatesSchema.extend({
  personId: z.string().max(64),
});

export const programCellParamsSchema = cellCoordinatesSchema.extend({
  payerProgramId: z.string().max(64),
});

export class PersonCellParamsDto extends createZodDto(personCellParamsSchema) {}

export class ProgramCellParamsDto extends createZodDto(
  programCellParamsSchema,
) {}
