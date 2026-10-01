import { Module } from '@nestjs/common';
import { PersonModule } from 'src/people/person.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ProgramModule } from 'src/programs/program.module';
import { EnrollmentController } from './enrollment.controller';
import { EnrollmentService } from './enrollment.service';

/**
 * Exports EnrollmentService to PaymentModule (a person pays only a program
 * they are enrolled in) and EradatModule (the grid pages through enrollments).
 */
@Module({
  imports: [PrismaModule, ProgramModule, PersonModule],
  controllers: [EnrollmentController],
  providers: [EnrollmentService],
  exports: [EnrollmentService],
})
export class EnrollmentModule {}
