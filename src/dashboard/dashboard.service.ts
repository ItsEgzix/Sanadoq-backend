import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { toMoneyString } from '../common/utils/money.util';
import type { EradatYearQueryDto } from '../eradat/dto/eradat-year-query.dto';
import { EradatSummaryService } from '../eradat/eradat-summary.service';
import { ExpenseSummaryService } from '../expenses/expense-summary.service';
import { ProgramWindowService } from '../programs/program-window.service';

// Both summaries hand their figures over as fixed-scale strings; a Decimal
// parses those exactly, so the balance carries no float drift.
const money = (value: string) => new Prisma.Decimal(value);

function balanceOf(revenue: string, expenses: string) {
  return {
    revenue,
    expenses,
    balance: toMoneyString(money(revenue).minus(money(expenses))),
  };
}

/**
 * A program's dashboard for one year: its revenue and its spending side by
 * side, and the balance between them — by month, for the year, and for every
 * year the books hold.
 *
 * The balance is each year's own: money received that year less money paid
 * out that year. It deliberately leaves out الاشتراك السابق, which is revenue
 * from before these books with none of that era's spending beside it, so
 * adding it would show a surplus the fund never had.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly windowService: ProgramWindowService,
    private readonly revenueService: EradatSummaryService,
    private readonly expenseService: ExpenseSummaryService,
  ) {}

  // One window for both sides, so they are about the same year and offer the
  // same tabs; then both summaries side by side.
  async getDashboard(programId: string, { year }: EradatYearQueryDto) {
    const window = await this.windowService.resolve(programId, year);
    const [revenue, expenses] = await Promise.all([
      this.revenueService.summarise(window),
      this.expenseService.summarise(window),
    ]);
    return {
      program: window.program,
      year: window.year,
      years: window.years,
      revenue,
      expenses,
      balance: {
        ...balanceOf(revenue.revenue.total, expenses.total),
        months: revenue.months.map((month, index) => ({
          month: month.month,
          ...balanceOf(month.total, expenses.months[index].total),
        })),
        years: revenue.yearTotals.map((entry, index) => ({
          year: entry.year,
          ...balanceOf(entry.total, expenses.yearTotals[index].total),
        })),
      },
    };
  }
}
