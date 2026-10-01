import { Module } from '@nestjs/common';
import { ContributorModule } from 'src/contributors/contributor.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ProgramModule } from 'src/programs/program.module';
import { EnrollmentController } from './enrollment.controller';
import { EnrollmentService } from './enrollment.service';

/**
 * Exports EnrollmentService to PaymentModule (a contributor pays only a program
 * they are enrolled in) and EradatModule (the grid pages through enrollments).
 */
@Module({
  imports: [PrismaModule, ProgramModule, ContributorModule],
  controllers: [EnrollmentController],
  providers: [EnrollmentService],
  exports: [EnrollmentService],
})
export class EnrollmentModule {}
