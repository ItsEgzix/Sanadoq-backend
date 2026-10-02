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

    it('accepts any year for a temporary program — it has no cycle to fence it', async () => {
      mockProgramService.assertProgramExists.mockResolvedValue(
        program({ type: 'TEMPORARY', isProtected: false, cycles: [] }),
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

    it('refuses a temporary program — one need, collected once, never has a cycle', async () => {
      mockProgramService.assertProgramExists.mockResolvedValue(
        program({ type: 'TEMPORARY', isProtected: false, cycles: [] }),
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

  describe('the guards on reshaping a cycle', () => {
    afterEach(() => jest.useRealTimers());

    it('refuses to move this year out of the current cycle — collectors could not record it', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2027-05-01T00:00:00Z'));
      mockPrisma.cycle.findFirst.mockResolvedValueOnce(CYCLE_2026);

      await expect(
        service.updateCycle('fund', 'c-2026', { lengthYears: 1 }),
      ).rejects.toMatchObject({
        errorCode: 'CYCLE_CURRENT_DROPS_THIS_YEAR',
        meta: { year: 2027 },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses to leave a year between two cycles, belonging to neither', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-02T00:00:00Z'));
      mockPrisma.cycle.findFirst
        .mockResolvedValueOnce(CYCLE_2026) // findCycleOrThrow
        .mockResolvedValueOnce(null); // no overlap
      mockPrisma.payment.count.mockResolvedValue(0);
      mockPrisma.cycle.findMany.mockResolvedValue([
        { startYear: 2030, endYear: 2032 }, // the next cycle, already set up
      ]);

      await expect(
        service.updateCycle('fund', 'c-2026', { lengthYears: 3 }),
      ).rejects.toMatchObject({
        errorCode: 'CYCLE_LEAVES_GAP',
        meta: { years: '2029' },
      });
      expect(mockPrisma.cycle.update).not.toHaveBeenCalled();
    });

    it('lets the far end go when no cycle follows and nothing is paid there', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-02T00:00:00Z'));
      mockPrisma.cycle.findFirst
        .mockResolvedValueOnce(CYCLE_2026)
        .mockResolvedValueOnce(null);
      mockPrisma.payment.count.mockResolvedValue(0);
      mockPrisma.cycle.findMany.mockResolvedValue([]);
      mockPrisma.cycle.update.mockResolvedValue({
        ...CYCLE_2026,
        lengthYears: 3,
        endYear: 2028,
      });

      const result = await service.updateCycle('fund', 'c-2026', {
        lengthYears: 3,
      });

      expect(result).toMatchObject({ endYear: 2028 });
    });
  });

  describe('splitCycle', () => {
    afterEach(() => jest.useRealTimers());

    const splitInto = (kept: number, next: number, current = true) => {
      mockPrisma.cycle.findFirst
        .mockResolvedValueOnce({ ...CYCLE_2026, isCurrent: current })
        .mockResolvedValueOnce(null); // no overlap
      mockPrisma.payment.count.mockResolvedValue(0);
      mockPrisma.cycle.findMany.mockResolvedValue([]);
      mockPrisma.cycle.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...CYCLE_2026, isCurrent: current, ...data }),
      );
      mockPrisma.cycle.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'c-next', ...data }),
      );
      return service.splitCycle('fund', 'c-2026', {
        lengthYears: kept,
        nextLengthYears: next,
      });
    };

    it('shortens the cycle and starts the next one the year after, keeping this one current', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-02T00:00:00Z'));

      const result = await splitInto(2, 2);

      expect(mockPrisma.cycle.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'c-2026' },
          data: { lengthYears: 2, endYear: 2027 },
        }),
      );
      expect(mockPrisma.cycle.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            programId: 'fund',
            startYear: 2028,
            lengthYears: 2,
            endYear: 2029,
            isCurrent: false,
          },
        }),
      );
      // The cut years count as kept: the new cycle takes their payments.
      const { where } = mockPrisma.payment.count.mock.calls[0][0];
      expect(where.OR).toEqual([
        { year: { lt: 2026 } },
        { year: { gt: 2029 } },
      ]);
      expect(result).toMatchObject({
        startYear: 2026,
        endYear: 2027,
        nextStartYear: 2028,
        nextEndYear: 2029,
        successCode: 'CYCLE_SPLIT_SUCCESS',
      });
      // Shrink before insert, or the overlap exclusion would refuse it.
      expect(mockPrisma.cycle.update.mock.invocationCallOrder[0]).toBeLessThan(
        mockPrisma.cycle.create.mock.invocationCallOrder[0],
      );
    });

    it('makes the new cycle current when this year falls in it, demoting the old one first', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2028-03-01T00:00:00Z'));

      await splitInto(2, 3);

      expect(mockPrisma.cycle.update.mock.calls[0][0].data).toEqual({
        lengthYears: 2,
        endYear: 2027,
        isCurrent: false,
      });
      expect(mockPrisma.cycle.create.mock.calls[0][0].data).toMatchObject({
        startYear: 2028,
        endYear: 2030,
        isCurrent: true,
      });
    });

    it('never makes the new cycle current when the split cycle was not current', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2028-03-01T00:00:00Z'));

      await splitInto(2, 2, false);

      expect(mockPrisma.cycle.create.mock.calls[0][0].data.isCurrent).toBe(
        false,
      );
    });

    it('refuses a length that is not shorter, writing nothing', async () => {
      mockPrisma.cycle.findFirst.mockResolvedValueOnce(CYCLE_2026);

      await expect(
        service.splitCycle('fund', 'c-2026', {
          lengthYears: 4,
          nextLengthYears: 3,
        }),
      ).rejects.toMatchObject({ errorCode: 'CYCLE_SPLIT_NOT_SHORTER' });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('still refuses when the new cycle is too short to take every payment cut off', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-02T00:00:00Z'));
      mockPrisma.cycle.findFirst
        .mockResolvedValueOnce(CYCLE_2026)
        .mockResolvedValueOnce(null);
      mockPrisma.payment.count.mockResolvedValue(3); // payments in 2029

      await expect(
        service.splitCycle('fund', 'c-2026', {
          lengthYears: 2,
          nextLengthYears: 1,
        }),
      ).rejects.toMatchObject({ errorCode: 'CYCLE_RANGE_STRANDS_PAYMENTS' });
      expect(mockPrisma.cycle.update).not.toHaveBeenCalled();
      expect(mockPrisma.cycle.create).not.toHaveBeenCalled();
    });
  });
});
