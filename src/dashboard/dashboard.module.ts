import { Module } from '@nestjs/common';
import { EradatModule } from '../eradat/eradat.module';
import { ExpenseModule } from '../expenses/expense.module';
import { ProgramModule } from '../programs/program.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [ProgramModule, EradatModule, ExpenseModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
