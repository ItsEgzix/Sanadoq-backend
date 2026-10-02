import { Module } from '@nestjs/common';
import { CycleModule } from '../cycles/cycle.module';
import { EnrollmentModule } from '../enrollments/enrollment.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EradatLinesService } from './eradat-lines.service';
import { EradatSummaryService } from './eradat-summary.service';
import { EradatWindowService } from './eradat-window.service';
import { EradatController } from './eradat.controller';

@Module({
  imports: [PrismaModule, CycleModule, EnrollmentModule],
  controllers: [EradatController],
  providers: [EradatWindowService, EradatSummaryService, EradatLinesService],
})
export class EradatModule {}
