import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { moneySchema } from '../../common/schemas/money.schema';
import { monthRefSchema } from '../../common/schemas/month.schema';

// A new yearly pledge from a month on — the months before keep the old one.
// Correcting a pledge that was wrong from the start is PATCH …/:enrollmentId
// instead.
const rateChangeSchema = z.strictObject({
  expectedRate: moneySchema,
  from: monthRefSchema,
});

export class RateChangeDto extends createZodDto(rateChangeSchema) {}
