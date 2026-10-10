import { createZodDto } from 'nestjs-zod';
import { createExpenseLineSchema } from './create-expense-line.dto';

// Renaming or regrouping a line moves every cell under it along, since cells
// point at the line, not at its name.
const updateExpenseLineSchema = createExpenseLineSchema.partial();

export class UpdateExpenseLineDto extends createZodDto(
  updateExpenseLineSchema,
) {}
