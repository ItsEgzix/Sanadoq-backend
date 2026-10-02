import { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { EradatArrearsService } from '../eradat-arrears.service';

const d = (value: number) => new Prisma.Decimal(value);
const OCT_2026 = new Date('2026-10-02T09:00:00.000Z');

describe('EradatArrearsService', () => {
  const mockPrisma = {
    programEnrollment: { findMany: jest.fn() },
    payment: { groupBy: jest.fn() },
  };
  let service: EradatArrearsService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new EradatArrearsService(mockPrisma as unknown as PrismaService);
  });

  it('lists only the active subscribers short of the year so far, with how much', async () => {
    mockPrisma.programEnrollment.findMany.mockResolvedValue([
      { id: 'e-none', contributorId: 'c1', expectedRate: d(12000) }, // paid nothing
      { id: 'e-some', contributorId: 'c2', expectedRate: d(12000) }, // paid 6,000
      { id: 'e-up', contributorId: 'c3', expectedRate: d(12000) }, // paid 9,000
      { id: 'e-ahead', contributorId: 'c4', expectedRate: d(1200) }, // paid the year
    ]);
    mockPrisma.payment.groupBy.mockResolvedValue([
      { contributorId: 'c2', _sum: { amount: d(6000) } },
      { contributorId: 'c3', _sum: { amount: d(9000) } },
      { contributorId: 'c4', _sum: { amount: d(1200) } },
    ]);

    const result = await service.loadArrears('fund', 2026, OCT_2026);

    expect(result.monthsDue).toBe(9);
    expect(
      [...result.behind].map(([id, short]) => [id, short.toFixed(2)]),
    ).toEqual([
      ['e-none', '9000.00'],
      ['e-some', '3000.00'],
    ]);
    // Dormant and zero-pledge enrollments are never read as behind.
    expect(mockPrisma.programEnrollment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          programId: 'fund',
          status: 'ACTIVE',
          expectedRate: { gt: 0 },
        },
      }),
    );
    // Only this program's money in this year, from contributors.
    expect(mockPrisma.payment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { programId: 'fund', year: 2026, contributorId: { not: null } },
      }),
    );
  });

  it('reads nothing for a year with no month over yet — nobody can be behind', async () => {
    const result = await service.loadArrears('fund', 2027, OCT_2026);

    expect(result).toEqual({ monthsDue: 0, behind: new Map() });
    expect(mockPrisma.programEnrollment.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.payment.groupBy).not.toHaveBeenCalled();
  });

  it('owes a past year in full', async () => {
    mockPrisma.programEnrollment.findMany.mockResolvedValue([
      { id: 'e1', contributorId: 'c1', expectedRate: d(12000) },
    ]);
    mockPrisma.payment.groupBy.mockResolvedValue([
      { contributorId: 'c1', _sum: { amount: d(11000) } },
    ]);

    const result = await service.loadArrears(
      'fund',
      2026,
      new Date('2027-03-15T00:00:00.000Z'),
    );

    expect(result.monthsDue).toBe(12);
    expect(result.behind.get('e1')?.toFixed(2)).toBe('1000.00');
  });
});
