import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH } from '../auth.constant';
import { newPasswordSchema } from '../auth.schema';

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: newPasswordSchema,
  })
  .refine((dto) => dto.newPassword !== dto.currentPassword, {
    message: 'The new password must differ from the current one.',
    path: ['newPassword'],
  });

export class ChangePasswordDto extends createZodDto(changePasswordSchema) {}
