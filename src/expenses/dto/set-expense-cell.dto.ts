import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { positiveMoneySchema } from '../../common/schemas/money.schema';

// An expense cell is an amount paid out that month. There is no ★ here: the
// expense sheets never record money under another month. Clearing a cell is
// DELETE, not a zero.
const setExpenseCellSchema = z.strictObject({
  amount: positiveMoneySchema,
});

export class SetExpenseCellDto extends createZodDto(setExpenseCellSchema) {}
