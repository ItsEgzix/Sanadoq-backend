import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { eradatYearQuerySchema } from './eradat-year-query.dto';

const ledgerQuerySchema = eradatYearQuerySchema.extend({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export class LedgerQueryDto extends createZodDto(ledgerQuerySchema) {}
