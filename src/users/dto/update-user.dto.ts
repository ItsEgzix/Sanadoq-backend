import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { createUserSchema } from './create-user.dto';

// Email and password are not editable here: an email change would let one
// manager silently take over another's sign-in, and passwords have their own
// routes (POST /auth/password for your own, POST /users/:id/password to reset
// someone else's).
export const updateUserSchema = createUserSchema
  .pick({ name: true })
  .extend({ isActive: z.boolean() })
  .partial();

export class UpdateUserDto extends createZodDto(updateUserSchema) {}
