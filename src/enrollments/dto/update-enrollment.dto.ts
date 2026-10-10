import { createZodDto } from 'nestjs-zod';
import { moneySchema } from '../../common/schemas/money.schema';
import { z } from 'zod';

// Editing expectedRate here is a correction: the pledge was wrong, and the
// new value replaces it for as long as the current term has run. A pledge
// that changes *from* a month — the months before keep the old one — is
// POST …/rate-changes. The contributor and program are fixed: moving
// payments between contributors is what a duplicate merge is for.
const updateEnrollmentSchema = z
  .object({
    expectedRate: moneySchema,
    previousSubscription: moneySchema,
  })
  .partial();

export class UpdateEnrollmentDto extends createZodDto(updateEnrollmentSchema) {}
