import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { monthRefSchema } from '../../common/schemas/month.schema';

// Marking dormant or reactivating. `from` is the first month the new status
// counts for; omitted, it is January of this year — the fund's usual choice
// for both (a dormancy from the start of the year; a returnee settling the
// whole year) — or the latest change's month if that is later.
const termChangeSchema = z.strictObject({
  from: monthRefSchema.optional(),
});

export class TermChangeDto extends createZodDto(termChangeSchema) {}
