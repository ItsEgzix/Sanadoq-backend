import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CYCLE_MAX_LENGTH_YEARS } from '../cycle.constant';

// Shortens a cycle and starts the next one the year after, in one step: the
// years cut off become the new cycle's first years, so payments already in
// them stay inside a cycle instead of having to be deleted.
export const splitCycleSchema = z.strictObject({
  // The cycle's new, shorter length — CycleService checks it is shorter.
  lengthYears: z.number().int().min(1).max(CYCLE_MAX_LENGTH_YEARS),
  // The new cycle's length. Its first years are the ones cut off; it must
  // reach at least as far as the last of them that holds a payment.
  nextLengthYears: z.number().int().min(1).max(CYCLE_MAX_LENGTH_YEARS),
});

export class SplitCycleDto extends createZodDto(splitCycleSchema) {}
