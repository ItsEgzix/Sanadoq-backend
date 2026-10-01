import { Injectable } from '@nestjs/common';
import type { Prisma } from 'generated/prisma/client';
import {
  sumMoney,
  toMoneyString,
  toRatioString,
  ZERO,
} from 'src/common/utils/money.util';
import type { EntryMode } from 'src/programs/program.util';
import { PrismaService } from 'src/prisma/prisma.service';
import type { EradatYearQueryDto } from './dto/eradat-year-query.dto';
import { EradatWindowService } from './eradat-window.service';
import { collectionRatio, runningTotal } from './revenue.util';

// Every revenue figure below is filtered on `programId` — the receiving
// program — and split by who paid. A payment this program *made* to another
// (payerProgramId = this program) is never among them: it is reported
// separately as an outflow and never subtracted, since there is no Expenses
// module to book it against yet (see the TODO on Payment.payerProgramId).
const PAYER_KINDS = {
  enrolled: { personId: { not: null } },
  programs: { payerProgramId: { not: null } },
  oneOff: { payerNameFreetext: { not: null } },
} satisfies Record<string, Prisma.PaymentWhereInput>;

type PayerKind = keyof typeof PAYER_KINDS;
type KindTotals = Record<PayerKind, Prisma.Decimal>;

interface MonthTotals extends KindTotals {
  // Unstarred payments by enrolled people that month, and stars.
  paidCount: number;
  starredCount: number;
}

const emptyKindTotals = (): KindTotals => ({
  enrolled: ZERO,
  programs: ZERO,
  oneOff: ZERO,
});

const kindTotal = (totals: KindTotals) =>
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
 * One program's figures for one year: pledges against pledge-backed
 * collections, revenue split by payer kind, month and year totals, running
 * totals, and the outflows to other programs. Sums run in SQL, so the cost is
 * flat in the number of enrollments; they agree with revenue.util because a
 * star's amount is NULL by constraint.
 */
@Injectable()
export class EradatSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly windowService: EradatWindowService,
  ) {}

  async getSummary(programId: string, { year: requested }: EradatYearQueryDto) {
    const window = await this.windowService.resolve(programId, requested);
    const { program, year, years } = window;

    const [pledges, statusCounts, yearTotals, months, transfersOut] =
      await Promise.all([
        this.prisma.programEnrollment.aggregate({
          where: { programId },
          _sum: { expectedRate: true, previousSubscription: true },
        }),
        this.prisma.programEnrollment.groupBy({
          by: ['status'],
          where: { programId },
          _count: { _all: true },
        }),
        this.loadYearTotals(programId, years),
        this.loadMonthTotals(programId, year, program.entryMode),
        this.loadTransfersOut(programId, year),
      ]);

    const selected = yearTotals.get(year) ?? emptyKindTotals();
    const windowTotals = years.map(
      (windowYear) => yearTotals.get(windowYear) ?? emptyKindTotals(),
    );
    // Dormant enrollments still count toward expected: their pledge stands
    // until the fund confirms otherwise (an open question).
    const expectedTotal = pledges._sum.expectedRate ?? ZERO;
    const previousSubscriptionTotal = pledges._sum.previousSubscription ?? ZERO;
    const countOf = (status: 'ACTIVE' | 'DORMANT') =>
      statusCounts.find((row) => row.status === status)?._count._all ?? 0;

    return {
      program,
      cycle: window.cycle,
      year,
      years,
      counts: {
        enrollments: countOf('ACTIVE') + countOf('DORMANT'),
        active: countOf('ACTIVE'),
        dormant: countOf('DORMANT'),
      },
      collection: {
        expectedTotal: toMoneyString(expectedTotal),
        pledgedTotal: toMoneyString(selected.enrolled),
        ratio: toRatioString(collectionRatio(expectedTotal, selected.enrolled)),
      },
      revenue: toKindView(selected),
      transfersOut,
      months: months.map((month, index) => ({
        month: index + 1,
        ...toKindView(month),
        paidCount: month.paidCount,
        starredCount: month.starredCount,
      })),
      yearTotals: years.map((windowYear, index) => ({
        year: windowYear,
        ...toKindView(windowTotals[index]),
      })),
      running: {
        previousSubscriptionTotal: toMoneyString(previousSubscriptionTotal),
        // Summing every enrollment's running total gives the same figure,
        // since each is its previous subscription plus its window payments.
        enrolledRunningTotal: toMoneyString(
          runningTotal(
            previousSubscriptionTotal,
            windowTotals.map((totals) => totals.enrolled),
          ),
        ),
        revenueRunningTotal: toMoneyString(
          runningTotal(previousSubscriptionTotal, windowTotals.map(kindTotal)),
        ),
      },
    };
  }

  // Window totals per year, split by payer kind.
  private async loadYearTotals(
    programId: string,
    years: readonly number[],
  ): Promise<Map<number, KindTotals>> {
    const range = { gte: years[0], lte: years[years.length - 1] };
    const byYear = new Map<number, KindTotals>();
    await Promise.all(
      (Object.keys(PAYER_KINDS) as PayerKind[]).map(async (kind) => {
        const rows = await this.prisma.payment.groupBy({
          by: ['year'],
          where: { programId, year: range, ...PAYER_KINDS[kind] },
          _sum: { amount: true },
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
        }),
      ]);
      for (const row of enrolled) {
        if (row.month === null) continue;
        const month = months[row.month - 1];
        if (row.isStarred) month.starredCount = row._count._all;
        else {
          month.enrolled = row._sum.amount ?? ZERO;
          month.paidCount = row._count._all;
        }
      }
      for (const row of programs) {
        if (row.month !== null) {
          months[row.month - 1].programs = row._sum.amount ?? ZERO;
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
          if (kind === 'enrolled') month.paidCount += row._count._all;
        }
      }),
    );
    return months;
  }

  // What this program paid to others in `year` — informational only.
  private async loadTransfersOut(programId: string, year: number) {
    const rows = await this.prisma.payment.groupBy({
      by: ['programId'],
      where: { payerProgramId: programId, year },
      _sum: { amount: true },
    });
    // The unfiltered client on purpose: a receiving program deleted since
    // must still be named, because the money did leave.
    const names = await this.prisma.raw.program.findMany({
      where: { id: { in: rows.map((row) => row.programId) } },
      select: { id: true, name: true },
    });
    const programs = rows.map((row) => ({
      programId: row.programId,
      name: names.find((p) => p.id === row.programId)?.name ?? '',
      total: toMoneyString(row._sum.amount),
    }));
    return {
      total: toMoneyString(sumMoney(rows.map((row) => row._sum.amount))),
      programs,
    };
  }
}
