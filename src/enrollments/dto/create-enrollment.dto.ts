import { createZodDto } from 'nestjs-zod';
import { moneySchema } from '../../common/schemas/money.schema';
import { monthRefSchema } from '../../common/schemas/month.schema';
import { createContributorSchema } from '../../contributors/dto/create-contributor.dto';
import { z } from 'zod';

// No `status`: enrollments start ACTIVE, go dormant through POST
// …/mark-dormant and come back through POST …/reactivate, each with the
// month it takes effect. Keeping it out of the body means neither this nor
// the update DTO can bypass that history.
//
// An object plus refine rather than a union: nestjs-zod can only build a DTO
// class from an object schema.
export const createEnrollmentSchema = z
  .object({
    // Enroll someone already in the directory…
    contributorId: z.string().min(1).max(64).optional(),
    // …or create them in the same step. The new contributor is checked for
    // likely duplicates after saving, never merged.
    contributor: createContributorSchema.optional(),
    // This contributor's pledge to this program, per year. Zero for no pledge.
    expectedRate: moneySchema,
    // Typed in from the old books; never computed. Omitted: zero.
    previousSubscription: moneySchema.optional(),
    // The first month they owe for — the fund counts a mid-year joiner's
    // العجز from the month they joined. Omitted: this month. Never later.
    joinedFrom: monthRefSchema.optional(),
  })
  .refine(
    (dto) =>
      (dto.contributorId === undefined) !== (dto.contributor === undefined),
    {
      message:
        'Give either an existing contributorId or a new contributor — exactly one.',
      path: ['contributorId'],
    },
  );

export class CreateEnrollmentDto extends createZodDto(createEnrollmentSchema) {}
