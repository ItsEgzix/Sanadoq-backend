import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  CYCLE_MAX_LENGTH_YEARS,
  CYCLE_MAX_START_YEAR,
  CYCLE_MIN_START_YEAR,
} from '../cycle.constant';

export const createCycleSchema = z.object({
  startYear: z
    .number()
    .int()
    .min(CYCLE_MIN_START_YEAR)
    .max(CYCLE_MAX_START_YEAR),
  // Configurable on purpose — the fund has used 5 and 4 and is weighing 3.
  lengthYears: z.number().int().min(1).max(CYCLE_MAX_LENGTH_YEARS),
  // Omitted: the new cycle becomes current only when the program has none yet.
  makeCurrent: z.boolean().optional(),
});

export class CreateCycleDto extends createZodDto(createCycleSchema) {}
