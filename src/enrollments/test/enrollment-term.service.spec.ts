import { Prisma } from '../../../generated/prisma/client';
import type { ProgramService } from '../../programs/program.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { EnrollmentTermService } from '../enrollment-term.service';

const d = (value: number) => new Prisma.Decimal(value);

const mockPrisma = {
  $transaction: jest.fn(),
  programEnrollment: { findFirst: jest.fn(), updateMany: jest.fn() },
  enrollmentTerm: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    createMany: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  payment: { aggregate: jest.fn() },
};
const mockProgramService = { assertProgramExists: jest.fn() };

const FUND = { id: 'fund', name: 'الصندوق', type: 'PERIODIC' };
const CAMPAIGN = { id: 'camp', name: 'حملة رمضان', type: 'TEMPORARY' };
const SEEN = new Date('2026-10-01T08:00:00.000Z');

const enrollment = (status: 'ACTIVE' | 'DORMANT', rate = 12000) => ({
  id: 'e1',
  contributorId: 'p1',
  programId: 'fund',
  expectedRate: d(rate),
  previousSubscription: d(0),
  status,
  contributor: {
    id: 'p1',
    name: 'Test',
    accountNumber: '0203010',
    phone: null,
    email: null,
  },
  updatedAt: SEEN,
});

const term = (
  id: string,
  fromYear: number,
  fromMonth: number,
  status: 'ACTIVE' | 'DORMANT',
  rate = 12000,
) => ({
  id,
  enrollmentId: 'e1',
  fromYear,
  fromMonth,
  status,
  expectedRate: d(rate),
});

describe('EnrollmentTermService', () => {
  let service: EnrollmentTermService;

  beforeAll(() => {
    // Every default and fence reads "this month": 10 October 2026.
    jest.useFakeTimers().setSystemTime(new Date('2026-10-10T12:00:00.000Z'));
  });
  afterAll(() => jest.useRealTimers());

  beforeEach(() => {
    jest.resetAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma),
    );
    mockProgramService.assertProgramExists.mockImplementation((id: string) =>
      Promise.resolve(id === 'camp' ? CAMPAIGN : FUND),
    );
    mockPrisma.programEnrollment.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
    service = new EnrollmentTermService(
      mockPrisma as unknown as PrismaService,
      mockProgramService as unknown as ProgramService,
    );
  });

  const history = (
    status: 'ACTIVE' | 'DORMANT',
    terms: ReturnType<typeof term>[],
    rate = 12000,
  ) => {
    mockPrisma.programEnrollment.findFirst.mockResolvedValue(
      enrollment(status, rate),
    );
    mockPrisma.enrollmentTerm.findMany.mockResolvedValue(terms);
  };

  describe('markDormant', () => {
    it('freezes from January of this year by default — the fund’s usual start', async () => {
      history('ACTIVE', [term('t1', 2002, 3, 'ACTIVE')]);

      const result = await service.markDormant('u1', 'fund', 'e1', {});

      expect(mockPrisma.enrollmentTerm.create).toHaveBeenCalledWith({
        data: {
          enrollmentId: 'e1',
          fromYear: 2026,
          fromMonth: 1,
          status: 'DORMANT',
          expectedRate: d(12000),
          recordedById: 'u1',
        },
      });
      expect(result).toMatchObject({
        status: 'DORMANT',
        from: '2026-01',
        successCode: 'ENROLLMENT_MARK_DORMANT_SUCCESS',
      });
    });

    it('freezes from a month mid-year when asked, so the months before stay owed', async () => {
      history('ACTIVE', [term('t1', 2002, 3, 'ACTIVE')]);

      await service.markDormant('u1', 'fund', 'e1', {
        from: { year: 2026, month: 5 },
      });

      expect(mockPrisma.enrollmentTerm.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ fromYear: 2026, fromMonth: 5 }),
      });
    });

    it('claims the enrollment by the updatedAt it read, and rewrites the mirror with it', async () => {
      history('ACTIVE', [term('t1', 2002, 3, 'ACTIVE')]);

      await service.markDormant('u1', 'fund', 'e1', {});

      expect(mockPrisma.programEnrollment.updateMany).toHaveBeenCalledWith({
        where: { id: 'e1', updatedAt: SEEN },
        data: { status: 'DORMANT', expectedRate: d(12000) },
      });
    });

    it('writes no term when someone changed the enrollment since it was read', async () => {
      history('ACTIVE', [term('t1', 2002, 3, 'ACTIVE')]);
      mockPrisma.programEnrollment.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.markDormant('u1', 'fund', 'e1', {}),
      ).rejects.toMatchObject({ errorCode: 'ENROLLMENT_CHANGED_CONCURRENTLY' });
      expect(mockPrisma.enrollmentTerm.create).not.toHaveBeenCalled();
    });

    it('answers ENROLLMENT_ALREADY_DORMANT without writing anything', async () => {
      history('DORMANT', [
        term('t1', 2002, 3, 'ACTIVE'),
        term('t2', 2026, 1, 'DORMANT'),
      ]);

      await expect(
        service.markDormant('u1', 'fund', 'e1', {}),
      ).rejects.toMatchObject({ errorCode: 'ENROLLMENT_ALREADY_DORMANT' });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('never freezes a temporary program’s donor row', async () => {
      history('ACTIVE', []);

      await expect(
        service.markDormant('u1', 'camp', 'e1', {}),
      ).rejects.toMatchObject({ errorCode: 'ENROLLMENT_PROGRAM_TEMPORARY' });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('stores the term an enrollment without history is read as, then the change after it', async () => {
      history('ACTIVE', []);

      await service.markDormant('u1', 'fund', 'e1', {});

      expect(mockPrisma.enrollmentTerm.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            fromYear: 2000,
            fromMonth: 1,
            status: 'ACTIVE',
            recordedById: null,
          }),
          expect.objectContaining({
            fromYear: 2026,
            fromMonth: 1,
            status: 'DORMANT',
            recordedById: 'u1',
          }),
        ],
      });
    });
  });

  describe('reactivate', () => {
    it('counts the whole year again by default: from January, after a dormancy from an earlier year', async () => {
      history('DORMANT', [
        term('t1', 2002, 3, 'ACTIVE'),
        term('t2', 2024, 1, 'DORMANT'),
      ]);

      const result = await service.reactivate('u1', 'fund', 'e1', {});

      expect(mockPrisma.enrollmentTerm.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fromYear: 2026,
          fromMonth: 1,
          status: 'ACTIVE',
        }),
      });
      expect(result).toMatchObject({
        status: 'ACTIVE',
        successCode: 'ENROLLMENT_REACTIVATE_SUCCESS',
      });
    });

    it('undoes a dormancy from this year outright, instead of stacking a term that says nothing new', async () => {
      // Frozen from March; "the whole year" can start no earlier than that
      // term, so it takes its place — and matches the term before it.
      history('DORMANT', [
        term('t1', 2002, 3, 'ACTIVE'),
        term('t2', 2026, 3, 'DORMANT'),
      ]);

      await service.reactivate('u1', 'fund', 'e1', {});

      expect(mockPrisma.enrollmentTerm.delete).toHaveBeenCalledWith({
        where: { id: 't2' },
      });
      expect(mockPrisma.enrollmentTerm.create).not.toHaveBeenCalled();
      expect(mockPrisma.enrollmentTerm.update).not.toHaveBeenCalled();
    });

    it('counts only from the month they returned when asked', async () => {
      history('DORMANT', [
        term('t1', 2002, 3, 'ACTIVE'),
        term('t2', 2026, 1, 'DORMANT'),
      ]);

      await service.reactivate('u1', 'fund', 'e1', {
        from: { year: 2026, month: 10 },
      });

      expect(mockPrisma.enrollmentTerm.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ fromYear: 2026, fromMonth: 10 }),
      });
    });

    it('refuses a start before the latest change, and a start after this month', async () => {
      history('DORMANT', [
        term('t1', 2002, 3, 'ACTIVE'),
        term('t2', 2026, 4, 'DORMANT'),
      ]);

      await expect(
        service.reactivate('u1', 'fund', 'e1', {
          from: { year: 2026, month: 2 },
        }),
      ).rejects.toMatchObject({
        errorCode: 'ENROLLMENT_TERM_BEFORE_LAST',
        meta: { from: '2026-04' },
      });
      await expect(
        service.reactivate('u1', 'fund', 'e1', {
          from: { year: 2026, month: 11 },
        }),
      ).rejects.toMatchObject({
        errorCode: 'ENROLLMENT_TERM_IN_FUTURE',
        meta: { month: '2026-10' },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('changeRate', () => {
    it('refuses a mid-year pledge until the months before it are paid at the old one', async () => {
      // 12,000 a year: January–May owe 5,000, only 3,000 came in.
      history('ACTIVE', [term('t1', 2020, 1, 'ACTIVE')]);
      mockPrisma.payment.aggregate.mockResolvedValue({
        _sum: { amount: d(3000) },
      });

      await expect(
        service.changeRate('u1', 'fund', 'e1', {
          expectedRate: '18000',
          from: { year: 2026, month: 6 },
        }),
      ).rejects.toMatchObject({
        errorCode: 'ENROLLMENT_RATE_CHANGE_UNSETTLED',
        meta: { owed: '2000.00', year: 2026 },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('starts the new pledge once the year so far is settled, keeping the status', async () => {
      history('ACTIVE', [term('t1', 2020, 1, 'ACTIVE')]);
      mockPrisma.payment.aggregate.mockResolvedValue({
        _sum: { amount: d(5000) },
      });

      const result = await service.changeRate('u1', 'fund', 'e1', {
        expectedRate: '18000',
        from: { year: 2026, month: 6 },
      });

      expect(mockPrisma.enrollmentTerm.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fromYear: 2026,
          fromMonth: 6,
          status: 'ACTIVE',
          expectedRate: d(18000),
        }),
      });
      expect(mockPrisma.programEnrollment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: 'ACTIVE', expectedRate: d(18000) },
        }),
      );
      expect(result).toMatchObject({
        expectedRate: '18000.00',
        from: '2026-06',
        successCode: 'ENROLLMENT_RATE_CHANGE_SUCCESS',
      });
    });

    it('needs nothing settled from January — there is no month before it', async () => {
      history('ACTIVE', [term('t1', 2020, 1, 'ACTIVE')]);

      await service.changeRate('u1', 'fund', 'e1', {
        expectedRate: '6000',
        from: { year: 2026, month: 1 },
      });

      expect(mockPrisma.enrollmentTerm.create).toHaveBeenCalled();
    });

    it('reads the year’s payments through the enrollment, beside the history', async () => {
      history('ACTIVE', [term('t1', 2020, 1, 'ACTIVE')]);

      await service.changeRate('u1', 'fund', 'e1', {
        expectedRate: '6000',
        from: { year: 2026, month: 1 },
      });

      expect(mockPrisma.payment.aggregate).toHaveBeenCalledWith({
        where: { programId: 'fund', year: 2026, enrollment: { id: 'e1' } },
        _sum: { amount: true },
      });
    });

    it('refuses the pledge it already has', async () => {
      history('ACTIVE', [term('t1', 2020, 1, 'ACTIVE')]);

      await expect(
        service.changeRate('u1', 'fund', 'e1', {
          expectedRate: '12000',
          from: { year: 2026, month: 1 },
        }),
      ).rejects.toMatchObject({ errorCode: 'ENROLLMENT_RATE_UNCHANGED' });
    });
  });

  describe('correctLatestRate', () => {
    it('rewrites the latest term’s pledge for as long as it has run', async () => {
      mockPrisma.enrollmentTerm.findFirst.mockResolvedValue({ id: 't2' });

      await service.correctLatestRate(
        mockPrisma as unknown as PrismaService,
        'u1',
        enrollment('ACTIVE', 0),
        '24000',
      );

      expect(mockPrisma.enrollmentTerm.update).toHaveBeenCalledWith({
        where: { id: 't2' },
        data: { expectedRate: '24000', recordedById: 'u1' },
      });
    });

    it('stores the term an enrollment without history is read as, at the corrected pledge', async () => {
      mockPrisma.enrollmentTerm.findFirst.mockResolvedValue(null);

      await service.correctLatestRate(
        mockPrisma as unknown as PrismaService,
        'u1',
        enrollment('ACTIVE', 0),
        '24000',
      );

      expect(mockPrisma.enrollmentTerm.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          enrollmentId: 'e1',
          fromYear: 2000,
          expectedRate: '24000',
        }),
      });
    });
  });
});
