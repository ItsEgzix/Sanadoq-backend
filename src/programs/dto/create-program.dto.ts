import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Strict, and with no isProtected field: protection is granted only by the
// baseline migration to the fund's membership program. A body that tries to
// send it is refused outright (400) rather than having the key silently
// dropped, so a client cannot mistake "ignored" for "accepted".
export const createProgramSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  type: z.enum(['PERIODIC', 'TEMPORARY']),
  // Independent of type: whether the program keeps its own cycles.
  hasCycles: z.boolean(),
  // Omitted: placed after the existing programs.
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export class CreateProgramDto extends createZodDto(createProgramSchema) {}
