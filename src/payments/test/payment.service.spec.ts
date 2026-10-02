import { HttpStatus } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AppException } from '../../common/exceptions/app.exception';
import { CycleService } from '../../cycles/cycle.service';
import type { EnrollmentService } from '../../enrollments/enrollment.service';
import type { ProgramService } from '../../programs/program.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { PaymentService } from '../payment.service';

const CYCLE = {
  id: 'c1',
  programId: 'fund',
  startYear: 2026,
  lengthYears: 4,
  endYear: 2029,
  isCurrent: true,
};
const MONTHLY_PROGRAM = {
  id: 'fund',
  name: 'اشتراكات الصندوق',
  type: 'PERIODIC',
  hasCycles: true,
  isProtected: true,
  sortOrder: 0,
  cycles: [CYCLE],
};
const DATED_PROGRAM = {
  id: 'camp',
  name: 'حملة',
  type: 'TEMPORARY',
  hasCycles: false,
  isProtected: false,
  sortOrder: 1,
  cycles: [],
};

const mockPrisma = {
  $transaction: jest.fn(),
  payment: {
    upsert: jest.fn(),
    deleteMany: jest.fn(),
    create: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  },
  program: { findFirst: jest.fn() },
};
const mockProgramService = { assertProgramExists: jest.fn() };
const mockEnrollmentService = {
  lookUpContributorPayer: jest.fn(),
  addDonor: jest.fn(),
  removeDonorIfEmpty: jest.fn(),
};

const CONTRIBUTOR = { kind: 'CONTRIBUTOR' as const, contributorId: 'p1' };
const FROM_FUND = { kind: 'PROGRAM' as const, programId: 'fund' };

const entryRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'pay-1',
  year: 2026,
  paymentDate: new Date('2026-03-01T00:00:00.000Z'),
  amount: new Prisma.Decimal(250),
  createdAt: new Date(),
  contributorId: null,
  payerNameFreetext: 'متبرع',
  payerProgramId: null,
  contributor: null,
  payerProgram: null,
  recordedBy: { name: 'Treasurer' },
  ...overrides,
});

describe('PaymentService', () => {
  let service: PaymentService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockProgramService.assertProgramExists.mockImplementation((id: string) =>
      Promise.resolve(id === 'camp' ? DATED_PROGRAM : MONTHLY_PROGRAM),
    );
    mockEnrollmentService.lookUpContributorPayer.mockResolvedValue({
      enrolled: true,
      live: true,
    });
    mockPrisma.$transaction.mockImplementation(
      (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma),
    );
    mockPrisma.program.findFirst.mockResolvedValue({ id: 'fund' });
    // The real CycleService, so the window and year fence under test are the shipped ones.
    const cycleService = new CycleService(
      mockPrisma as unknown as PrismaService,
      mockProgramService as unknown as ProgramService,
    );
    service = new PaymentService(
      mockPrisma as unknown as PrismaService,
      cycleService,
      mockEnrollmentService as unknown as EnrollmentService,
    );
  });

  describe('setCell', () => {
    it('upserts an enrolled contributor’s cell on its unique key and records who wrote it', async () => {
      mockPrisma.payment.upsert.mockResolvedValue({
        year: 2026,
        month: 3,
        isStarred: false,
        amount: new Prisma.Decimal('300.5'),
      });

      const result = await service.setCell(
        'u1',
        'fund',
        CONTRIBUTOR,
        { year: 2026, month: 3 },
        { isStarred: false, amount: '300.5' },
      );

      expect(mockPrisma.payment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            programId_contributorId_year_month: {
              programId: 'fund',
              contributorId: 'p1',
              year: 2026,
              month: 3,
            },
          },
          create: {
            programId: 'fund',
            contributorId: 'p1',
            year: 2026,
            month: 3,
            isStarred: false,
            amount: '300.5',
            recordedById: 'u1',
          },
        }),
      );
      expect(result).toMatchObject({
        amount: '300.50',
        successCode: 'PAYMENT_CELL_SAVE_SUCCESS',
      });
    });

    it('stores a star with a NULL amount, which is what keeps it out of every sum', async () => {
      mockPrisma.payment.upsert.mockResolvedValue({
        year: 2026,
        month: 1,
        isStarred: true,
        amount: null,
      });

      const result = await service.setCell(
        'u1',
        'fund',
        CONTRIBUTOR,
        { year: 2026, month: 1 },
        { isStarred: true },
      );

      expect(mockPrisma.payment.upsert.mock.calls[0][0].update).toEqual({
        isStarred: true,
        amount: null,
        recordedById: 'u1',
      });
      expect(result.amount).toBeNull();
    });

    it('writes another program’s row on the program-payer key, never the contributor one', async () => {
      mockPrisma.payment.upsert.mockResolvedValue({
        year: 2026,
        month: 1,
        isStarred: false,
        amount: new Prisma.Decimal(9000),
      });

      await service.setCell(
        'u1',
        'mwa',
        FROM_FUND,
        { year: 2026, month: 1 },
        { isStarred: false, amount: '9000' },
      );

      const call = mockPrisma.payment.upsert.mock.calls[0][0];
      expect(call.where).toEqual({
        programId_payerProgramId_year_month: {
          programId: 'mwa',
          payerProgramId: 'fund',
          year: 2026,
          month: 1,
        },
      });
      expect(call.create).not.toHaveProperty('contributorId');
      expect(
        mockEnrollmentService.lookUpContributorPayer,
      ).not.toHaveBeenCalled();
    });

    it('refuses a program paying itself', async () => {
      await expect(
        service.setCell(
          'u1',
          'fund',
          FROM_FUND,
          { year: 2026, month: 1 },
          { isStarred: false, amount: '1' },
        ),
      ).rejects.toMatchObject({ errorCode: 'PAYMENT_SELF_TRANSFER' });
      expect(mockPrisma.payment.upsert).not.toHaveBeenCalled();
    });

    it('refuses a payer program that does not exist or was deleted', async () => {
      mockPrisma.program.findFirst.mockResolvedValue(null);
      await expect(
        service.setCell(
          'u1',
          'mwa',
          FROM_FUND,
          { year: 2026, month: 1 },
          { isStarred: false, amount: '1' },
        ),
      ).rejects.toMatchObject({ errorCode: 'PAYMENT_PAYER_PROGRAM_NOT_FOUND' });
    });

    it('refuses a contributor not enrolled in the program before writing anything', async () => {
      mockEnrollmentService.lookUpContributorPayer.mockResolvedValue({
        enrolled: false,
        live: true,
      });
      await expect(
        service.setCell(
          'u1',
          'fund',
          CONTRIBUTOR,
          { year: 2026, month: 3 },
          { isStarred: false, amount: '1' },
        ),
      ).rejects.toMatchObject({ errorCode: 'ENROLLMENT_NOT_FOUND' });
      expect(mockPrisma.payment.upsert).not.toHaveBeenCalled();
    });

    it('rejects a year outside the program’s current cycle — the fence around unconfirmed advance payments', async () => {
      await expect(
        service.setCell(
          'u1',
          'fund',
          CONTRIBUTOR,
          { year: 2030, month: 1 },
          { isStarred: false, amount: '1' },
        ),
      ).rejects.toMatchObject({ errorCode: 'CYCLE_YEAR_OUT_OF_RANGE' });
      expect(mockPrisma.payment.upsert).not.toHaveBeenCalled();
    });

    it('refuses a monthly cell on a program that keeps a dated ledger', async () => {
      await expect(
        service.setCell(
          'u1',
          'camp',
          FROM_FUND,
          { year: 2026, month: 1 },
          { isStarred: false, amount: '1' },
        ),
      ).rejects.toMatchObject({ errorCode: 'PROGRAM_NOT_MONTHLY' });
    });

    // The program and payer checks run side by side; the program's answer
    // must still come first, as when it was checked first.
    it('answers PROGRAM_NOT_FOUND for an unknown program even though its enrollment check fails too', async () => {
      mockProgramService.assertProgramExists.mockRejectedValue(
        new AppException('PROGRAM_NOT_FOUND', {}, HttpStatus.NOT_FOUND),
      );
      mockEnrollmentService.lookUpContributorPayer.mockResolvedValue({
        enrolled: false,
        live: true,
      });
      await expect(
        service.setCell(
          'u1',
          'gone',
          CONTRIBUTOR,
          { year: 2026, month: 1 },
          { isStarred: false, amount: '1' },
        ),
      ).rejects.toMatchObject({ errorCode: 'PROGRAM_NOT_FOUND' });
      expect(mockPrisma.payment.upsert).not.toHaveBeenCalled();
    });

    it('answers the cycle fence before a payer failure', async () => {
      mockEnrollmentService.lookUpContributorPayer.mockResolvedValue({
        enrolled: false,
        live: true,
      });
      await expect(
        service.setCell(
          'u1',
          'fund',
          CONTRIBUTOR,
          { year: 2030, month: 1 },
          { isStarred: false, amount: '1' },
        ),
      ).rejects.toMatchObject({ errorCode: 'CYCLE_YEAR_OUT_OF_RANGE' });
    });
  });

  describe('clearCell', () => {
    it('deletes by program, payer and month, and succeeds on an already-empty cell', async () => {
      mockPrisma.payment.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.clearCell('fund', CONTRIBUTOR, {
        year: 2026,
        month: 3,
      });

      expect(mockPrisma.payment.deleteMany).toHaveBeenCalledWith({
        where: { programId: 'fund', contributorId: 'p1', year: 2026, month: 3 },
      });
      expect(result.successCode).toBe('PAYMENT_CELL_CLEAR_SUCCESS');
    });
  });

  describe('recordPayment', () => {
    it('books a stranger’s gift as a dated entry, filing it under the date’s year', async () => {
      mockPrisma.payment.create.mockResolvedValue(entryRow());

      const result = await service.recordPayment('u1', 'camp', {
        payer: { kind: 'FREETEXT', name: 'متبرع' },
        amount: '250',
        paymentDate: new Date('2026-03-01T00:00:00.000Z'),
      });

      expect(mockPrisma.payment.create.mock.calls[0][0].data).toEqual({
        programId: 'camp',
        payerNameFreetext: 'متبرع',
        amount: '250',
        year: 2026,
        paymentDate: new Date('2026-03-01T00:00:00.000Z'),
        idempotencyKey: undefined,
        recordedById: 'u1',
      });
      expect(result).toMatchObject({
        paymentDate: '2026-03-01',
        payer: { kind: 'FREETEXT', name: 'متبرع' },
        successCode: 'PAYMENT_RECORD_SUCCESS',
      });
    });

    it('answers a double submit with the payment the first one booked', async () => {
      mockPrisma.payment.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '7.10.0',
        }),
      );
      mockPrisma.payment.findUnique.mockResolvedValue({
        ...entryRow(),
        programId: 'camp',
      });

      const result = await service.recordPayment('u1', 'camp', {
        payer: { kind: 'FREETEXT', name: 'متبرع' },
        amount: '250',
        paymentDate: new Date('2026-03-01T00:00:00.000Z'),
        idempotencyKey: '7f9c0c35-3f43-4b2a-9d5e-0a3bdb2b6f10',
      });

      expect(result).toMatchObject({ id: 'pay-1' });
      expect(mockPrisma.payment.create).toHaveBeenCalledTimes(1);
    });

    it('refuses an idempotency key that already booked a payment in another program', async () => {
      mockPrisma.payment.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '7.10.0',
        }),
      );
      mockPrisma.payment.findUnique.mockResolvedValue({
        ...entryRow(),
        programId: 'elsewhere',
      });

      await expect(
        service.recordPayment('u1', 'camp', {
          payer: { kind: 'FREETEXT', name: 'x' },
          amount: '1',
          paymentDate: new Date('2026-03-01T00:00:00.000Z'),
          idempotencyKey: '7f9c0c35-3f43-4b2a-9d5e-0a3bdb2b6f10',
        }),
      ).rejects.toMatchObject({ errorCode: 'PAYMENT_IDEMPOTENCY_KEY_REUSED' });
    });

    const GIFT = {
      payer: CONTRIBUTOR,
      amount: '500',
      paymentDate: new Date('2026-03-01T00:00:00.000Z'),
    };

    it('takes a directory contributor’s first gift to a temporary program with no enrolling, adding their donor row in the same transaction', async () => {
      mockEnrollmentService.lookUpContributorPayer.mockResolvedValue({
        enrolled: false,
        live: true,
      });
      mockPrisma.payment.create.mockResolvedValue(
        entryRow({ contributorId: 'p1', payerNameFreetext: null }),
      );

      await service.recordPayment('u1', 'camp', GIFT);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockEnrollmentService.addDonor).toHaveBeenCalledWith(
        mockPrisma,
        'camp',
        'p1',
      );
      expect(
        mockEnrollmentService.addDonor.mock.invocationCallOrder[0],
      ).toBeLessThan(mockPrisma.payment.create.mock.invocationCallOrder[0]);
    });

    it('books a returning donor’s gift as the single insert', async () => {
      mockPrisma.payment.create.mockResolvedValue(
        entryRow({ contributorId: 'p1', payerNameFreetext: null }),
      );

      await service.recordPayment('u1', 'camp', GIFT);

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockEnrollmentService.addDonor).not.toHaveBeenCalled();
      expect(mockPrisma.payment.create).toHaveBeenCalledTimes(1);
    });

    it('refuses a deleted or merged-away contributor giving to a temporary program', async () => {
      mockEnrollmentService.lookUpContributorPayer.mockResolvedValue({
        enrolled: false,
        live: false,
      });

      await expect(
        service.recordPayment('u1', 'camp', GIFT),
      ).rejects.toMatchObject({ errorCode: 'CONTRIBUTOR_NOT_FOUND' });
      expect(mockEnrollmentService.addDonor).not.toHaveBeenCalled();
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });

    // A periodic program without cycles keeps a ledger too, but it has
    // subscribers: only the enrolled pay it.
    it('still requires enrollment in a periodic program that keeps a ledger', async () => {
      mockProgramService.assertProgramExists.mockResolvedValue({
        ...DATED_PROGRAM,
        id: 'jamea',
        type: 'PERIODIC',
      });
      mockEnrollmentService.lookUpContributorPayer.mockResolvedValue({
        enrolled: false,
        live: true,
      });

      await expect(
        service.recordPayment('u1', 'jamea', GIFT),
      ).rejects.toMatchObject({ errorCode: 'ENROLLMENT_NOT_FOUND' });
      expect(mockEnrollmentService.addDonor).not.toHaveBeenCalled();
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });

    it('refuses a dated entry on a program that keeps a monthly grid', async () => {
      await expect(
        service.recordPayment('u1', 'fund', {
          payer: { kind: 'FREETEXT', name: 'x' },
          amount: '1',
          paymentDate: new Date('2026-03-01T00:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ errorCode: 'PROGRAM_NOT_DATED' });
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });
  });

  describe('deletePayment', () => {
    it('only removes dated entries — cells are cleared through their cell URL', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue(null);

      await expect(
        service.deletePayment('camp', 'cell-id'),
      ).rejects.toMatchObject({ errorCode: 'PAYMENT_NOT_FOUND' });
      expect(mockPrisma.payment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cell-id', programId: 'camp', month: null },
        }),
      );
      expect(mockPrisma.payment.deleteMany).not.toHaveBeenCalled();
    });

    // A dated program with cycles: the entry's year, read beside the
    // program, is fenced into the current cycle like a write would be.
    const DRIVE = {
      ...DATED_PROGRAM,
      id: 'drive',
      hasCycles: true,
      cycles: [{ ...CYCLE, programId: 'drive' }],
    };

    it('refuses to remove an entry from outside the current cycle', async () => {
      mockProgramService.assertProgramExists.mockResolvedValue(DRIVE);
      mockPrisma.payment.findFirst.mockResolvedValue({ year: 2031 });

      await expect(
        service.deletePayment('drive', 'pay-1'),
      ).rejects.toMatchObject({ errorCode: 'CYCLE_YEAR_OUT_OF_RANGE' });
      expect(mockPrisma.payment.deleteMany).not.toHaveBeenCalled();
    });

    it('removes an entry inside the current cycle', async () => {
      mockProgramService.assertProgramExists.mockResolvedValue(DRIVE);
      mockPrisma.payment.findFirst.mockResolvedValue({ year: 2027 });
      mockPrisma.payment.deleteMany.mockResolvedValue({ count: 1 });

      await expect(service.deletePayment('drive', 'pay-1')).resolves.toEqual({
        id: 'pay-1',
        successCode: 'PAYMENT_DELETE_SUCCESS',
      });
      expect(mockPrisma.payment.deleteMany).toHaveBeenCalledWith({
        where: { id: 'pay-1', programId: 'drive' },
      });
    });

    it('drops the donor row with the last gift of theirs removed from a temporary program', async () => {
      mockPrisma.payment.findFirst.mockResolvedValue({
        year: 2026,
        contributorId: 'p1',
      });
      mockPrisma.payment.deleteMany.mockResolvedValue({ count: 1 });

      await service.deletePayment('camp', 'pay-1');

      expect(mockEnrollmentService.removeDonorIfEmpty).toHaveBeenCalledWith(
        'camp',
        'p1',
      );
      expect(
        mockPrisma.payment.deleteMany.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockEnrollmentService.removeDonorIfEmpty.mock.invocationCallOrder[0],
      );
    });

    it('never touches an enrollment when removing a periodic program’s entry', async () => {
      mockProgramService.assertProgramExists.mockResolvedValue({
        ...DATED_PROGRAM,
        id: 'jamea',
        type: 'PERIODIC',
      });
      mockPrisma.payment.findFirst.mockResolvedValue({
        year: 2026,
        contributorId: 'p1',
      });
      mockPrisma.payment.deleteMany.mockResolvedValue({ count: 1 });

      await service.deletePayment('jamea', 'pay-1');

      expect(mockEnrollmentService.removeDonorIfEmpty).not.toHaveBeenCalled();
    });

    it('answers PAYMENT_NOT_FOUND first for an entry in a program that does not exist', async () => {
      mockProgramService.assertProgramExists.mockRejectedValue(
        new AppException('PROGRAM_NOT_FOUND', {}, HttpStatus.NOT_FOUND),
      );
      mockPrisma.payment.findFirst.mockResolvedValue(null);

      await expect(
        service.deletePayment('gone', 'pay-1'),
      ).rejects.toMatchObject({ errorCode: 'PAYMENT_NOT_FOUND' });
    });
  });

  it('keeps advance payments pending at 501', () => {
    let thrown: unknown;
    try {
      service.recordAdvancePayment(
        'fund',
        CONTRIBUTOR,
        { year: 2026, month: 1 },
        2027,
        '1200',
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ errorCode: 'FEATURE_PENDING_CONFIRMATION' });
    expect((thrown as AppException).getStatus()).toBe(501);
  });
});
