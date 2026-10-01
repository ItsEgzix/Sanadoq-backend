import { createZodDto } from 'nestjs-zod';
import { moneySchema } from 'src/common/schemas/money.schema';
import { createContributorSchema } from 'src/contributors/dto/create-contributor.dto';
import { z } from 'zod';

// No `status`: enrollments start ACTIVE, go dormant through POST
// …/mark-dormant, and come back only through the unconfirmed
// EnrollmentService.reactivateEnrollment. Keeping it out of the body means
// the update DTO cannot bypass those flows either.
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
