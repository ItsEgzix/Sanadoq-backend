import { createZodDto } from 'nestjs-zod';
import { emailSchema, newPasswordSchema } from '../../auth/auth.schema';
import { z } from 'zod';

// No role field: there is one role today, and every account gets it through
// User.roleKey's default. Assigning roles arrives with the second role.
export const createUserSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1).max(200),
  // Set by whoever creates the account and handed over in person; the new
  // user changes it from their own account page.
  password: newPasswordSchema,
});

export class CreateUserDto extends createZodDto(createUserSchema) {}
