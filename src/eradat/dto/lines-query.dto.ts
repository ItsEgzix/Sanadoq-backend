import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { listEnrollmentsQuerySchema } from '../../enrollments/dto/list-enrollments-query.dto';
import { eradatYearQuerySchema } from './eradat-year-query.dto';

// The lines page through enrollments exactly like GET …/enrollments, plus a
// year and the arrears filter.
const linesQuerySchema = listEnrollmentsQuerySchema
  .extend(eradatYearQuerySchema.shape)
  .extend({
    // Only active subscribers behind on the year (عجز) — see
    // EradatArrearsService. A stringbool, because z.coerce.boolean() would
    // read the query string "false" as true.
    behind: z.stringbool().optional(),
  });

export class LinesQueryDto extends createZodDto(linesQuerySchema) {}
