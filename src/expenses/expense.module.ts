import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProgramModule } from '../programs/program.module';
import { ExpenseSummaryService } from './expense-summary.service';
import { ExpenseController } from './expense.controller';
import { ExpenseService } from './expense.service';

/**
 * Exports ExpenseSummaryService to DashboardModule, which sets the year's
 * spending beside its revenue.
 */
@Module({
  imports: [PrismaModule, ProgramModule],
  controllers: [ExpenseController],
  providers: [ExpenseService, ExpenseSummaryService],
  exports: [ExpenseSummaryService],
})
export class ExpenseModule {}
