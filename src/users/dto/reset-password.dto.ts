import { createZodDto } from 'nestjs-zod';
import { createUserSchema } from './create-user.dto';

export const resetPasswordSchema = createUserSchema.pick({ password: true });

export class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}
