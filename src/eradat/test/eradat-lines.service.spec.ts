import { Prisma } from '../../../generated/prisma/client';
import type { EnrollmentService } from '../../enrollments/enrollment.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { EradatArrearsService } from '../eradat-arrears.service';
import { EradatLinesService } from '../eradat-lines.service';
import type { EradatWindowService } from '../eradat-window.service';

const d = (value: number) => new Prisma.Decimal(value);

const WINDOW = {
  program: { id: 'fund', name: 'اشتراكات الصندوق', entryMode: 'MONTHLY' },
  cycle: { startYear: 2026, endYear: 2029 },
  year: 2026,
  years: [2026, 2027, 2028, 2029],
  runningYears: [2026, 2027, 2028, 2029],
};
const ROW = (id: string, contributorId: string, status = 'ACTIVE') => ({
  id,
  contributorId,
  programId: 'fund',
  expectedRate: d(12000),
  previousSubscription: d(0),
  status,
});
const withContributor = <T extends { contributorId: string }>(row: T) => ({
  ...row,
  contributor: { id: row.contributorId, name: 'x', accountNumber: '0203002' },
});

describe('EradatLinesService.getEnrollmentLines', () => {
  const mockPrisma = { payment: { findMany: jest.fn(), groupBy: jest.fn() } };
  const mockWindow = { resolve: jest.fn() };
  const mockEnrollments = {
    listEnrollmentPage: jest.fn(),
    attachContributors: jest.fn(),
  };
  const mockArrears = { loadArrears: jest.fn() };
  let service: EradatLinesService;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-10-02T09:00:00.000Z'));
    mockWindow.resolve.mockResolvedValue(WINDOW);
    mockEnrollments.attachContributors.mockImplementation(
      (rows: Array<{ contributorId: string }>) =>
        Promise.resolve(rows.map(withContributor)),
    );
    mockPrisma.payment.findMany.mockResolvedValue([]);
    service = new EradatLinesService(
      mockPrisma as unknown as PrismaService,
      mockWindow as unknown as EradatWindowService,
      mockEnrollments as unknown as EnrollmentService,
      mockArrears as unknown as EradatArrearsService,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('pages only the enrollments behind on the resolved year, in the usual order', async () => {
    mockArrears.loadArrears.mockResolvedValue({
      monthsDue: 9,
      behind: new Map([
        ['e1', d(9000)],
        ['e3', d(3000)],
      ]),
    });
    mockEnrollments.listEnrollmentPage.mockResolvedValue({
      rows: [ROW('e1', 'c1'), ROW('e3', 'c3')],
      nextCursor: null,
    });
    mockPrisma.payment.findMany.mockResolvedValue([
      {
        contributorId: 'c3',
        year: 2026,
        month: 2,
        isStarred: false,
        amount: d(6000),
      },
    ]);

    const result = await service.getEnrollmentLines('fund', {
      limit: 50,
      behind: true,
    });

    expect(mockArrears.loadArrears).toHaveBeenCalledWith(
      'fund',
      2026,
      expect.any(Date),
    );
    expect(mockEnrollments.listEnrollmentPage).toHaveBeenCalledWith(
      'fund',
      { limit: 50 },
      ['e1', 'e3'],
    );
    // Each line's arrears come from the same rule, from its own cells.
    expect(result.items.map((line) => [line.id, line.arrears])).toEqual([
      ['e1', '9000.00'],
      ['e3', '3000.00'],
    ]);
  });

  it('answers an empty page without reading enrollments when nobody is behind', async () => {
    mockArrears.loadArrears.mockResolvedValue({
      monthsDue: 9,
      behind: new Map(),
    });

    const result = await service.getEnrollmentLines('fund', {
      limit: 50,
      behind: true,
    });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(mockEnrollments.listEnrollmentPage).not.toHaveBeenCalled();
  });

  it('lists nobody as behind on a temporary program, which keeps no pledges', async () => {
    mockWindow.resolve.mockResolvedValue({
      ...WINDOW,
      program: { ...WINDOW.program, entryMode: 'DATED' },
      cycle: null,
    });

    const result = await service.getEnrollmentLines('camp', {
      limit: 50,
      behind: true,
    });

    expect(result.items).toEqual([]);
    expect(mockArrears.loadArrears).not.toHaveBeenCalled();
  });

  it('shows every line unfiltered, with its arrears, and none for a dormant one', async () => {
    mockEnrollments.listEnrollmentPage.mockResolvedValue({
      rows: [ROW('e1', 'c1'), ROW('e2', 'c2', 'DORMANT')],
      nextCursor: null,
    });

    const result = await service.getEnrollmentLines('fund', { limit: 50 });

    expect(mockArrears.loadArrears).not.toHaveBeenCalled();
    expect(mockEnrollments.listEnrollmentPage).toHaveBeenCalledWith('fund', {
      limit: 50,
    });
    expect(result.items.map((line) => [line.id, line.arrears])).toEqual([
      ['e1', '9000.00'],
      ['e2', null],
    ]);
  });

  it('adds what each member paid in earlier cycles to their running total', async () => {
    mockWindow.resolve.mockResolvedValue({
      ...WINDOW,
      year: 2030,
      years: [2030, 2031, 2032],
      runningYears: [2026, 2027, 2028, 2029, 2030, 2031, 2032],
    });
    mockEnrollments.listEnrollmentPage.mockResolvedValue({
      rows: [{ ...ROW('e1', 'c1'), previousSubscription: d(79600) }],
      nextCursor: null,
    });
    mockPrisma.payment.groupBy.mockResolvedValue([
      { contributorId: 'c1', _sum: { amount: d(6000) } },
    ]);
    mockPrisma.payment.findMany.mockResolvedValue([
      {
        contributorId: 'c1',
        year: 2030,
        month: 1,
        isStarred: false,
        amount: d(500),
      },
    ]);

    const result = await service.getEnrollmentLines('fund', { limit: 50 });

    // Only the years before the current cycle, summed in SQL.
    expect(mockPrisma.payment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          programId: 'fund',
          year: { gte: 2026, lt: 2030 },
          contributorId: { in: ['c1'] },
        },
      }),
    );
    // 79,600 typed previous + 6,000 from the last cycle + 500 this cycle.
    expect(result.items[0].runningTotal).toBe('86100.00');
  });

  it('skips the earlier-cycles read while the current cycle is the first', async () => {
    mockEnrollments.listEnrollmentPage.mockResolvedValue({
      rows: [ROW('e1', 'c1')],
      nextCursor: null,
    });

    await service.getEnrollmentLines('fund', { limit: 50 });

    expect(mockPrisma.payment.groupBy).not.toHaveBeenCalled();
  });
});
