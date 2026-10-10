import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  bookYearSchema,
  calendarMonthSchema,
} from '../../common/schemas/month.schema';

const expenseCellParamsSchema = z.object({
  programId: z.string().max(64),
  lineId: z.string().max(64),
  year: bookYearSchema,
  month: calendarMonthSchema,
});

export class ExpenseCellParamsDto extends createZodDto(
  expenseCellParamsSchema,
) {}
