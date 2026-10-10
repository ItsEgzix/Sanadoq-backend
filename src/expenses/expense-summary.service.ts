import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { sumMoney, toMoneyString, ZERO } from '../common/utils/money.util';
import type { EradatYearQueryDto } from '../eradat/dto/eradat-year-query.dto';
import { MAX_BOOK_YEARS } from '../programs/program.constant';
import {
  ProgramWindowService,
  type ProgramWindow,
} from '../programs/program-window.service';
import { PrismaService } from '../prisma/prisma.service';
import { EXPENSE_LINE_CAP } from './expense.constant';
import { ExpenseService } from './expense.service';

/**
 * One program's spending for one year: on its own lines and paid to other
 * programs, by month, by heading, and every year's total. Sums run in SQL;
 * every figure is this program's alone — nothing here adds programs
 * together.
 */
@Injectable()
export class ExpenseSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly windowService: ProgramWindowService,
    private readonly expenseService: ExpenseService,
  ) {}

  async getSummary(programId: string, { year }: EradatYearQueryDto) {
    return this.summarise(await this.windowService.resolve(programId, year));
  }

  /** The summary for a window already resolved — the dashboard's way in. */
  async summarise(window: ProgramWindow) {
    const { year, years } = window;
    const programId = window.program.id;
    const [byMonth, byLine, lines, lineYears, transferYears, transfers] =
      await Promise.all([
        this.prisma.expense.groupBy({
          by: ['month'],
          where: { programId, year },
          _sum: { amount: true },
        }),
        this.prisma.expense.groupBy({
          by: ['lineId'],
          where: { programId, year },
          _sum: { amount: true },
          orderBy: { lineId: 'asc' },
          take: EXPENSE_LINE_CAP,
        }),
        // Read beside the sums rather than after them, to name each line's
        // heading.
        this.prisma.expenseLine.findMany({
          where: { programId },
          select: { id: true, category: true },
          take: EXPENSE_LINE_CAP,
        }),
        this.prisma.expense.groupBy({
          by: ['year'],
          where: { programId },
          _sum: { amount: true },
          orderBy: { year: 'asc' },
          take: MAX_BOOK_YEARS,
        }),
        this.prisma.payment.groupBy({
          by: ['year'],
          where: { payerProgramId: programId },
          _sum: { amount: true },
          orderBy: { year: 'asc' },
          take: MAX_BOOK_YEARS,
        }),
        this.expenseService.loadTransfersOut(programId, year),
      ]);

    const fromLines = Array.from({ length: 12 }, (_, index) => {
      const row = byMonth.find((m) => m.month === index + 1);
      return row?._sum.amount ?? ZERO;
    });
    const toPrograms = Array.from({ length: 12 }, (_, index) =>
      sumMoney(transfers.map((transfer) => transfer.months[index])),
    );
    const linesTotal = sumMoney(fromLines);
    const transfersTotal = sumMoney(transfers.map((t) => t.total));

    return {
      year,
      years,
      total: toMoneyString(linesTotal.plus(transfersTotal)),
      fromLines: toMoneyString(linesTotal),
      toPrograms: toMoneyString(transfersTotal),
      months: fromLines.map((amount, index) => ({
        month: index + 1,
        fromLines: toMoneyString(amount),
        toPrograms: toMoneyString(toPrograms[index]),
        total: toMoneyString(amount.plus(toPrograms[index])),
      })),
      categories: this.byCategory(byLine, lines),
      yearTotals: years.map((y) => {
        const own = lineYears.find((row) => row.year === y)?._sum.amount;
        const out = transferYears.find((row) => row.year === y)?._sum.amount;
        return {
          year: y,
          fromLines: toMoneyString(own),
          toPrograms: toMoneyString(out),
          total: toMoneyString(sumMoney([own, out])),
        };
      }),
      transfersOut: {
        total: toMoneyString(transfersTotal),
        programs: transfers.map((transfer) => ({
          programId: transfer.programId,
          name: transfer.name,
          total: toMoneyString(transfer.total),
        })),
      },
    };
  }

  // The year's spending per heading, largest first; lines with no heading
  // together under null. Only headings that spent something this year.
  private byCategory(
    byLine: Array<{ lineId: string; _sum: { amount: Prisma.Decimal | null } }>,
    lines: Array<{ id: string; category: string | null }>,
  ) {
    const categoryOf = new Map(lines.map((line) => [line.id, line.category]));
    const totals = new Map<
      string | null,
      { total: Prisma.Decimal; lines: number }
    >();
    for (const row of byLine) {
      const category = categoryOf.get(row.lineId) ?? null;
      const entry = totals.get(category) ?? { total: ZERO, lines: 0 };
      entry.total = entry.total.plus(row._sum.amount ?? ZERO);
      entry.lines += 1;
      totals.set(category, entry);
    }
    return [...totals.entries()]
      .sort(([, a], [, b]) => b.total.comparedTo(a.total))
      .map(([category, { total, lines: lineCount }]) => ({
        category,
        total: toMoneyString(total),
        lineCount,
      }));
  }
}
