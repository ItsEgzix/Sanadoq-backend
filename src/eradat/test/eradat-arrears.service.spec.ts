import { Prisma } from '../../../generated/prisma/client';
import type { EnrollmentTermService } from '../../enrollments/enrollment-term.service';
import type { TermRow } from '../../enrollments/enrollment-term.util';
import type { PrismaService } from '../../prisma/prisma.service';
import { EradatArrearsService } from '../eradat-arrears.service';

const d = (value: number) => new Prisma.Decimal(value);
const OCT_2026 = new Date('2026-10-02T09:00:00.000Z');

const term = (
  fromYear: number,
  fromMonth: number,
  status: TermRow['status'],
  rate: number,
): TermRow => ({ fromYear, fromMonth, status, expectedRate: d(rate) });

describe('EradatArrearsService', () => {
  const mockPrisma = {
    programEnrollment: { findMany: jest.fn() },
    payment: { groupBy: jest.fn() },
  };
  const mockTerms = { loadTerms: jest.fn() };
  let service: EradatArrearsService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockTerms.loadTerms.mockResolvedValue(new Map());
    mockPrisma.payment.groupBy.mockResolvedValue([]);
    service = new EradatArrearsService(
      mockPrisma as unknown as PrismaService,
      mockTerms as unknown as EnrollmentTermService,
    );
  });

  const enrollment = (
    id: string,
    contributorId: string,
    rate: number,
    status: 'ACTIVE' | 'DORMANT' = 'ACTIVE',
  ) => ({ id, contributorId, status, expectedRate: d(rate) });

  it('lists the subscribers short of the year so far, with how much', async () => {
    mockPrisma.programEnrollment.findMany.mockResolvedValue([
      enrollment('e-none', 'c1', 12000), // paid nothing
      enrollment('e-some', 'c2', 12000), // paid 6,000
      enrollment('e-up', 'c3', 12000), // paid 9,000
      enrollment('e-ahead', 'c4', 1200), // paid the year
      enrollment('e-zero', 'c5', 0), // no pledge
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
    // Only this program's money in this year, from contributors.
    expect(mockPrisma.payment.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { programId: 'fund', year: 2026, contributorId: { not: null } },
      }),
    );
  });

  it('reads each subscription by its terms: frozen from January owes nothing, frozen from May still owes January–April', async () => {
    mockPrisma.programEnrollment.findMany.mockResolvedValue([
      enrollment('e-jan', 'c1', 12000, 'DORMANT'),
      enrollment('e-may', 'c2', 12000, 'DORMANT'),
      enrollment('e-june', 'c3', 12000),
    ]);
    mockTerms.loadTerms.mockResolvedValue(
      new Map([
        [
          'e-jan',
          [term(2010, 1, 'ACTIVE', 12000), term(2026, 1, 'DORMANT', 12000)],
        ],
        [
          'e-may',
          [term(2010, 1, 'ACTIVE', 12000), term(2026, 5, 'DORMANT', 12000)],
        ],
        // Joined in June: owes June–September.
        ['e-june', [term(2026, 6, 'ACTIVE', 12000)]],
      ]),
    );

    const result = await service.loadArrears('fund', 2026, OCT_2026);

    expect(mockTerms.loadTerms).toHaveBeenCalledWith(
      { programId: 'fund' },
      2026,
    );
    expect(
      [...result.behind].map(([id, short]) => [id, short.toFixed(2)]),
    ).toEqual([
      ['e-may', '4000.00'],
      ['e-june', '4000.00'],
    ]);
    // The year's expected total counts the same months: 0 + 4 + 7 months.
    expect(result.expectedTotal.toFixed(2)).toBe('11000.00');
  });

  it("totals the year's pledges whether or not a month is due yet", async () => {
    mockPrisma.programEnrollment.findMany.mockResolvedValue([
      enrollment('e1', 'c1', 6000),
      enrollment('e2', 'c2', 1200),
    ]);

    const result = await service.loadArrears('fund', 2027, OCT_2026);

    expect(result.monthsDue).toBe(0);
    expect(result.behind.size).toBe(0);
    expect(result.expectedTotal.toFixed(2)).toBe('7200.00');
  });

  it('owes a past year in full', async () => {
    mockPrisma.programEnrollment.findMany.mockResolvedValue([
      enrollment('e1', 'c1', 12000),
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
