import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { bookYearSchema } from '../../common/schemas/month.schema';

export const eradatYearQuerySchema = z.object({
  // Any year the books can hold. Omitted: this year.
  year: bookYearSchema.optional(),
});

export class EradatYearQueryDto extends createZodDto(eradatYearQuerySchema) {}
