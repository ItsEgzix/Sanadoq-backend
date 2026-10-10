import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AppException } from '../common/exceptions/app.exception';
import { toMoneyString, sumMoney, ZERO } from '../common/utils/money.util';
import { isForeignKeyViolation } from '../common/utils/prisma-error.util';
import type { EradatYearQueryDto } from '../eradat/dto/eradat-year-query.dto';
import { PROGRAM_CAP } from '../programs/program.constant';
import { ProgramWindowService } from '../programs/program-window.service';
import { ProgramService } from '../programs/program.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateExpenseLineDto } from './dto/create-expense-line.dto';
import type { ExpenseCellParamsDto } from './dto/expense-cell-params.dto';
import type { SetExpenseCellDto } from './dto/set-expense-cell.dto';
import type { UpdateExpenseLineDto } from './dto/update-expense-line.dto';
import {
  EXPENSE_CELL_SELECT,
  EXPENSE_LINE_CAP,
  EXPENSE_LINE_ORDER_BY,
  EXPENSE_LINE_SELECT,
  type ExpenseCellRow,
  type ExpenseLineRow,
} from './expense.constant';
import {
  emptyMonths,
  toExpenseLineView,
  toMonthStrings,
  type MonthAmounts,
} from './expense.util';

/** What one program paid to another in a year, month by month. */
export interface TransferOut {
  programId: string;
  name: string;
  isProtected: boolean;
  months: MonthAmounts;
  total: Prisma.Decimal;
}

/**
 * A program's expense sheet (المصروفات): its lines — the beneficiaries and
 * purposes it pays — and their monthly cells, plus what it paid to other
 * programs.
 *
 * A payment to another program is not stored here. It is a Payment row whose
 * payerProgramId is this program, recorded on the receiver's books as its
 * revenue; this sheet reads the same row as money paid out, so one
 * transaction is booked once and both programs' books show it.
 *
 * Exported for ExpenseSummaryService and DashboardModule.
 */
@Injectable()
export class ExpenseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly programService: ProgramService,
    private readonly windowService: ProgramWindowService,
  ) {}

  /** The sheet for one year: every line with that year's cells, and the transfers out. */
  async getSheet(programId: string, { year: requested }: EradatYearQueryDto) {
    const window = await this.windowService.resolve(programId, requested);
    const { year } = window;
    const [lines, cells, transfers] = await Promise.all([
      this.prisma.expenseLine.findMany({
        where: { programId },
        orderBy: EXPENSE_LINE_ORDER_BY,
        take: EXPENSE_LINE_CAP,
        select: EXPENSE_LINE_SELECT,
      }),
      this.prisma.expense.findMany({
        where: { programId, year },
        select: EXPENSE_CELL_SELECT,
        // Bounded by construction — one cell per line per month.
        take: EXPENSE_LINE_CAP * 12,
      }),
      this.loadTransfersOut(programId, year),
    ]);
    const byLine = new Map<string, ExpenseCellRow[]>();
    for (const cell of cells) {
      const list = byLine.get(cell.lineId);
      if (list) list.push(cell);
      else byLine.set(cell.lineId, [cell]);
    }
    return {
      year,
      years: window.years,
      items: lines.map((line) =>
        toExpenseLineView(line, byLine.get(line.id) ?? []),
      ),
      transfers: transfers.map((transfer) => ({
        programId: transfer.programId,
        name: transfer.name,
        isProtected: transfer.isProtected,
        months: toMonthStrings(transfer.months),
        yearTotal: toMoneyString(transfer.total),
      })),
      // The headings in use, so the line form can offer them.
      categories: [
        ...new Set(
          lines
            .map((line) => line.category)
            .filter((category): category is string => category !== null),
        ),
      ],
    };
  }

  async createLine(programId: string, dto: CreateExpenseLineDto) {
    const [, existing] = await Promise.all([
      this.programService.assertProgramExists(programId),
      this.prisma.expenseLine.aggregate({
        where: { programId },
        _count: { _all: true },
        _max: { sortOrder: true },
      }),
    ]);
    // Read-then-create can let two racing creates land one past the cap. The
    // cap bounds the sheet's reads, not a quota, so that is acceptable.
    if (existing._count._all >= EXPENSE_LINE_CAP) {
      throw new AppException(
        'EXPENSE_LINE_LIMIT_REACHED',
        { limit: EXPENSE_LINE_CAP },
        HttpStatus.CONFLICT,
      );
    }
    const line = await this.prisma.expenseLine.create({
      data: {
        programId,
        name: dto.name,
        category: dto.category ?? null,
        sortOrder: dto.sortOrder ?? (existing._max.sortOrder ?? 0) + 1,
      },
      select: EXPENSE_LINE_SELECT,
    });
    return {
      ...toExpenseLineView(line, []),
      successCode: 'EXPENSE_LINE_CREATE_SUCCESS',
    };
  }

  async updateLine(
    programId: string,
    lineId: string,
    dto: UpdateExpenseLineDto,
  ) {
    await this.findLineOrThrow(programId, lineId);
    const line = await this.prisma.expenseLine.update({
      where: { id: lineId },
      data: dto,
      select: EXPENSE_LINE_SELECT,
    });
    return { ...line, successCode: 'EXPENSE_LINE_UPDATE_SUCCESS' };
  }

  /**
   * Removes a mistaken line. Refused once money went out under it: from then
   * on it is part of the books, and an empty year is simply no cells.
   */
  async deleteLine(programId: string, lineId: string) {
    const line = await this.findLineOrThrow(programId, lineId);
    const count = await this.prisma.expense.count({ where: { lineId } });
    if (count > 0) throw this.lineHasExpenses(count);
    // Hard delete: a line with no cells carries no history.
    try {
      await this.prisma.expenseLine.delete({ where: { id: lineId } });
    } catch (err) {
      // A cell written between the count and the delete; the composite FK
      // refused the delete, which is the answer the count would have given.
      if (!isForeignKeyViolation(err)) throw err;
      throw this.lineHasExpenses(1);
    }
    return {
      id: lineId,
      name: line.name,
      successCode: 'EXPENSE_LINE_DELETE_SUCCESS',
    };
  }

  async setCell(
    userId: string,
    { programId, lineId, year, month }: ExpenseCellParamsDto,
    { amount }: SetExpenseCellDto,
  ) {
    await this.findLineOrThrow(programId, lineId);
    // Upsert on the (line, year, month) unique key: saving the same cell
    // twice — a double-click, a retry — rewrites it instead of adding a row.
    const cell = await this.prisma.expense.upsert({
      where: { lineId_year_month: { lineId, year, month } },
      create: { programId, lineId, year, month, amount, recordedById: userId },
      update: { amount, recordedById: userId },
      select: EXPENSE_CELL_SELECT,
    });
    return {
      ...cell,
      amount: toMoneyString(cell.amount),
      successCode: 'EXPENSE_CELL_SAVE_SUCCESS',
    };
  }

  async clearCell({ programId, lineId, year, month }: ExpenseCellParamsDto) {
    await this.findLineOrThrow(programId, lineId);
    // Hard delete: an empty cell is the absence of a row. deleteMany so
    // clearing an empty cell succeeds — the sheet ends up as asked either way.
    await this.prisma.expense.deleteMany({ where: { lineId, year, month } });
    return { lineId, year, month, successCode: 'EXPENSE_CELL_CLEAR_SUCCESS' };
  }

  /**
   * What this program paid to each other program in `year`, month by month:
   * the Payment rows it is the payer of. A receiver with a monthly grid has
   * its cells by month; one with a dated ledger has entries, folded into the
   * month of their date.
   */
  async loadTransfersOut(
    programId: string,
    year: number,
  ): Promise<TransferOut[]> {
    const where = { payerProgramId: programId, year };
    const [cells, entries, receivers] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ['programId', 'month'],
        where: { ...where, month: { not: null } },
        _sum: { amount: true },
      }),
      // At most 366 groups per receiver.
      this.prisma.payment.groupBy({
        by: ['programId', 'paymentDate'],
        where: { ...where, month: null },
        _sum: { amount: true },
      }),
      // The same receivers, found through the relation so this runs beside
      // the sums instead of after them. The unfiltered client: a receiver
      // deleted since is still named, because the money did leave.
      this.prisma.raw.program.findMany({
        where: { receivedPayments: { some: where } },
        select: { id: true, name: true, isProtected: true },
        take: PROGRAM_CAP,
      }),
    ]);
    const months = new Map<string, MonthAmounts>();
    const add = (
      receiver: string,
      monthIndex: number,
      amount: Prisma.Decimal | null,
    ) => {
      const row = months.get(receiver) ?? emptyMonths();
      row[monthIndex] = row[monthIndex].plus(amount ?? ZERO);
      months.set(receiver, row);
    };
    for (const row of cells) {
      if (row.month !== null)
        add(row.programId, row.month - 1, row._sum.amount);
    }
    for (const row of entries) {
      if (row.paymentDate) {
        add(row.programId, row.paymentDate.getUTCMonth(), row._sum.amount);
      }
    }
    return receivers
      .map((receiver) => {
        const row = months.get(receiver.id) ?? emptyMonths();
        return {
          programId: receiver.id,
          name: receiver.name,
          isProtected: receiver.isProtected,
          months: row,
          total: sumMoney(row),
        };
      })
      .sort(
        (a, b) =>
          Number(b.isProtected) - Number(a.isProtected) ||
          a.name.localeCompare(b.name),
      );
  }

  // The program and the line side by side, settled so the program's answer
  // always comes first. findFirst on (id, programId), so a line of another
  // program 404s here instead of being written through the wrong URL.
  private async findLineOrThrow(
    programId: string,
    lineId: string,
  ): Promise<ExpenseLineRow> {
    const [program, line] = await Promise.allSettled([
      this.programService.assertProgramExists(programId),
      this.prisma.expenseLine.findFirst({
        where: { id: lineId, programId },
        select: EXPENSE_LINE_SELECT,
      }),
    ]);
    if (program.status === 'rejected') throw program.reason;
    if (line.status === 'rejected') throw line.reason;
    if (!line.value) {
      throw new AppException(
        'EXPENSE_LINE_NOT_FOUND',
        { lineId },
        HttpStatus.NOT_FOUND,
      );
    }
    return line.value;
  }

  private lineHasExpenses(count: number): AppException {
    return new AppException(
      'EXPENSE_LINE_HAS_EXPENSES',
      { count },
      HttpStatus.CONFLICT,
    );
  }
}
