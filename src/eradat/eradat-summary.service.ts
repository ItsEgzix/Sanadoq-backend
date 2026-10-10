import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import {
  sumMoney,
  toMoneyString,
  toRatioString,
  ZERO,
} from '../common/utils/money.util';
import { MAX_BOOK_YEARS } from '../programs/program.constant';
import {
  ProgramWindowService,
  type ProgramWindow,
} from '../programs/program-window.service';
import type { EntryMode } from '../programs/program.util';
import { PrismaService } from '../prisma/prisma.service';
import type { EradatYearQueryDto } from './dto/eradat-year-query.dto';
import { EradatArrearsService } from './eradat-arrears.service';
import {
  collectionRatio,
  remainingForYear,
  runningTotal,
} from './revenue.util';

// Every revenue figure below is filtered on `programId` — the receiving
// program — and split by who paid. A payment this program *made* to another
// (payerProgramId = this program) is never among them: it is this program's
// expense, read by the expense side (ExpenseSummaryService).
const PAYER_KINDS = {
  enrolled: { contributorId: { not: null } },
  programs: { payerProgramId: { not: null } },
  oneOff: { payerNameFreetext: { not: null } },
} satisfies Record<string, Prisma.PaymentWhereInput>;

type PayerKind = keyof typeof PAYER_KINDS;
export type KindTotals = Record<PayerKind, Prisma.Decimal>;

interface MonthTotals extends KindTotals {
  // Unstarred payments by enrolled contributors that month, and stars.
  paidCount: number;
  starredCount: number;
  // Unstarred payments of every payer kind — a temporary program's gifts,
  // where paidCount alone would miss the one-off donors.
  entryCount: number;
}

const emptyKindTotals = (): KindTotals => ({
  enrolled: ZERO,
  programs: ZERO,
  oneOff: ZERO,
});

export const kindTotal = (totals: KindTotals) =>
  sumMoney([totals.enrolled, totals.programs, totals.oneOff]);

function toKindView(totals: KindTotals) {
  return {
    fromEnrolled: toMoneyString(totals.enrolled),
    fromPrograms: toMoneyString(totals.programs),
    fromOneOff: toMoneyString(totals.oneOff),
    total: toMoneyString(kindTotal(totals)),
  };
}

/**
 * One program's revenue for one year: pledges against pledge-backed
 * collections, revenue split by payer kind, month and year totals and
 * running totals. Sums run in SQL, so the cost is flat in the number of
 * enrollments; they agree with revenue.util because a star's amount is NULL
 * by constraint.
 */
@Injectable()
export class EradatSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly windowService: ProgramWindowService,
    private readonly arrearsService: EradatArrearsService,
  ) {}

  async getSummary(programId: string, { year }: EradatYearQueryDto) {
    return this.summarise(await this.windowService.resolve(programId, year));
  }

  /** The summary for a window already resolved — the dashboard's way in. */
  async summarise(window: ProgramWindow) {
    const { program, year, years } = window;
    const programId = program.id;

    const [previous, statusCounts, totalsByYear, months, owing] =
      await Promise.all([
        this.prisma.programEnrollment.aggregate({
          where: { programId },
          _sum: { previousSubscription: true },
        }),
        this.prisma.programEnrollment.groupBy({
          by: ['status'],
          where: { programId },
          _count: { _all: true },
        }),
        this.loadYearTotals(programId),
        this.loadMonthTotals(programId, year, program.entryMode),
        // Only a periodic program has pledges to collect against.
        program.entryMode === 'MONTHLY'
          ? this.arrearsService.loadArrears(programId, year)
          : null,
      ]);

    const totalsOf = (y: number) => totalsByYear.get(y) ?? emptyKindTotals();
    const selected = totalsOf(year);
    const allYears = [...totalsByYear.values()];
    const previousSubscriptionTotal =
      previous._sum.previousSubscription ?? ZERO;
    const expectedTotal = owing?.expectedTotal ?? ZERO;
    const countOf = (status: 'ACTIVE' | 'DORMANT') =>
      statusCounts.find((row) => row.status === status)?._count._all ?? 0;

    return {
      program,
      year,
      years,
      counts: {
        enrollments: countOf('ACTIVE') + countOf('DORMANT'),
        active: countOf('ACTIVE'),
        dormant: countOf('DORMANT'),
      },
      // العجز for the year: the same list the grid's "behind" filter shows.
      arrears: owing && {
        monthsDue: owing.monthsDue,
        count: owing.behind.size,
        total: toMoneyString(sumMoney([...owing.behind.values()])),
      },
      // The workbook's الحساب block: اجمالي معدل الاشتراك, اجمالي التحصيل,
      // اجمالي المتبقي and النسبة.
      collection: {
        expectedTotal: toMoneyString(expectedTotal),
        collectedTotal: toMoneyString(selected.enrolled),
        remainingTotal: toMoneyString(
          remainingForYear(expectedTotal, selected.enrolled),
        ),
        ratio: toRatioString(collectionRatio(selected.enrolled, expectedTotal)),
      },
      revenue: toKindView(selected),
      months: months.map((month, index) => ({
        month: index + 1,
        ...toKindView(month),
        paidCount: month.paidCount,
        starredCount: month.starredCount,
        entryCount: month.entryCount,
      })),
      yearTotals: years.map((y) => ({ year: y, ...toKindView(totalsOf(y)) })),
      running: {
        previousSubscriptionTotal: toMoneyString(previousSubscriptionTotal),
        // Summing every enrollment's running total gives the same figure,
        // since each is its previous subscription plus all its payments.
        enrolledRunningTotal: toMoneyString(
          runningTotal(
            previousSubscriptionTotal,
            allYears.map((totals) => totals.enrolled),
          ),
        ),
        revenueRunningTotal: toMoneyString(
          runningTotal(previousSubscriptionTotal, allYears.map(kindTotal)),
        ),
      },
    };
  }

  // Every year's totals, split by payer kind — the year cards and the
  // running totals, which cover every year the books hold.
  private async loadYearTotals(
    programId: string,
  ): Promise<Map<number, KindTotals>> {
    const byYear = new Map<number, KindTotals>();
    await Promise.all(
      (Object.keys(PAYER_KINDS) as PayerKind[]).map(async (kind) => {
        const rows = await this.prisma.payment.groupBy({
          by: ['year'],
          where: { programId, ...PAYER_KINDS[kind] },
          _sum: { amount: true },
          orderBy: { year: 'asc' },
          take: MAX_BOOK_YEARS,
        });
        for (const row of rows) {
          const totals = byYear.get(row.year) ?? emptyKindTotals();
          totals[kind] = row._sum.amount ?? ZERO;
          byYear.set(row.year, totals);
        }
      }),
    );
    return byYear;
  }

  // Twelve entries, January first. A monthly grid groups on its month column;
  // a ledger groups on the payment date (at most 366 groups a year) and folds
  // the days into months.
  private async loadMonthTotals(
    programId: string,
    year: number,
    mode: EntryMode,
  ): Promise<MonthTotals[]> {
    const months: MonthTotals[] = Array.from({ length: 12 }, () => ({
      ...emptyKindTotals(),
      paidCount: 0,
      starredCount: 0,
      entryCount: 0,
    }));

    if (mode === 'MONTHLY') {
      const [enrolled, programs] = await Promise.all([
        this.prisma.payment.groupBy({
          by: ['month', 'isStarred'],
          where: { programId, year, ...PAYER_KINDS.enrolled },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        this.prisma.payment.groupBy({
          by: ['month'],
          where: { programId, year, ...PAYER_KINDS.programs },
          _sum: { amount: true },
          _count: { _all: true },
        }),
      ]);
      for (const row of enrolled) {
        if (row.month === null) continue;
        const month = months[row.month - 1];
        if (row.isStarred) month.starredCount = row._count._all;
        else {
          month.enrolled = row._sum.amount ?? ZERO;
          month.paidCount = row._count._all;
          month.entryCount += row._count._all;
        }
      }
      for (const row of programs) {
        if (row.month !== null) {
          const month = months[row.month - 1];
          month.programs = row._sum.amount ?? ZERO;
          month.entryCount += row._count._all;
        }
      }
      return months;
    }

    await Promise.all(
      (Object.keys(PAYER_KINDS) as PayerKind[]).map(async (kind) => {
        const rows = await this.prisma.payment.groupBy({
          by: ['paymentDate'],
          where: { programId, year, ...PAYER_KINDS[kind] },
          _sum: { amount: true },
          _count: { _all: true },
        });
        for (const row of rows) {
          if (!row.paymentDate) continue;
          const month = months[row.paymentDate.getUTCMonth()];
          month[kind] = month[kind].plus(row._sum.amount ?? ZERO);
          month.entryCount += row._count._all;
          if (kind === 'enrolled') month.paidCount += row._count._all;
        }
      }),
    );
    return months;
  }
}
