import { createZodDto } from 'nestjs-zod';
import { listEnrollmentsQuerySchema } from 'src/enrollments/dto/list-enrollments-query.dto';
import { eradatYearQuerySchema } from './eradat-year-query.dto';

// The lines page through enrollments exactly like GET …/enrollments, plus a year.
const linesQuerySchema = listEnrollmentsQuerySchema.extend(
  eradatYearQuerySchema.shape,
);

export class LinesQueryDto extends createZodDto(linesQuerySchema) {}
