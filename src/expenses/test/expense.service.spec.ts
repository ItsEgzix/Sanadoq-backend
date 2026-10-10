import { HttpStatus } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AppException } from '../../common/exceptions/app.exception';
import type { ProgramWindowService } from '../../programs/program-window.service';
import type { ProgramService } from '../../programs/program.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { ExpenseService } from '../expense.service';

const d = (value: number) => new Prisma.Decimal(value);

const mockPrisma = {
  expenseLine: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    aggregate: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  expense: {
    findMany: jest.fn(),
    count: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
  payment: { groupBy: jest.fn() },
  raw: { program: { findMany: jest.fn() } },
};
const mockProgramService = { assertProgramExists: jest.fn() };
const mockWindow = { resolve: jest.fn() };

const LINE = {
  id: 'l1',
  programId: 'mwa',
  name: 'قيم جامع السعيد',
  category: null,
  sortOrder: 1,
};
const MWA = { id: 'mwa', name: 'مواساة', type: 'PERIODIC' };

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('db', {
    code,
    clientVersion: '7.10.0',
  });

describe('ExpenseService', () => {
  let service: ExpenseService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockProgramService.assertProgramExists.mockResolvedValue(MWA);
    mockPrisma.expenseLine.findFirst.mockResolvedValue(LINE);
    mockPrisma.payment.groupBy.mockResolvedValue([]);
    mockPrisma.raw.program.findMany.mockResolvedValue([]);
    service = new ExpenseService(
      mockPrisma as unknown as PrismaService,
      mockProgramService as unknown as ProgramService,
      mockWindow as unknown as ProgramWindowService,
    );
  });

  describe('setCell', () => {
    it('upserts the month on its (line, year, month) key and records who wrote it', async () => {
      mockPrisma.expense.upsert.mockResolvedValue({
        lineId: 'l1',
        year: 2026,
        month: 3,
        amount: d(7000),
      });

      const result = await service.setCell(
        'u1',
        { programId: 'mwa', lineId: 'l1', year: 2026, month: 3 },
        { amount: '7000' },
      );

      expect(mockPrisma.expense.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { lineId_year_month: { lineId: 'l1', year: 2026, month: 3 } },
          create: {
            programId: 'mwa',
            lineId: 'l1',
            year: 2026,
            month: 3,
            amount: '7000',
            recordedById: 'u1',
          },
          update: { amount: '7000', recordedById: 'u1' },
        }),
      );
      expect(result).toMatchObject({
        amount: '7000.00',
        successCode: 'EXPENSE_CELL_SAVE_SUCCESS',
      });
    });

    it('404s a line of another program instead of writing through the wrong URL', async () => {
      mockPrisma.expenseLine.findFirst.mockResolvedValue(null);

      await expect(
        service.setCell(
          'u1',
          { programId: 'fund', lineId: 'l1', year: 2026, month: 3 },
          { amount: '1' },
        ),
      ).rejects.toMatchObject({ errorCode: 'EXPENSE_LINE_NOT_FOUND' });
      expect(mockPrisma.expenseLine.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'l1', programId: 'fund' } }),
      );
      expect(mockPrisma.expense.upsert).not.toHaveBeenCalled();
    });

    it('answers PROGRAM_NOT_FOUND first for a program that does not exist', async () => {
      mockProgramService.assertProgramExists.mockRejectedValue(
        new AppException('PROGRAM_NOT_FOUND', {}, HttpStatus.NOT_FOUND),
      );
      mockPrisma.expenseLine.findFirst.mockResolvedValue(null);

      await expect(
        service.setCell(
          'u1',
          { programId: 'gone', lineId: 'l1', year: 2026, month: 3 },
          { amount: '1' },
        ),
      ).rejects.toMatchObject({ errorCode: 'PROGRAM_NOT_FOUND' });
    });
  });

  it('clears a month by deleting its row, and succeeds when it was already empty', async () => {
    mockPrisma.expense.deleteMany.mockResolvedValue({ count: 0 });

    const result = await service.clearCell({
      programId: 'mwa',
      lineId: 'l1',
      year: 2026,
      month: 3,
    });

    expect(mockPrisma.expense.deleteMany).toHaveBeenCalledWith({
      where: { lineId: 'l1', year: 2026, month: 3 },
    });
    expect(result.successCode).toBe('EXPENSE_CELL_CLEAR_SUCCESS');
  });

  describe('deleteLine', () => {
    it('refuses a line money went out under, and deletes nothing', async () => {
      mockPrisma.expense.count.mockResolvedValue(7);

      await expect(service.deleteLine('mwa', 'l1')).rejects.toMatchObject({
        errorCode: 'EXPENSE_LINE_HAS_EXPENSES',
        meta: { count: 7 },
      });
      expect(mockPrisma.expenseLine.delete).not.toHaveBeenCalled();
    });

    it('reports the same refusal when a cell lands between the count and the delete', async () => {
      mockPrisma.expense.count.mockResolvedValue(0);
      mockPrisma.expenseLine.delete.mockRejectedValue(prismaError('P2003'));

      await expect(service.deleteLine('mwa', 'l1')).rejects.toMatchObject({
        errorCode: 'EXPENSE_LINE_HAS_EXPENSES',
      });
    });

    it('removes a mistaken line with no cells', async () => {
      mockPrisma.expense.count.mockResolvedValue(0);

      await expect(service.deleteLine('mwa', 'l1')).resolves.toMatchObject({
        id: 'l1',
        successCode: 'EXPENSE_LINE_DELETE_SUCCESS',
      });
    });
  });

  it('places a new line after the program’s existing ones, and refuses past the cap', async () => {
    mockPrisma.expenseLine.aggregate.mockResolvedValue({
      _count: { _all: 3 },
      _max: { sortOrder: 3 },
    });
    mockPrisma.expenseLine.create.mockResolvedValue({ ...LINE, sortOrder: 4 });

    await service.createLine('mwa', { name: 'نادية حسن', category: null });

    expect(mockPrisma.expenseLine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          programId: 'mwa',
          name: 'نادية حسن',
          category: null,
          sortOrder: 4,
        },
      }),
    );

    mockPrisma.expenseLine.aggregate.mockResolvedValue({
      _count: { _all: 500 },
      _max: { sortOrder: 500 },
    });
    await expect(
      service.createLine('mwa', { name: 'x' }),
    ).rejects.toMatchObject({ errorCode: 'EXPENSE_LINE_LIMIT_REACHED' });
  });

  describe('loadTransfersOut', () => {
    it('reads what this program paid others from those payments — monthly cells by month, dated gifts by their date', async () => {
      mockPrisma.payment.groupBy.mockImplementation(
        ({ by }: { by: string[] }) =>
          Promise.resolve(
            by.includes('month')
              ? [{ programId: 'mwa', month: 1, _sum: { amount: d(9000) } }]
              : [
                  {
                    programId: 'camp',
                    paymentDate: new Date('2026-03-15T00:00:00.000Z'),
                    _sum: { amount: d(5000) },
                  },
                ],
          ),
      );
      mockPrisma.raw.program.findMany.mockResolvedValue([
        { id: 'camp', name: 'حملة رمضان', isProtected: false },
        { id: 'mwa', name: 'مواساة', isProtected: false },
      ]);

      const transfers = await service.loadTransfersOut('fund', 2026);

      expect(mockPrisma.payment.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { payerProgramId: 'fund', year: 2026, month: { not: null } },
        }),
      );
      const byName = new Map(transfers.map((t) => [t.name, t]));
      expect(byName.get('مواساة')?.months[0].toFixed(2)).toBe('9000.00');
      expect(byName.get('حملة رمضان')?.months[2].toFixed(2)).toBe('5000.00');
      expect(byName.get('حملة رمضان')?.total.toFixed(2)).toBe('5000.00');
    });
  });
});
