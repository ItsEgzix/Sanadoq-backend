import { Prisma } from 'generated/prisma/client';
import type { PersonService } from 'src/people/person.service';
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
  },
  payment: { count: jest.fn() },
};
const mockProgramService = { assertProgramExists: jest.fn() };
const mockPersonService = {
  assertPersonExists: jest.fn(),
  insertPerson: jest.fn(),
  flagPossibleDuplicates: jest.fn(),
};

const PERSON = {
  id: 'p1',
  name: 'Test',
  accountNumber: '2401007',
  phone: null,
  email: null,
};
const ENROLLMENT = {
  id: 'e1',
  personId: 'p1',
  programId: 'fund',
  expectedRate: new Prisma.Decimal(6000),
  previousSubscription: new Prisma.Decimal(0),
  status: 'ACTIVE' as const,
  person: PERSON,
};

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
    mockProgramService.assertProgramExists.mockResolvedValue({
      id: 'fund',
      name: 'اشتراكات الصندوق',
    });
    mockPrisma.programEnrollment.findFirst.mockResolvedValue(ENROLLMENT);
    service = new EnrollmentService(
      mockPrisma as unknown as PrismaService,
      mockProgramService as unknown as ProgramService,
      mockPersonService as unknown as PersonService,
    );
  });

  describe('createEnrollment', () => {
    it('creates a new person and enrolls them in one transaction, then checks for duplicates after commit', async () => {
      mockPersonService.insertPerson.mockResolvedValue(PERSON);
      mockPrisma.programEnrollment.create.mockResolvedValue(ENROLLMENT);
      mockPersonService.flagPossibleDuplicates.mockResolvedValue(1);

      const result = await service.createEnrollment('fund', {
        person: { name: 'Test', accountNumber: '2401007' },
        expectedRate: '6000',
      });

      expect(mockPersonService.insertPerson).toHaveBeenCalledWith(mockPrisma, {
        name: 'Test',
        accountNumber: '2401007',
      });
      expect(mockPrisma.programEnrollment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            programId: 'fund',
            personId: 'p1',
            expectedRate: '6000',
            previousSubscription: '0',
          },
        }),
      );
      const txDone = mockPrisma.$transaction.mock.invocationCallOrder[0];
      const flagged =
        mockPersonService.flagPossibleDuplicates.mock.invocationCallOrder[0];
      expect(flagged).toBeGreaterThan(txDone);
      expect(result).toMatchObject({
        expectedRate: '6000.00',
        possibleDuplicates: 1,
        successCode: 'ENROLLMENT_CREATE_SUCCESS',
      });
    });

    it('enrolls an existing person without a duplicate check — they were checked when saved', async () => {
      mockPrisma.programEnrollment.create.mockResolvedValue(ENROLLMENT);

      await service.createEnrollment('fund', {
        personId: 'p1',
        expectedRate: '6000',
      });

      expect(mockPersonService.assertPersonExists).toHaveBeenCalledWith('p1');
      expect(mockPersonService.insertPerson).not.toHaveBeenCalled();
      expect(mockPersonService.flagPossibleDuplicates).not.toHaveBeenCalled();
    });

    it('answers ENROLLMENT_EXISTS for a second enrollment in the same program', async () => {
      mockPrisma.programEnrollment.create.mockRejectedValue(
        prismaError('P2002'),
      );

      await expect(
        service.createEnrollment('fund', { personId: 'p1', expectedRate: '1' }),
      ).rejects.toMatchObject({ errorCode: 'ENROLLMENT_EXISTS' });
    });
  });

  describe('removeEnrollment', () => {
    it('refuses once the person has paid anything into the program, and deletes nothing', async () => {
      mockPrisma.payment.count.mockResolvedValue(4);

      await expect(
        service.removeEnrollment('fund', 'e1'),
      ).rejects.toMatchObject({
        errorCode: 'ENROLLMENT_HAS_PAYMENTS',
        meta: { count: 4 },
      });
      expect(mockPrisma.payment.count).toHaveBeenCalledWith({
        where: { programId: 'fund', personId: 'p1' },
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
        where: { id: 'e1', programId: 'fund', status: 'ACTIVE' },
        data: { status: 'DORMANT' },
      });
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
