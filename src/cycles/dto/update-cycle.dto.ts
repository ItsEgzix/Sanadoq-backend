import { createZodDto } from 'nestjs-zod';
import { createCycleSchema } from './create-cycle.dto';

// Switching the current cycle has its own route (POST …/cycles/:id/activate),
// so the update body only reshapes the year range.
const updateCycleSchema = createCycleSchema
  .omit({ makeCurrent: true })
  .partial();

export class UpdateCycleDto extends createZodDto(updateCycleSchema) {}
