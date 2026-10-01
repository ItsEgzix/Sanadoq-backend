import { createZodDto } from 'nestjs-zod';
import { createContributorSchema } from './create-contributor.dto';

// Changing the account number is a correction (a typo at entry). The old
// number is not retired by an edit — only deleted and merged rows keep theirs.
const updateContributorSchema = createContributorSchema.partial();

export class UpdateContributorDto extends createZodDto(
  updateContributorSchema,
) {}
