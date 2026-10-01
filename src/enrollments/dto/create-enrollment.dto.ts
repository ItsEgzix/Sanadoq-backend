import { createZodDto } from 'nestjs-zod';
import { moneySchema } from 'src/common/schemas/money.schema';
import { createPersonSchema } from 'src/people/dto/create-person.dto';
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
    personId: z.string().min(1).max(64).optional(),
    // …or create them in the same step. The new person is checked for
    // likely duplicates after saving, never merged.
    person: createPersonSchema.optional(),
    // This person's pledge to this program, per year. Zero for no pledge.
    expectedRate: moneySchema,
    // Typed in from the old books; never computed. Omitted: zero.
    previousSubscription: moneySchema.optional(),
  })
  .refine(
    (dto) => (dto.personId === undefined) !== (dto.person === undefined),
    {
      message:
        'Give either an existing personId or a new person — exactly one.',
      path: ['personId'],
    },
  );

export class CreateEnrollmentDto extends createZodDto(createEnrollmentSchema) {}
