import type { PrismaService } from 'src/prisma/prisma.service';
import { PersonDuplicateService } from '../person-duplicate.service';

const mockPrisma = {
  $transaction: jest.fn(),
  person: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  programEnrollment: { findMany: jest.fn(), updateMany: jest.fn() },
  personDuplicateFlag: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    count: jest.fn(),
    createMany: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};

const FLAG_PEOPLE = { personAId: 'pa', personBId: 'pb' };
const flagPerson = (id: string) => ({
  id,
  name: 'x',
  accountNumber: '0203006',
  phone: null,
  email: null,
  isDeleted: false,
  mergedIntoId: null,
  enrollments: [],
});
const FLAG_VIEW_ROW = {
  id: 'f1',
  status: 'MERGED',
  reasons: ['NAME_EXTENDS'],
  createdAt: new Date(),
  resolvedAt: new Date(),
  resolvedBy: { name: 'Treasurer' },
  personA: flagPerson('pa'),
  personB: flagPerson('pb'),
};

describe('PersonDuplicateService', () => {
  let service: PersonDuplicateService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma),
    );
    mockPrisma.personDuplicateFlag.findUniqueOrThrow.mockImplementation(
      ({ select }: { select: Record<string, unknown> }) =>
        Promise.resolve('personA' in select ? FLAG_VIEW_ROW : FLAG_PEOPLE),
    );
    service = new PersonDuplicateService(
      mockPrisma as unknown as PrismaService,
    );
  });

  describe('flagPossibleDuplicates', () => {
    it('raises flags and nothing else — no person or enrollment is ever touched by a match', async () => {
      mockPrisma.person.findMany.mockResolvedValue([
        { id: 'b', name: 'عمر محمد ملهي علي', accountNumber: '0203006' },
        { id: 'c', name: 'سمير محمد جازم', accountNumber: '0203004' },
      ]);
      mockPrisma.personDuplicateFlag.createMany.mockResolvedValue({ count: 1 });

      const raised = await service.flagPossibleDuplicates({
        id: 'a',
        name: 'عمر محمد ملهي',
        accountNumber: '2402006',
      });

      expect(raised).toBe(1);
      expect(mockPrisma.personDuplicateFlag.createMany).toHaveBeenCalledWith({
        data: [
          {
            personAId: 'a',
            personBId: 'b',
            reasons: ['NAME_EXTENDS', 'SAME_SERIAL'],
          },
        ],
        skipDuplicates: true,
      });
      expect(mockPrisma.person.update).not.toHaveBeenCalled();
      expect(mockPrisma.person.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.programEnrollment.updateMany).not.toHaveBeenCalled();
    });

    it('raises nothing, and skips the insert, when no one looks alike', async () => {
      mockPrisma.person.findMany.mockResolvedValue([
        { id: 'c', name: 'سمير محمد جازم', accountNumber: '0203004' },
      ]);

      await expect(
        service.flagPossibleDuplicates({
          id: 'a',
          name: 'عمر محمد ملهي',
          accountNumber: '2402006',
        }),
      ).resolves.toBe(0);
      expect(mockPrisma.personDuplicateFlag.createMany).not.toHaveBeenCalled();
    });
  });

  describe('scanAll', () => {
    it('dedupes on the pair key, so a dismissed pair is never raised again', async () => {
      mockPrisma.person.findMany.mockResolvedValue([
        { id: 'a', name: 'عمر محمد ملهي', accountNumber: '2402006' },
        { id: 'b', name: 'عمر محمد ملهي علي', accountNumber: '0203006' },
      ]);
      mockPrisma.personDuplicateFlag.createMany.mockResolvedValue({ count: 0 });

      const result = await service.scanAll();

      expect(
        mockPrisma.personDuplicateFlag.createMany.mock.calls[0][0]
          .skipDuplicates,
      ).toBe(true);
      expect(result).toMatchObject({ scanned: 2, candidates: 1, newFlags: 0 });
    });
  });

  describe('dismissFlag', () => {
    it('answers DUPLICATE_FLAG_ALREADY_RESOLVED when another reviewer decided first', async () => {
      mockPrisma.personDuplicateFlag.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.personDuplicateFlag.findUnique.mockResolvedValue({
        status: 'MERGED',
      });

      await expect(service.dismissFlag('u1', 'f1')).rejects.toMatchObject({
        errorCode: 'DUPLICATE_FLAG_ALREADY_RESOLVED',
        meta: { status: 'MERGED' },
      });
    });
  });

  describe('mergeFlag', () => {
    beforeEach(() => {
      mockPrisma.personDuplicateFlag.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.person.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.person.findFirst.mockResolvedValue({
        id: 'pa',
        phone: null,
        email: 'kept@example.org',
      });
      mockPrisma.person.findUniqueOrThrow.mockResolvedValue({
        phone: '+967 1 234',
        email: 'other@example.org',
      });
    });

    it('moves the other record’s enrollments onto the kept one and retires it', async () => {
      mockPrisma.programEnrollment.findMany
        .mockResolvedValueOnce([{ programId: 'fund' }]) // kept
        .mockResolvedValueOnce([
          { programId: 'mwa', program: { name: 'مواساة' } },
        ]); // merged away
      mockPrisma.programEnrollment.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.mergeFlag('u1', 'f1', {
        keepPersonId: 'pa',
      });

      // Retired conditionally, so a record merged away by someone else fails.
      expect(mockPrisma.person.updateMany).toHaveBeenCalledWith({
        where: { id: 'pb', isDeleted: false },
        data: {
          isDeleted: true,
          deletedAt: expect.any(Date),
          mergedIntoId: 'pa',
        },
      });
      expect(mockPrisma.programEnrollment.updateMany).toHaveBeenCalledWith({
        where: { personId: 'pb' },
        data: { personId: 'pa' },
      });
      // The kept record keeps its own email and only gains the missing phone.
      expect(mockPrisma.person.update).toHaveBeenCalledWith({
        where: { id: 'pa' },
        data: { phone: '+967 1 234', email: 'kept@example.org' },
      });
      expect(mockPrisma.personDuplicateFlag.deleteMany).toHaveBeenCalledWith({
        where: {
          status: 'OPEN',
          OR: [{ personAId: 'pb' }, { personBId: 'pb' }],
        },
      });
      expect(result).toMatchObject({
        keptPersonId: 'pa',
        mergedPersonId: 'pb',
        movedEnrollments: 1,
        successCode: 'PERSON_DUPLICATE_MERGE_SUCCESS',
      });
    });

    it('refuses when both records are enrolled in the same program, and moves nothing', async () => {
      mockPrisma.programEnrollment.findMany
        .mockResolvedValueOnce([{ programId: 'mwa' }])
        .mockResolvedValueOnce([
          { programId: 'mwa', program: { name: 'مواساة' } },
        ]);

      await expect(
        service.mergeFlag('u1', 'f1', { keepPersonId: 'pa' }),
      ).rejects.toMatchObject({
        errorCode: 'PERSON_MERGE_CONFLICT',
        meta: {
          details: {
            blockers: [{ kind: 'PROGRAM', id: 'mwa', name: 'مواساة' }],
          },
        },
      });
      expect(mockPrisma.programEnrollment.updateMany).not.toHaveBeenCalled();
    });

    it('refuses to keep someone outside the flagged pair, before retiring anyone', async () => {
      await expect(
        service.mergeFlag('u1', 'f1', { keepPersonId: 'stranger' }),
      ).rejects.toMatchObject({ errorCode: 'DUPLICATE_MERGE_KEEP_INVALID' });
      expect(mockPrisma.person.updateMany).not.toHaveBeenCalled();
    });

    it('answers DUPLICATE_PERSON_GONE when the other record was merged away meanwhile', async () => {
      mockPrisma.person.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.mergeFlag('u1', 'f1', { keepPersonId: 'pa' }),
      ).rejects.toMatchObject({ errorCode: 'DUPLICATE_PERSON_GONE' });
      expect(mockPrisma.programEnrollment.updateMany).not.toHaveBeenCalled();
    });

    it('404s an unknown flag', async () => {
      mockPrisma.personDuplicateFlag.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.personDuplicateFlag.findUnique.mockResolvedValue(null);

      await expect(
        service.mergeFlag('u1', 'nope', { keepPersonId: 'pa' }),
      ).rejects.toMatchObject({ errorCode: 'DUPLICATE_FLAG_NOT_FOUND' });
    });
  });
});
