import { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { EradatArrearsService } from '../eradat-arrears.service';
import { EradatSummaryService } from '../eradat-summary.service';
import type { EradatWindowService } from '../eradat-window.service';

const d = (value: number) => new Prisma.Decimal(value);

type Where = Record<string, unknown>;

// A payment table the mock answers groupBy() from, so each test states the
// books and the assertions read like the sheet.
interface FakePayment {
  programId: string;
  payer: 'contributor' | 'program' | 'freetext';
  payerProgramId?: string;
  year: number;
  month: number | null;
  paymentDate?: Date;
  amount: number | null;
  isStarred?: boolean;
}

function matches(payment: FakePayment, where: Where): boolean {
  if ('programId' in where && where.programId !== payment.programId)
    return false;
  if ('payerProgramId' in where) {
    const filter = where.payerProgramId;
    if (typeof filter === 'string' && filter !== payment.payerProgramId)
      return false;
    if (typeof filter === 'object' && payment.payer !== 'program') return false;
  }
  if ('contributorId' in where && payment.payer !== 'contributor') return false;
  if ('payerNameFreetext' in where && payment.payer !== 'freetext')
    return false;
  const year = where.year as number | { gte: number; lte: number };
  if (typeof year === 'number' && year !== payment.year) return false;
  if (
    typeof year === 'object' &&
    (payment.year < year.gte || payment.year > year.lte)
  )
    return false;
  return true;
}

function fakeGroupBy(payments: FakePayment[]) {
  return ({ by, where }: { by: string[]; where: Where }) => {
    const groups = new Map<
      string,
      { key: Record<string, unknown>; sum: Prisma.Decimal; count: number }
    >();
    for (const payment of payments.filter((p) => matches(p, where))) {
      const key: Record<string, unknown> = {};
      for (const field of by) {
        key[field] =
          field === 'isStarred'
            ? (payment.isStarred ?? false)
            : (payment as unknown as Record<string, unknown>)[field];
      }
      const id = JSON.stringify(key);
      const group = groups.get(id) ?? { key, sum: d(0), count: 0 };
      group.sum =
        payment.amount === null ? group.sum : group.sum.plus(payment.amount);
      group.count += 1;
      groups.set(id, group);
    }
    return Promise.resolve(
      [...groups.values()].map((g) => ({
        ...g.key,
        _sum: { amount: g.sum },
        _count: { _all: g.count },
      })),
    );
  };
}

const FUND_WINDOW = {
  program: {
    id: 'fund',
    name: 'اشتراكات الصندوق',
    type: 'PERIODIC' as const,
    isProtected: true,
    sortOrder: 0,
    hasCycles: true,
    entryMode: 'MONTHLY' as const,
    currentCycle: null,
  },
  cycle: null,
  year: 2026,
  years: [2026, 2027, 2028, 2029],
  runningYears: [2026, 2027, 2028, 2029],
};

describe('EradatSummaryService', () => {
  const groupBy = jest.fn();
  const mockPrisma = {
    programEnrollment: {
      aggregate: jest.fn(),
      groupBy: jest.fn(),
    },
    payment: { groupBy },
    raw: { program: { findMany: jest.fn() } },
  };
  const mockWindow = { resolve: jest.fn() };
  const mockArrears = { loadArrears: jest.fn() };
  let service: EradatSummaryService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockWindow.resolve.mockResolvedValue(FUND_WINDOW);
    mockArrears.loadArrears.mockResolvedValue({
      monthsDue: 9,
      behind: new Map([
        ['e1', d(4500)],
        ['e2', d(250.5)],
      ]),
    });
    mockPrisma.programEnrollment.aggregate.mockResolvedValue({
      _sum: { expectedRate: d(12000), previousSubscription: d(5000) },
    });
    mockPrisma.programEnrollment.groupBy.mockResolvedValue([
      { status: 'ACTIVE', _count: { _all: 2 } },
    ]);
    mockPrisma.raw.program.findMany.mockResolvedValue([
      { id: 'camp', name: 'حملة' },
      { id: 'mwa', name: 'مواساة' },
    ]);
    service = new EradatSummaryService(
      mockPrisma as unknown as PrismaService,
      mockWindow as unknown as EradatWindowService,
      mockArrears as unknown as EradatArrearsService,
    );
  });

  it('reports how many are behind on the year and the total عجز — the list the grid filter shows', async () => {
    groupBy.mockImplementation(fakeGroupBy([]));

    const summary = await service.getSummary('fund', { year: 2026 });

    expect(mockArrears.loadArrears).toHaveBeenCalledWith('fund', 2026);
    expect(summary.arrears).toEqual({
      monthsDue: 9,
      count: 2,
      total: '4750.50',
    });
  });

  it('has no arrears on a temporary program, which keeps no pledges', async () => {
    mockWindow.resolve.mockResolvedValue({
      ...FUND_WINDOW,
      program: { ...FUND_WINDOW.program, id: 'camp', entryMode: 'DATED' },
      years: [2026],
    });
    groupBy.mockImplementation(fakeGroupBy([]));

    const summary = await service.getSummary('camp', { year: 2026 });

    expect(summary.arrears).toBeNull();
    expect(mockArrears.loadArrears).not.toHaveBeenCalled();
  });

  it('never counts money the fund paid out as fund revenue or toward its ratio', async () => {
    groupBy.mockImplementation(
      fakeGroupBy([
        {
          programId: 'fund',
          payer: 'contributor',
          year: 2026,
          month: 1,
          amount: 3000,
        },
        {
          programId: 'fund',
          payer: 'contributor',
          year: 2026,
          month: 2,
          amount: null,
          isStarred: true,
        },
        // The fund paying others: rows on the receivers' side.
        {
          programId: 'camp',
          payer: 'program',
          payerProgramId: 'fund',
          year: 2026,
          month: null,
          amount: 5000,
        },
        {
          programId: 'mwa',
          payer: 'program',
          payerProgramId: 'fund',
          year: 2026,
          month: 1,
          amount: 9000,
        },
      ]),
    );

    const summary = await service.getSummary('fund', { year: 2026 });

    expect(summary.revenue).toEqual({
      fromEnrolled: '3000.00',
      fromPrograms: '0.00',
      fromOneOff: '0.00',
      total: '3000.00',
    });
    expect(summary.collection).toEqual({
      expectedTotal: '12000.00',
      pledgedTotal: '3000.00',
      ratio: '4.0000',
    });
    expect(summary.transfersOut.total).toBe('14000.00');
    // Every revenue query filters on the receiving program, never the payer.
    const revenueQueries = groupBy.mock.calls
      .map(([args]) => args.where as Where)
      .filter(
        (where) =>
          !(
            'payerProgramId' in where &&
            typeof where.payerProgramId === 'string'
          ),
      );
    expect(revenueQueries.every((where) => where.programId === 'fund')).toBe(
      true,
    );
  });

  it('counts a transfer in and a stranger’s gift as revenue, but not as pledged collection', async () => {
    mockWindow.resolve.mockResolvedValue({
      ...FUND_WINDOW,
      program: { ...FUND_WINDOW.program, id: 'camp', entryMode: 'DATED' },
      years: [2026],
    });
    groupBy.mockImplementation(
      fakeGroupBy([
        {
          programId: 'camp',
          payer: 'freetext',
          year: 2026,
          month: null,
          paymentDate: new Date('2026-03-01T00:00:00Z'),
          amount: 250,
        },
        {
          programId: 'camp',
          payer: 'program',
          payerProgramId: 'fund',
          year: 2026,
          month: null,
          paymentDate: new Date('2026-03-02T00:00:00Z'),
          amount: 5000,
        },
      ]),
    );
    mockPrisma.programEnrollment.aggregate.mockResolvedValue({
      _sum: { expectedRate: null, previousSubscription: null },
    });

    const summary = await service.getSummary('camp', { year: 2026 });

    expect(summary.revenue).toMatchObject({
      fromPrograms: '5000.00',
      fromOneOff: '250.00',
      total: '5250.00',
    });
    expect(summary.collection.ratio).toBeNull();
    expect(summary.months[2].total).toBe('5250.00'); // March, folded from dates
    // Both are gifts, though neither payer is an enrolled contributor.
    expect(summary.months[2]).toMatchObject({ paidCount: 0, entryCount: 2 });
  });

  it('reports stars per month without adding them to any total', async () => {
    groupBy.mockImplementation(
      fakeGroupBy([
        {
          programId: 'fund',
          payer: 'contributor',
          year: 2026,
          month: 3,
          amount: 1200,
        },
        {
          programId: 'fund',
          payer: 'contributor',
          year: 2026,
          month: 4,
          amount: null,
          isStarred: true,
        },
        {
          programId: 'fund',
          payer: 'contributor',
          year: 2026,
          month: 4,
          amount: null,
          isStarred: true,
        },
      ]),
    );

    const summary = await service.getSummary('fund', { year: 2026 });

    expect(summary.months[2]).toMatchObject({
      fromEnrolled: '1200.00',
      paidCount: 1,
      entryCount: 1,
    });
    expect(summary.months[3]).toMatchObject({
      total: '0.00',
      starredCount: 2,
      entryCount: 0,
    });
    expect(summary.running.enrolledRunningTotal).toBe('6200.00'); // 5000 previous + 1200
  });

  it('keeps earlier cycles in the running totals after a new cycle becomes current', async () => {
    mockWindow.resolve.mockResolvedValue({
      ...FUND_WINDOW,
      year: 2030,
      years: [2030, 2031, 2032],
      runningYears: [2026, 2027, 2028, 2029, 2030, 2031, 2032],
    });
    groupBy.mockImplementation(
      fakeGroupBy([
        // Paid in the previous cycle.
        {
          programId: 'fund',
          payer: 'contributor',
          year: 2027,
          month: 3,
          amount: 6000,
        },
        // Paid in the current one.
        {
          programId: 'fund',
          payer: 'contributor',
          year: 2030,
          month: 1,
          amount: 500,
        },
      ]),
    );

    const summary = await service.getSummary('fund', { year: 2030 });

    // 5000 typed previous + 6000 from 2027 + 500 from 2030.
    expect(summary.running.enrolledRunningTotal).toBe('11500.00');
    expect(summary.running.revenueRunningTotal).toBe('11500.00');
    // The year cards stay on the current cycle.
    expect(summary.yearTotals.map((entry) => entry.year)).toEqual([
      2030, 2031, 2032,
    ]);
  });
});
