import { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { ProgramService } from '../program.service';

const mockPrisma = {
  program: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    aggregate: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  payment: { count: jest.fn() },
  programEnrollment: { count: jest.fn() },
  // findFirst/findMany: the current cycle, read beside every program read.
  cycle: { count: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
};

const FUND = {
  id: 'fund',
  name: 'اشتراكات الصندوق',
  type: 'PERIODIC' as const,
  isProtected: true,
  sortOrder: 0,
  cycles: [],
};
const CAMPAIGN = {
  ...FUND,
  id: 'camp',
  name: 'حملة',
  type: 'TEMPORARY' as const,
  isProtected: false,
};

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
  });

describe('ProgramService', () => {
  let service: ProgramService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockPrisma.cycle.findFirst.mockResolvedValue(null);
    mockPrisma.cycle.findMany.mockResolvedValue([]);
    service = new ProgramService(mockPrisma as unknown as PrismaService);
  });

  describe('deleteProgram', () => {
    it('refuses the protected program outright and writes nothing', async () => {
      mockPrisma.program.findFirst.mockResolvedValue(FUND);

      await expect(service.deleteProgram('fund')).rejects.toMatchObject({
        errorCode: 'PROGRAM_PROTECTED',
      });
      expect(mockPrisma.program.update).not.toHaveBeenCalled();
    });

    it('soft-deletes any other program so its books survive', async () => {
      mockPrisma.program.findFirst.mockResolvedValue(CAMPAIGN);

      await service.deleteProgram('camp');

      expect(mockPrisma.program.update).toHaveBeenCalledWith({
        where: { id: 'camp' },
        data: { isDeleted: true, deletedAt: expect.any(Date) },
      });
    });
  });

  describe('updateProgram', () => {
    it('refuses to change the protected program’s type, before counting anything', async () => {
      mockPrisma.program.findFirst.mockResolvedValue(FUND);

      await expect(
        service.updateProgram('fund', { type: 'TEMPORARY' }),
      ).rejects.toMatchObject({ errorCode: 'PROGRAM_PROTECTED_SHAPE' });
      expect(mockPrisma.program.update).not.toHaveBeenCalled();
      expect(mockPrisma.payment.count).not.toHaveBeenCalled();
    });

    it('lets a form resend the protected program’s current type alongside a rename', async () => {
      mockPrisma.program.findFirst.mockResolvedValue(FUND);
      mockPrisma.program.update.mockResolvedValue({ ...FUND, name: 'renamed' });

      const result = await service.updateProgram('fund', {
        name: 'renamed',
        type: 'PERIODIC',
      });

      expect(result).toMatchObject({
        name: 'renamed',
        successCode: 'PROGRAM_UPDATE_SUCCESS',
      });
    });

    it('locks an ordinary program’s type once it has payments', async () => {
      mockPrisma.program.findFirst.mockResolvedValue(CAMPAIGN);
      mockPrisma.payment.count.mockResolvedValue(3);
      mockPrisma.cycle.count.mockResolvedValue(0);
      mockPrisma.programEnrollment.count.mockResolvedValue(0);

      await expect(
        service.updateProgram('camp', { type: 'PERIODIC' }),
      ).rejects.toMatchObject({
        errorCode: 'PROGRAM_SHAPE_LOCKED',
        meta: { payments: 3, cycles: 0 },
      });
      expect(mockPrisma.program.update).not.toHaveBeenCalled();
    });

    it('keeps a periodic program with subscribers from turning temporary, which keeps no pledges', async () => {
      mockPrisma.program.findFirst.mockResolvedValue({
        ...CAMPAIGN,
        type: 'PERIODIC',
      });
      mockPrisma.payment.count.mockResolvedValue(0);
      mockPrisma.cycle.count.mockResolvedValue(0);
      mockPrisma.programEnrollment.count.mockResolvedValue(2);

      await expect(
        service.updateProgram('camp', { type: 'TEMPORARY' }),
      ).rejects.toMatchObject({
        errorCode: 'PROGRAM_TYPE_LOCKED',
        meta: { enrollments: 2 },
      });
      expect(mockPrisma.program.update).not.toHaveBeenCalled();
    });

    it('turns an empty temporary program periodic, which brings cycles and the grid with it', async () => {
      mockPrisma.program.findFirst.mockResolvedValue(CAMPAIGN);
      mockPrisma.payment.count.mockResolvedValue(0);
      mockPrisma.cycle.count.mockResolvedValue(0);
      mockPrisma.programEnrollment.count.mockResolvedValue(0);
      mockPrisma.program.update.mockResolvedValue({
        ...CAMPAIGN,
        type: 'PERIODIC',
      });

      const result = await service.updateProgram('camp', { type: 'PERIODIC' });

      expect(result).toMatchObject({ hasCycles: true, entryMode: 'MONTHLY' });
    });

    it('turns a live-name clash into PROGRAM_NAME_TAKEN', async () => {
      mockPrisma.program.findFirst.mockResolvedValue(CAMPAIGN);
      mockPrisma.program.update.mockRejectedValue(uniqueViolation());

      await expect(
        service.updateProgram('camp', { name: 'مواساة' }),
      ).rejects.toMatchObject({
        errorCode: 'PROGRAM_NAME_TAKEN',
        meta: { name: 'مواساة' },
      });
    });
  });

  describe('createProgram', () => {
    it('never writes isProtected — protection exists only for the migration-made fund program', async () => {
      mockPrisma.program.aggregate.mockResolvedValue({
        _count: { _all: 1 },
        _max: { sortOrder: 0 },
      });
      mockPrisma.program.create.mockResolvedValue(CAMPAIGN);

      await service.createProgram({
        name: 'حملة',
        type: 'TEMPORARY',
      });

      const { data } = mockPrisma.program.create.mock.calls[0][0];
      expect(data).not.toHaveProperty('isProtected');
      expect(data.sortOrder).toBe(1);
    });

    it('refuses past the cap and creates nothing', async () => {
      mockPrisma.program.aggregate.mockResolvedValue({
        _count: { _all: 100 },
        _max: { sortOrder: 99 },
      });

      await expect(
        service.createProgram({
          name: 'x',
          type: 'TEMPORARY',
        }),
      ).rejects.toMatchObject({ errorCode: 'PROGRAM_LIMIT_REACHED' });
      expect(mockPrisma.program.create).not.toHaveBeenCalled();
    });
  });

  it('404s a deleted or unknown program', async () => {
    mockPrisma.program.findFirst.mockResolvedValue(null);
    await expect(service.getProgram('gone')).rejects.toMatchObject({
      errorCode: 'PROGRAM_NOT_FOUND',
    });
  });
});
