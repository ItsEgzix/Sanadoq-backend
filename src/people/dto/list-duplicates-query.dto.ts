import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const listDuplicatesQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(['OPEN', 'MERGED', 'DISMISSED']).default('OPEN'),
});

export class ListDuplicatesQueryDto extends createZodDto(
  listDuplicatesQuerySchema,
) {}
