import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// The reviewer names the record that survives; it must be one of the flag's
// two people. The other is merged into it.
export const mergeDuplicateSchema = z.object({
  keepPersonId: z.string().min(1).max(64),
});

export class MergeDuplicateDto extends createZodDto(mergeDuplicateSchema) {}
