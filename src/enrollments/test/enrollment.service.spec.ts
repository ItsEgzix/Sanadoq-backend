import { Prisma } from 'generated/prisma/client';
import type { ContributorService } from 'src/contributors/contributor.service';
import type { ProgramService } from 'src/programs/program.service';
import type { PrismaService } from 'src/prisma/prisma.service';
import { EnrollmentService } from '../enrollment.service';

const mockPrisma = {
  $transaction: jest.fn(),
  programEnrollment: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    createMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  contributor: { findFirst: jest.fn() },
  payment: { count: jest.fn() },
};
const mockProgramService = { assertProgramExists: jest.fn() };
const mockContributorService = {
  assertContributorExists: jest.fn(),
  insertContributor: jest.fn(),
  flagPossibleDuplicates: jest.fn(),
};

const CONTRIBUTOR = {
  id: 'p1',
  name: 'Test',
  accountNumber: '2401007',
  phone: null,
  email: null,
};
const ENROLLMENT = {
  id: 'e1',
  contributorId: 'p1',
  programId: 'fund',
  expectedRate: new Prisma.Decimal(6000),
  previousSubscription: new Prisma.Decimal(0),
  status: 'ACTIVE' as const,
  contributor: CONTRIBUTOR,
};

const FUND = { id: 'fund', name: 'اشتراكات الصندوق', type: 'PERIODIC' };
const CAMPAIGN = { id: 'camp', name: 'حملة رمضان', type: 'TEMPORARY' };

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('db', {
    code,
    clientVersion: '7.10.0',
  });

describe('EnrollmentService', () => {
  let service: EnrollmentService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma),
    );
    mockProgramService.assertProgramExists.mockImplementation((id: string) =>
      Promise.resolve(id === 'camp' ? CAMPAIGN : FUND),
    );
    mockPrisma.programEnrollment.findFirst.mockResolvedValue(ENROLLMENT);
    service = new EnrollmentService(
      mockPrisma as unknown as PrismaService,
      mockProgramService as unknown as ProgramService,
      mockContributorService as unknown as ContributorService,
    );
  });

  describe('createEnrollment', () => {
    it('creates a new contributor and enrolls them in one transaction, then checks for duplicates after commit', async () => {
      mockContributorService.insertContributor.mockResolvedValue(CONTRIBUTOR);
      mockPrisma.programEnrollment.create.mockResolvedValue(ENROLLMENT);
      mockContributorService.flagPossibleDuplicates.mockResolvedValue(1);

      const result = await service.createEnrollment('fund', {
        contributor: { name: 'Test', accountNumber: '2401007' },
        expectedRate: '6000',
      });

      expect(mockContributorService.insertContributor).toHaveBeenCalledWith(
        mockPrisma,
        {
          name: 'Test',
          accountNumber: '2401007',
        },
      );
      expect(mockPrisma.programEnrollment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            programId: 'fund',
            contributorId: 'p1',
            expectedRate: '6000',
            previousSubscription: '0',
          },
        }),
      );
      const txDone = mockPrisma.$transaction.mock.invocationCallOrder[0];
      const flagged =
        mockContributorService.flagPossibleDuplicates.mock
          .invocationCallOrder[0];
      expect(flagged).toBeGreaterThan(txDone);
      expect(result).toMatchObject({
        expectedRate: '6000.00',
        possibleDuplicates: 1,
        successCode: 'ENROLLMENT_CREATE_SUCCESS',
      });
    });

    it('enrolls an existing contributor without a duplicate check — they were checked when saved', async () => {
      mockPrisma.programEnrollment.create.mockResolvedValue(ENROLLMENT);

      await service.createEnrollment('fund', {
        contributorId: 'p1',
        expectedRate: '6000',
      });

      expect(
        mockContributorService.assertContributorExists,
      ).toHaveBeenCalledWith('p1');
      expect(mockContributorService.insertContributor).not.toHaveBeenCalled();
      expect(
        mockContributorService.flagPossibleDuplicates,
      ).not.toHaveBeenCalled();
    });

    it('refuses to enroll anyone in a temporary program, which takes gifts without enrolling', async () => {
      await expect(
        service.createEnrollment('camp', {
          contributorId: 'p1',
          expectedRate: '0',
        }),
      ).rejects.toMatchObject({
        errorCode: 'ENROLLMENT_PROGRAM_TEMPORARY',
        meta: { programName: 'حملة رمضان' },
      });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockContributorService.insertContributor).not.toHaveBeenCalled();
    });

    it('answers ENROLLMENT_EXISTS for a second enrollment in the same program', async () => {
      mockPrisma.programEnrollment.create.mockRejectedValue(
        prismaError('P2002'),
      );

      await expect(
        service.createEnrollment('fund', {
          contributorId: 'p1',
          expectedRate: '1',
        }),
      ).rejects.toMatchObject({ errorCode: 'ENROLLMENT_EXISTS' });
    });
  });

  describe('updateEnrollment', () => {
    it('refuses a pledge or previous subscription on a temporary program’s donor row', async () => {
      await expect(
        service.updateEnrollment('camp', 'e1', { expectedRate: '1200' }),
      ).rejects.toMatchObject({ errorCode: 'ENROLLMENT_PROGRAM_TEMPORARY' });
      expect(mockPrisma.programEnrollment.update).not.toHaveBeenCalled();
    });

    it('corrects a periodic enrollment’s pledge', async () => {
      mockPrisma.programEnrollment.update.mockResolvedValue({
        ...ENROLLMENT,
        expectedRate: new Prisma.Decimal(7200),
      });

      const result = await service.updateEnrollment('fund', 'e1', {
        expectedRate: '7200',
      });

      expect(result).toMatchObject({
        expectedRate: '7200.00',
        successCode: 'ENROLLMENT_UPDATE_SUCCESS',
      });
    });
  });

  describe('donor rows', () => {
    it('reads enrollment and a live record side by side, before the program type is known', async () => {
      mockPrisma.programEnrollment.findUnique.mockResolvedValue(null);
      mockPrisma.contributor.findFirst.mockResolvedValue({ id: 'p1' });

      await expect(
        service.lookUpContributorPayer('camp', 'p1'),
      ).resolves.toEqual({ enrolled: false, live: true });
    });

    it('adds a pledge-free donor row that a racing first gift cannot duplicate', async () => {
      await service.addDonor(
        mockPrisma as unknown as PrismaService,
        'camp',
        'p1',
      );

      expect(mockPrisma.programEnrollment.createMany).toHaveBeenCalledWith({
        data: [{ programId: 'camp', contributorId: 'p1', expectedRate: '0' }],
        skipDuplicates: true,
      });
    });

    it('removes a donor row only once no payment of theirs is left in the program', async () => {
      mockPrisma.programEnrollment.deleteMany.mockResolvedValue({ count: 1 });

      await service.removeDonorIfEmpty('camp', 'p1');

      expect(mockPrisma.programEnrollment.deleteMany).toHaveBeenCalledWith({
        where: {
          programId: 'camp',
          contributorId: 'p1',
          payments: { none: {} },
        },
      });
    });

    it('keeps the donor row when a gift lands between the filter and the delete', async () => {
      mockPrisma.programEnrollment.deleteMany.mockRejectedValue(
        prismaError('P2003'),
      );

      await expect(
        service.removeDonorIfEmpty('camp', 'p1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('removeEnrollment', () => {
    it('refuses once the contributor has paid anything into the program, and deletes nothing', async () => {
      mockPrisma.payment.count.mockResolvedValue(4);

      await expect(
        service.removeEnrollment('fund', 'e1'),
      ).rejects.toMatchObject({
        errorCode: 'ENROLLMENT_HAS_PAYMENTS',
        meta: { count: 4 },
      });
      expect(mockPrisma.payment.count).toHaveBeenCalledWith({
        where: { programId: 'fund', contributorId: 'p1' },
      });
      expect(mockPrisma.programEnrollment.delete).not.toHaveBeenCalled();
    });

    it('reports the same refusal when a payment lands between the check and the delete', async () => {
      mockPrisma.payment.count.mockResolvedValue(0);
      mockPrisma.programEnrollment.delete.mockRejectedValue(
        prismaError('P2003'),
      );

      await expect(
        service.removeEnrollment('fund', 'e1'),
      ).rejects.toMatchObject({ errorCode: 'ENROLLMENT_HAS_PAYMENTS' });
    });

    it('404s an enrollment id from another program', async () => {
      mockPrisma.programEnrollment.findFirst.mockResolvedValue(null);

      await expect(service.removeEnrollment('mwa', 'e1')).rejects.toMatchObject(
        { errorCode: 'ENROLLMENT_NOT_FOUND' },
      );
      expect(mockPrisma.programEnrollment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'e1', programId: 'mwa' } }),
      );
    });
  });

  describe('markEnrollmentDormant', () => {
    it('flips ACTIVE to DORMANT with a conditional update scoped to the program', async () => {
      mockPrisma.programEnrollment.updateMany.mockResolvedValue({ count: 1 });

      await service.markEnrollmentDormant('fund', 'e1');

      expect(mockPrisma.programEnrollment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'e1',
          programId: 'fund',
          status: 'ACTIVE',
          program: { type: 'PERIODIC' },
        },
        data: { status: 'DORMANT' },
      });
    });

    it('never makes a temporary program’s donor dormant', async () => {
      mockPrisma.programEnrollment.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.markEnrollmentDormant('camp', 'e1'),
      ).rejects.toMatchObject({ errorCode: 'ENROLLMENT_PROGRAM_TEMPORARY' });
    });

    it('answers ENROLLMENT_ALREADY_DORMANT to the second of two clicks', async () => {
      mockPrisma.programEnrollment.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.markEnrollmentDormant('fund', 'e1'),
      ).rejects.toMatchObject({ errorCode: 'ENROLLMENT_ALREADY_DORMANT' });
    });
  });

  describe('pending flows', () => {
    it.each([
      [
        'reactivateEnrollment',
        () => service.reactivateEnrollment('fund', 'e1'),
      ],
      [
        'scheduleRateChange',
        () => service.scheduleRateChange('fund', 'e1', 2027, '1500'),
      ],
      ['assignCollector', () => service.assignCollector('fund', 'e1', 'u2')],
    ])(
      '%s throws FEATURE_PENDING_CONFIRMATION until the fund confirms the rules',
      (_name, call) => {
        expect(call).toThrow(
          expect.objectContaining({
            errorCode: 'FEATURE_PENDING_CONFIRMATION',
          }),
        );
      },
    );
  });
});
