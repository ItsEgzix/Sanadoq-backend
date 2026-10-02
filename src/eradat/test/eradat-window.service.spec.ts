import type { CycleService } from '../../cycles/cycle.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { EradatWindowService } from '../eradat-window.service';

const cycle = (startYear: number, endYear: number) => ({
  startYear,
  endYear,
  years: Array.from(
    { length: endYear - startYear + 1 },
    (_, index) => startYear + index,
  ),
});

describe('EradatWindowService', () => {
  const mockPrisma = {
    payment: { groupBy: jest.fn() },
    cycle: { aggregate: jest.fn() },
  };
  const mockCycles = { resolveWindow: jest.fn() };
  let service: EradatWindowService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockPrisma.payment.groupBy.mockResolvedValue([]);
    service = new EradatWindowService(
      mockPrisma as unknown as PrismaService,
      mockCycles as unknown as CycleService,
    );
  });

  it('runs the totals from the program’s first cycle through the current one', async () => {
    mockCycles.resolveWindow.mockResolvedValue({
      program: {},
      cycle: cycle(2030, 2032),
      year: 2030,
    });
    mockPrisma.cycle.aggregate.mockResolvedValue({
      _min: { startYear: 2026 },
    });

    const window = await service.resolve('fund');

    expect(window.years).toEqual([2030, 2031, 2032]);
    expect(window.runningYears).toEqual([
      2026, 2027, 2028, 2029, 2030, 2031, 2032,
    ]);
  });

  it('leaves out cycles after the current one', async () => {
    mockCycles.resolveWindow.mockResolvedValue({
      program: {},
      cycle: cycle(2026, 2029),
      year: 2026,
    });
    // The program's cycles start in 2026; a later 2030–2032 is ahead.
    mockPrisma.cycle.aggregate.mockResolvedValue({
      _min: { startYear: 2026 },
    });

    const window = await service.resolve('fund');

    expect(window.runningYears).toEqual([2026, 2027, 2028, 2029]);
  });

  it('runs a program without cycles over every year it has payments in', async () => {
    mockCycles.resolveWindow.mockResolvedValue({
      program: {},
      cycle: null,
      year: 2026,
    });
    mockPrisma.payment.groupBy.mockResolvedValue([{ year: 2024 }]);
    mockPrisma.cycle.aggregate.mockResolvedValue({ _min: { startYear: null } });

    const window = await service.resolve('camp');

    expect(window.years).toEqual([2024, 2026]);
    expect(window.runningYears).toEqual([2024, 2026]);
  });
});
