import { createZodDto } from 'nestjs-zod';
import { positiveMoneySchema } from '../../common/schemas/money.schema';
import { z } from 'zod';

// A cell is either money received that month, or ★ — paid, but recorded under
// a different month. The refine rejects a star that carries an amount, so a
// client cannot send a value that would later be summed. Clearing a cell is
// DELETE, not a third state.
//
// An object plus refine rather than a discriminated union: nestjs-zod can only
// build a DTO class from an object schema.
export const setCellSchema = z
  .object({
    isStarred: z.boolean().default(false),
    amount: positiveMoneySchema.optional(),
  })
  .refine((cell) => cell.isStarred === (cell.amount === undefined), {
    message:
      'An unstarred cell needs an amount; a starred cell must not have one.',
    path: ['amount'],
  });

export class SetCellDto extends createZodDto(setCellSchema) {}
