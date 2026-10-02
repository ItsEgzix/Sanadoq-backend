import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Lists only the contributors enrolled in no live program. Program ids are
// UUIDs, so this can never collide with one.
export const IN_NO_PROGRAM = 'none';

export const listContributorsQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // A name fragment, or the start of an account number such as 0203.
  q: z.string().trim().max(100).optional(),
  // A program's id — only the contributors enrolled in it — or IN_NO_PROGRAM.
  program: z.string().trim().min(1).max(64).optional(),
  // Set by the directory: each enrollment then carries that year's payments.
  // The enroll picker leaves it off and so skips the read.
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export class ListContributorsQueryDto extends createZodDto(
  listContributorsQuerySchema,
) {}
