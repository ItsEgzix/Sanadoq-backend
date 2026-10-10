import { Module } from '@nestjs/common';
import { EnrollmentModule } from '../enrollments/enrollment.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProgramModule } from '../programs/program.module';
import { EradatArrearsService } from './eradat-arrears.service';
import { EradatLinesService } from './eradat-lines.service';
import { EradatSummaryService } from './eradat-summary.service';
import { EradatController } from './eradat.controller';

/**
 * The read side of a program's revenue. Exports EradatSummaryService to
 * DashboardModule, which sets the year's revenue beside its expenses.
 */
@Module({
  imports: [PrismaModule, ProgramModule, EnrollmentModule],
  controllers: [EradatController],
  providers: [EradatArrearsService, EradatSummaryService, EradatLinesService],
  exports: [EradatSummaryService],
})
export class EradatModule {}
