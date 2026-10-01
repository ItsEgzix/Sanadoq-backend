import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const listEnrollmentsQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['ACTIVE', 'DORMANT']).optional(),
  // A name fragment, or the start of an account number such as 0203.
  q: z.string().trim().max(100).optional(),
});

export class ListEnrollmentsQueryDto extends createZodDto(
  listEnrollmentsQuerySchema,
) {}
