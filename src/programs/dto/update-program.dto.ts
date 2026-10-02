import { createZodDto } from 'nestjs-zod';
import { createProgramSchema } from './create-program.dto';

// type is accepted here but ProgramService refuses to change it on the
// protected program, or on any program that already has payments, cycles or
// enrollments. Still strict, so isProtected can never ride along.
const updateProgramSchema = createProgramSchema.partial();

export class UpdateProgramDto extends createZodDto(updateProgramSchema) {}
