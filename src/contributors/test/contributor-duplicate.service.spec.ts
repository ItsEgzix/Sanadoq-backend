import type { PrismaService } from '../../prisma/prisma.service';
import { ContributorDuplicateService } from '../contributor-duplicate.service';

const mockPrisma = {
  $transaction: jest.fn(),
  contributor: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  programEnrollment: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  payment: { updateMany: jest.fn() },
  contributorDuplicateFlag: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    count: jest.fn(),
    createMany: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};

const FLAG_CONTRIBUTORS = { contributorAId: 'pa', contributorBId: 'pb' };
const flagContributor = (id: string) => ({
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
  contributorA: flagContributor('pa'),
  contributorB: flagContributor('pb'),
};

describe('ContributorDuplicateService', () => {
  let service: ContributorDuplicateService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma),
    );
    mockPrisma.contributorDuplicateFlag.findUniqueOrThrow.mockImplementation(
      ({ select }: { select: Record<string, unknown> }) =>
        Promise.resolve(
          'contributorA' in select ? FLAG_VIEW_ROW : FLAG_CONTRIBUTORS,
        ),
    );
    service = new ContributorDuplicateService(
      mockPrisma as unknown as PrismaService,
    );
  });

  describe('flagPossibleDuplicates', () => {
    it('raises flags and nothing else — no contributor or enrollment is ever touched by a match', async () => {
      mockPrisma.contributor.findMany.mockResolvedValue([
        { id: 'b', name: 'عمر محمد ملهي علي', accountNumber: '0203006' },
        { id: 'c', name: 'سمير محمد جازم', accountNumber: '0203004' },
      ]);
      mockPrisma.contributorDuplicateFlag.createMany.mockResolvedValue({
        count: 1,
      });

      const raised = await service.flagPossibleDuplicates({
        id: 'a',
        name: 'عمر محمد ملهي',
        accountNumber: '2402006',
      });

      expect(raised).toBe(1);
      expect(
        mockPrisma.contributorDuplicateFlag.createMany,
      ).toHaveBeenCalledWith({
        data: [
          {
            contributorAId: 'a',
            contributorBId: 'b',
            reasons: ['NAME_EXTENDS', 'SAME_SERIAL'],
          },
        ],
        skipDuplicates: true,
      });
      expect(mockPrisma.contributor.update).not.toHaveBeenCalled();
      expect(mockPrisma.contributor.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.programEnrollment.updateMany).not.toHaveBeenCalled();
    });

    it('raises nothing, and skips the insert, when no one looks alike', async () => {
      mockPrisma.contributor.findMany.mockResolvedValue([
        { id: 'c', name: 'سمير محمد جازم', accountNumber: '0203004' },
      ]);

      await expect(
        service.flagPossibleDuplicates({
          id: 'a',
          name: 'عمر محمد ملهي',
          accountNumber: '2402006',
        }),
      ).resolves.toBe(0);
      expect(
        mockPrisma.contributorDuplicateFlag.createMany,
      ).not.toHaveBeenCalled();
    });
  });

  describe('scanAll', () => {
    it('dedupes on the pair key, so a dismissed pair is never raised again', async () => {
      mockPrisma.contributor.findMany.mockResolvedValue([
        { id: 'a', name: 'عمر محمد ملهي', accountNumber: '2402006' },
        { id: 'b', name: 'عمر محمد ملهي علي', accountNumber: '0203006' },
      ]);
      mockPrisma.contributorDuplicateFlag.createMany.mockResolvedValue({
        count: 0,
      });

      const result = await service.scanAll();

      expect(
        mockPrisma.contributorDuplicateFlag.createMany.mock.calls[0][0]
          .skipDuplicates,
      ).toBe(true);
      expect(result).toMatchObject({ scanned: 2, candidates: 1, newFlags: 0 });
    });
  });

  describe('dismissFlag', () => {
    it('answers DUPLICATE_FLAG_ALREADY_RESOLVED when another reviewer decided first', async () => {
      mockPrisma.contributorDuplicateFlag.updateMany.mockResolvedValue({
        count: 0,
      });
      mockPrisma.contributorDuplicateFlag.findUnique.mockResolvedValue({
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
      mockPrisma.contributorDuplicateFlag.updateMany.mockResolvedValue({
        count: 1,
      });
      mockPrisma.contributor.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.contributor.findFirst.mockResolvedValue({
        id: 'pa',
        phone: null,
        email: 'kept@example.org',
      });
      mockPrisma.contributor.findUniqueOrThrow.mockResolvedValue({
        phone: '+967 1 234',
        email: 'other@example.org',
      });
    });

    it('moves the other record’s enrollments onto the kept one and retires it', async () => {
      mockPrisma.programEnrollment.findMany
        .mockResolvedValueOnce([{ programId: 'fund' }]) // kept
        .mockResolvedValueOnce([
          { programId: 'mwa', program: { name: 'مواساة', type: 'PERIODIC' } },
        ]); // merged away
      mockPrisma.programEnrollment.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.mergeFlag('u1', 'f1', {
        keepContributorId: 'pa',
      });

      // Retired conditionally, so a record merged away by someone else fails.
      expect(mockPrisma.contributor.updateMany).toHaveBeenCalledWith({
        where: { id: 'pb', isDeleted: false },
        data: {
          isDeleted: true,
          deletedAt: expect.any(Date),
          mergedIntoId: 'pa',
        },
      });
      expect(mockPrisma.programEnrollment.updateMany).toHaveBeenCalledWith({
        where: { contributorId: 'pb' },
        data: { contributorId: 'pa' },
      });
      // The kept record keeps its own email and only gains the missing phone.
      expect(mockPrisma.contributor.update).toHaveBeenCalledWith({
        where: { id: 'pa' },
        data: { phone: '+967 1 234', email: 'kept@example.org' },
      });
      expect(
        mockPrisma.contributorDuplicateFlag.deleteMany,
      ).toHaveBeenCalledWith({
        where: {
          status: 'OPEN',
          OR: [{ contributorAId: 'pb' }, { contributorBId: 'pb' }],
        },
      });
      expect(result).toMatchObject({
        keptContributorId: 'pa',
        mergedContributorId: 'pb',
        movedEnrollments: 1,
        successCode: 'CONTRIBUTOR_DUPLICATE_MERGE_SUCCESS',
      });
    });

    it('refuses when both records are enrolled in the same program, and moves nothing', async () => {
      mockPrisma.programEnrollment.findMany
        .mockResolvedValueOnce([{ programId: 'mwa' }])
        .mockResolvedValueOnce([
          { programId: 'mwa', program: { name: 'مواساة', type: 'PERIODIC' } },
        ]);

      await expect(
        service.mergeFlag('u1', 'f1', { keepContributorId: 'pa' }),
      ).rejects.toMatchObject({
        errorCode: 'CONTRIBUTOR_MERGE_CONFLICT',
        meta: {
          details: {
            blockers: [{ kind: 'PROGRAM', id: 'mwa', name: 'مواساة' }],
          },
        },
      });
      expect(mockPrisma.programEnrollment.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    });

    // Donor rows carry no pledge and dated gifts have no month key, so two
    // records that both gave to one campaign fold into the kept donor row.
    it('folds two donor rows in the same temporary program instead of refusing', async () => {
      mockPrisma.programEnrollment.findMany
        .mockResolvedValueOnce([{ programId: 'camp' }, { programId: 'fund' }])
        .mockResolvedValueOnce([
          { programId: 'camp', program: { name: 'حملة', type: 'TEMPORARY' } },
          { programId: 'mwa', program: { name: 'مواساة', type: 'PERIODIC' } },
        ]);
      mockPrisma.programEnrollment.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.mergeFlag('u1', 'f1', {
        keepContributorId: 'pa',
      });

      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
        where: { contributorId: 'pb', programId: { in: ['camp'] } },
        data: { contributorId: 'pa' },
      });
      expect(mockPrisma.programEnrollment.deleteMany).toHaveBeenCalledWith({
        where: { contributorId: 'pb', programId: { in: ['camp'] } },
      });
      // The gifts move before the emptied row is dropped — the other order
      // would be refused by the composite FK.
      expect(
        mockPrisma.payment.updateMany.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockPrisma.programEnrollment.deleteMany.mock.invocationCallOrder[0],
      );
      expect(result).toMatchObject({ movedEnrollments: 2 });
    });

    it('refuses to keep someone outside the flagged pair, before retiring anyone', async () => {
      await expect(
        service.mergeFlag('u1', 'f1', { keepContributorId: 'stranger' }),
      ).rejects.toMatchObject({ errorCode: 'DUPLICATE_MERGE_KEEP_INVALID' });
      expect(mockPrisma.contributor.updateMany).not.toHaveBeenCalled();
    });

    it('answers DUPLICATE_CONTRIBUTOR_GONE when the other record was merged away meanwhile', async () => {
      mockPrisma.contributor.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.mergeFlag('u1', 'f1', { keepContributorId: 'pa' }),
      ).rejects.toMatchObject({ errorCode: 'DUPLICATE_CONTRIBUTOR_GONE' });
      expect(mockPrisma.programEnrollment.updateMany).not.toHaveBeenCalled();
    });

    it('404s an unknown flag', async () => {
      mockPrisma.contributorDuplicateFlag.updateMany.mockResolvedValue({
        count: 0,
      });
      mockPrisma.contributorDuplicateFlag.findUnique.mockResolvedValue(null);

      await expect(
        service.mergeFlag('u1', 'nope', { keepContributorId: 'pa' }),
      ).rejects.toMatchObject({ errorCode: 'DUPLICATE_FLAG_NOT_FOUND' });
    });
  });
});
