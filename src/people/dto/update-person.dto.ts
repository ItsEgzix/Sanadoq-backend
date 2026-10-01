import { createZodDto } from 'nestjs-zod';
import { createPersonSchema } from './create-person.dto';

// Changing the account number is a correction (a typo at entry). The old
// number is not retired by an edit — only deleted and merged rows keep theirs.
const updatePersonSchema = createPersonSchema.partial();

export class UpdatePersonDto extends createZodDto(updatePersonSchema) {}
