import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Strict, and with no isProtected field: protection is granted only by the
// baseline migration to the fund's membership program. A body that tries to
// send it is refused outright (400) rather than having the key silently
// dropped, so a client cannot mistake "ignored" for "accepted".
export const createProgramSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  // Also decides cycles (runsInCycles), so there is no hasCycles field; a
  // client that still sends one gets a 400 rather than a silent drop.
  type: z.enum(['PERIODIC', 'TEMPORARY']),
  // Omitted: placed after the existing programs.
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export class CreateProgramDto extends createZodDto(createProgramSchema) {}
