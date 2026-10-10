import { Module } from '@nestjs/common';
import { ContributorModule } from '../contributors/contributor.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProgramModule } from '../programs/program.module';
import { EnrollmentTermService } from './enrollment-term.service';
import { EnrollmentController } from './enrollment.controller';
import { EnrollmentService } from './enrollment.service';

/**
 * Exports EnrollmentService to PaymentModule (a contributor pays only a program
 * they are enrolled in) and EradatModule (the grid pages through
 * enrollments), and EnrollmentTermService to EradatModule (arrears and a
 * year's expected total read each subscription's terms).
 */
@Module({
  imports: [PrismaModule, ProgramModule, ContributorModule],
  controllers: [EnrollmentController],
  providers: [EnrollmentService, EnrollmentTermService],
  exports: [EnrollmentService, EnrollmentTermService],
})
export class EnrollmentModule {}
