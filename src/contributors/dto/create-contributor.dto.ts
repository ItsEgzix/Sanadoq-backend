import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CONTRIBUTOR_ACCOUNT_NUMBER_PATTERN } from '../contributor.constant';

// Blank means "none": a cleared form field arrives as "" and is stored as
// NULL, so an empty phone never reads as a phone number.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

export const createContributorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  // Typed as text, never a number: the leading zero of 0203002 is part of it.
  accountNumber: z.string().trim().regex(CONTRIBUTOR_ACCOUNT_NUMBER_PATTERN, {
    message: 'Must be the 7-digit account number, YYMMNNN.',
  }),
  phone: optionalText(40),
  email: z
    .union([z.literal(''), z.email().max(254)])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
});

export class CreateContributorDto extends createZodDto(
  createContributorSchema,
) {}
