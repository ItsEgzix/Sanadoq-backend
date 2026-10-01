import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH } from '../auth.constant';
import { emailSchema } from '../auth.schema';

// No minimum length on the password here: a login checks the password the
// account has, whatever rule was in force when it was set.
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export class LoginDto extends createZodDto(loginSchema) {}
