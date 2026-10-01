import { createZodDto } from 'nestjs-zod';
import { moneySchema } from 'src/common/schemas/money.schema';
import { z } from 'zod';

// Editing expectedRate here is a correction — the new value applies to every
// year. A rate that changes *from* a given year is the unconfirmed mid-cycle
// flow, EnrollmentService.scheduleRateChange. The person and program are
// fixed: moving payments between people is what a duplicate merge is for.
const updateEnrollmentSchema = z
  .object({
    expectedRate: moneySchema,
    previousSubscription: moneySchema,
  })
  .partial();

export class UpdateEnrollmentDto extends createZodDto(updateEnrollmentSchema) {}
