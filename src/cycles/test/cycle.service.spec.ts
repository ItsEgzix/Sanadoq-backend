import type { ProgramService } from '../../programs/program.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { CycleService } from '../cycle.service';

const mockPrisma = {
  $transaction: jest.fn(),
  cycle: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  payment: { count: jest.fn() },
};
const mockProgramService = { assertProgramExists: jest.fn() };

const CYCLE_2026 = {
  id: 'c-2026',
  programId: 'fund',
  startYear: 2026,
  lengthYears: 4,
  endYear: 2029,
  isCurrent: true,
};
const program = (overrides: Record<string, unknown> = {}) => ({
  id: 'fund',
  name: 'اشتراكات الصندوق',
  type: 'PERIODIC',
  hasCycles: true,
  isProtected: true,
  sortOrder: 0,
  cycles: [CYCLE_2026],
  ...overrides,
});

describe('CycleService', () => {
  let service: CycleService;

  beforeEach(() => {
    jest.resetAllMocks();
    // Interactive transactions run their callback against the same mock.
    mockPrisma.$transaction.mockImplementation(
      (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma),
    );
    mockProgramService.assertProgramExists.mockResolvedValue(program());
    service = new CycleService(
      mockPrisma as unknown as PrismaService,
      mockProgramService as unknown as ProgramService,
    );
  });

  describe('resolveWindow', () => {
    it('opens on the requested year inside the current cycle', async () => {
      const window = await service.resolveWindow('fund', 2027);
      expect(window.year).toBe(2027);
      expect(window.cycle?.years).toEqual([2026, 2027, 2028, 2029]);
    });

    it('rejects a year outside the cycle — the fence around unconfirmed advance payments', async () => {
      await expect(service.resolveWindow('fund', 2030)).rejects.toMatchObject({
        errorCode: 'CYCLE_YEAR_OUT_OF_RANGE',
      });
    });

    it('404s a program with cycles but no current one', async () => {
      mockProgramService.assertProgramExists.mockResolvedValue(
        program({ cycles: [] }),
      );
      await expect(service.resolveWindow('fund')).rejects.toMatchObject({
        errorCode: 'CYCLE_CURRENT_NOT_FOUND',
      });
    });

    it('accepts any year for a program without cycles — there is no boundary', async () => {
      mockProgramService.assertProgramExists.mockResolvedValue(
        program({ hasCycles: false, type: 'TEMPORARY', cycles: [] }),
      );
      const window = await service.resolveWindow('camp', 2015);
      expect(window).toMatchObject({ cycle: null, year: 2015 });
    });
  });

  describe('createCycle', () => {
    it('makes a program’s first cycle current, scoped to that program', async () => {
      mockPrisma.cycle.findFirst.mockResolvedValue(null);
      mockPrisma.cycle.count.mockResolvedValue(0);
      mockPrisma.cycle.create.mockResolvedValue({
        ...CYCLE_2026,
        lengthYears: 3,
        endYear: 2028,
      });

      const result = await service.createCycle('fund', {
        startYear: 2026,
        lengthYears: 3,
      });

      expect(mockPrisma.cycle.count).toHaveBeenCalledWith({
        where: { programId: 'fund', isCurrent: true },
      });
      expect(mockPrisma.cycle.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            programId: 'fund',
            startYear: 2026,
            lengthYears: 3,
            endYear: 2028,
            isCurrent: true,
          },
        }),
      );
      expect(result).toMatchObject({
        years: [2026, 2027, 2028],
        successCode: 'CYCLE_CREATE_SUCCESS',
      });
    });

    it('checks overlap only against the same program’s cycles', async () => {
      mockPrisma.cycle.findFirst.mockResolvedValue({
        startYear: 2026,
        endYear: 2029,
      });

      await expect(
        service.createCycle('fund', { startYear: 2028, lengthYears: 3 }),
      ).rejects.toMatchObject({ errorCode: 'CYCLE_OVERLAP' });
      expect(mockPrisma.cycle.findFirst.mock.calls[0][0].where.programId).toBe(
        'fund',
      );
      expect(mockPrisma.cycle.create).not.toHaveBeenCalled();
    });

    it('refuses a program that runs without cycles', async () => {
      mockProgramService.assertProgramExists.mockResolvedValue(
        program({ hasCycles: false, cycles: [] }),
      );
      await expect(
        service.createCycle('camp', { startYear: 2026, lengthYears: 1 }),
      ).rejects.toMatchObject({ errorCode: 'PROGRAM_HAS_NO_CYCLES' });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('updateCycle', () => {
    it('refuses to shorten a cycle when that would strand payments, and changes nothing', async () => {
      mockPrisma.cycle.findFirst
        .mockResolvedValueOnce(CYCLE_2026) // findCycleOrThrow
        .mockResolvedValueOnce(null); // no overlap
      mockPrisma.payment.count.mockResolvedValue(12);

      await expect(
        service.updateCycle('fund', 'c-2026', { lengthYears: 3 }),
      ).rejects.toMatchObject({
        errorCode: 'CYCLE_RANGE_STRANDS_PAYMENTS',
        meta: { count: 12 },
      });
      expect(mockPrisma.payment.count.mock.calls[0][0].where.programId).toBe(
        'fund',
      );
      expect(mockPrisma.cycle.update).not.toHaveBeenCalled();
    });

    it('404s a cycle id that belongs to another program', async () => {
      mockPrisma.cycle.findFirst.mockResolvedValue(null);
      await expect(
        service.updateCycle('fund', 'someone-elses', { lengthYears: 3 }),
      ).rejects.toMatchObject({ errorCode: 'CYCLE_NOT_FOUND' });
      expect(mockPrisma.cycle.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'someone-elses', programId: 'fund' },
        }),
      );
    });
  });

  describe('activateCycle', () => {
    it('demotes the program’s old current cycle before promoting, so the per-program index never sees two', async () => {
      mockPrisma.cycle.findFirst.mockResolvedValue({
        ...CYCLE_2026,
        isCurrent: false,
      });
      mockPrisma.cycle.update.mockResolvedValue(CYCLE_2026);

      await service.activateCycle('fund', 'c-2026');

      expect(mockPrisma.cycle.updateMany).toHaveBeenCalledWith({
        where: { programId: 'fund', isCurrent: true, NOT: { id: 'c-2026' } },
        data: { isCurrent: false },
      });
      const demote = mockPrisma.cycle.updateMany.mock.invocationCallOrder[0];
      const promote = mockPrisma.cycle.update.mock.invocationCallOrder[0];
      expect(demote).toBeLessThan(promote);
    });
  });
});
