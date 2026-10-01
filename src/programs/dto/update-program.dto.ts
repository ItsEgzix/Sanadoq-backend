import { createZodDto } from 'nestjs-zod';
import { createProgramSchema } from './create-program.dto';

// type and hasCycles are accepted here but ProgramService refuses to change
// them on the protected program, or on any program that already has payments
// or cycles. Still strict, so isProtected can never ride along.
const updateProgramSchema = createProgramSchema.partial();

export class UpdateProgramDto extends createZodDto(updateProgramSchema) {}
