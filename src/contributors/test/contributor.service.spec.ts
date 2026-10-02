import { Prisma } from 'generated/prisma/client';
import type { PrismaService } from 'src/prisma/prisma.service';
import type { ContributorDuplicateService } from '../contributor-duplicate.service';
import { ContributorService } from '../contributor.service';

const mockPrisma = {
  $transaction: jest.fn(),
  contributor: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  programEnrollment: { findMany: jest.fn(), groupBy: jest.fn() },
  program: { findMany: jest.fn() },
  payment: { groupBy: jest.fn() },
  contributorDuplicateFlag: { deleteMany: jest.fn() },
};
const mockDuplicates = { flagPossibleDuplicates: jest.fn() };

const CONTRIBUTOR = {
  id: 'p1',
  name: 'عمر محمد ملهي',
  accountNumber: '2402006',
  phone: null,
  email: null,
};

describe('ContributorService', () => {
  let service: ContributorService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockDuplicates.flagPossibleDuplicates.mockResolvedValue(0);
    mockPrisma.contributor.findFirst.mockResolvedValue({
      ...CONTRIBUTOR,
      enrollments: [],
    });
    service = new ContributorService(
      mockPrisma as unknown as PrismaService,
      mockDuplicates as unknown as ContributorDuplicateService,
    );
  });

  it('checks a new contributor against everyone else and reports how many flags it raised', async () => {
    mockPrisma.contributor.create.mockResolvedValue(CONTRIBUTOR);
    mockDuplicates.flagPossibleDuplicates.mockResolvedValue(2);

    const result = await service.createContributor({
      name: CONTRIBUTOR.name,
      accountNumber: CONTRIBUTOR.accountNumber,
    });

    expect(mockDuplicates.flagPossibleDuplicates).toHaveBeenCalledWith(
      CONTRIBUTOR,
    );
    expect(result).toMatchObject({
      possibleDuplicates: 2,
      successCode: 'CONTRIBUTOR_CREATE_SUCCESS',
    });
  });

  it('turns an account-number clash into CONTRIBUTOR_ACCOUNT_NUMBER_TAKEN', async () => {
    mockPrisma.contributor.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: '7.10.0',
      }),
    );

    await expect(
      service.createContributor({ name: 'x', accountNumber: '0203002' }),
    ).rejects.toMatchObject({
      errorCode: 'CONTRIBUTOR_ACCOUNT_NUMBER_TAKEN',
      meta: { accountNumber: '0203002' },
    });
    expect(mockDuplicates.flagPossibleDuplicates).not.toHaveBeenCalled();
  });

  it('re-checks for duplicates only when the name or number actually changed', async () => {
    mockPrisma.contributor.update.mockResolvedValue({
      ...CONTRIBUTOR,
      phone: '123',
    });

    await service.updateContributor('p1', { phone: '123' });

    expect(mockDuplicates.flagPossibleDuplicates).not.toHaveBeenCalled();
  });

  it('refuses to remove someone still enrolled anywhere, naming the programs, and removes nothing', async () => {
    mockPrisma.programEnrollment.findMany.mockResolvedValue([
      { program: { id: 'fund', name: 'اشتراكات الصندوق' } },
    ]);

    await expect(service.deleteContributor('p1')).rejects.toMatchObject({
      errorCode: 'CONTRIBUTOR_HAS_ENROLLMENTS',
      meta: {
        details: {
          blockers: [{ kind: 'PROGRAM', id: 'fund', name: 'اشتراكات الصندوق' }],
        },
      },
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('matches a typed account-number prefix as well as a name fragment', async () => {
    mockPrisma.contributor.findMany.mockResolvedValue([]);

    await service.listContributors({ limit: 20, q: '0203' });

    const { where } = mockPrisma.contributor.findMany.mock.calls[0][0];
    const [search] = where.AND;
    expect(search.OR).toContainEqual({ accountNumber: { startsWith: '0203' } });
    expect(search.OR).toContainEqual({
      name: { contains: '0203', mode: 'insensitive' },
    });
  });

  describe('listContributors filtered by program', () => {
    beforeEach(() => mockPrisma.contributor.findMany.mockResolvedValue([]));

    it('lists only those enrolled in a live copy of the program', async () => {
      await service.listContributors({ limit: 20, program: 'fund' });

      const { where } = mockPrisma.contributor.findMany.mock.calls[0][0];
      expect(where.AND[1]).toEqual({
        enrollments: {
          some: { programId: 'fund', program: { isDeleted: false } },
        },
      });
    });

    // An enrollment left in a deleted program must not hide someone from
    // the "in no program" list.
    it('treats "none" as enrolled in no live program', async () => {
      await service.listContributors({ limit: 20, program: 'none' });

      const { where } = mockPrisma.contributor.findMany.mock.calls[0][0];
      expect(where.AND[1]).toEqual({
        enrollments: { none: { program: { isDeleted: false } } },
      });
    });
  });

  describe('listContributors with a year', () => {
    const enrollment = (
      programId: string,
      type: string,
      hasCycles: boolean,
    ) => ({
      id: `e-${programId}`,
      programId,
      status: 'ACTIVE',
      expectedRate: new Prisma.Decimal(1200),
      previousSubscription: new Prisma.Decimal(0),
      program: { name: programId, isProtected: false, type, hasCycles },
    });

    it('skips the payments read when no one on the page is enrolled', async () => {
      mockPrisma.contributor.findMany.mockResolvedValue([
        { ...CONTRIBUTOR, enrollments: [] },
      ]);

      const result = await service.listContributors({ limit: 20, year: 2026 });

      expect(mockPrisma.payment.groupBy).not.toHaveBeenCalled();
      expect(result).toMatchObject({ year: 2026, items: [{ id: 'p1' }] });
    });

    it('gives each enrollment its own year, months on a grid and a count on a ledger', async () => {
      mockPrisma.contributor.findMany.mockResolvedValue([
        {
          ...CONTRIBUTOR,
          enrollments: [
            enrollment('fund', 'PERIODIC', true),
            enrollment('ramadan', 'TEMPORARY', false),
          ],
        },
      ]);
      mockPrisma.payment.groupBy.mockResolvedValue([
        {
          contributorId: 'p1',
          programId: 'fund',
          month: 1,
          isStarred: false,
          _sum: { amount: new Prisma.Decimal(100) },
          _count: { _all: 1 },
        },
        {
          contributorId: 'p1',
          programId: 'fund',
          month: 2,
          isStarred: true,
          _sum: { amount: null },
          _count: { _all: 1 },
        },
        {
          contributorId: 'p1',
          programId: 'ramadan',
          month: null,
          isStarred: false,
          _sum: { amount: new Prisma.Decimal(450) },
          _count: { _all: 3 },
        },
      ]);

      const result = await service.listContributors({ limit: 20, year: 2026 });

      expect(mockPrisma.payment.groupBy.mock.calls[0][0].where).toEqual({
        contributorId: { in: ['p1'] },
        year: 2026,
      });
      const [fund, ramadan] = result.items[0].enrollments as Array<{
        activity: unknown;
      }>;
      expect(fund.activity).toEqual({
        paid: '100.00',
        payments: 1,
        months: ['PAID', 'STARRED', ...Array(10).fill(null)],
      });
      expect(ramadan.activity).toEqual({
        paid: '450.00',
        payments: 3,
        months: null,
      });
    });

    it('leaves the year off when none was asked for — the enroll picker', async () => {
      mockPrisma.contributor.findMany.mockResolvedValue([
        { ...CONTRIBUTOR, enrollments: [enrollment('fund', 'PERIODIC', true)] },
      ]);

      const result = await service.listContributors({ limit: 8 });

      expect(mockPrisma.payment.groupBy).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('year');
      expect(result.items[0].enrollments[0]).not.toHaveProperty('activity');
    });
  });

  describe('getDirectoryStats', () => {
    it('counts each program, ACTIVE plus DORMANT, and lists programs with no one in them as zero', async () => {
      mockPrisma.contributor.count
        .mockResolvedValueOnce(153) // everyone
        .mockResolvedValueOnce(150) // in no program
        .mockResolvedValueOnce(4); // with a phone or email
      mockPrisma.programEnrollment.groupBy
        .mockResolvedValueOnce([{ contributorId: 'p1' }]) // in 2+ programs
        .mockResolvedValueOnce([
          { programId: 'ramadan', status: 'ACTIVE', _count: { _all: 2 } },
          { programId: 'ramadan', status: 'DORMANT', _count: { _all: 1 } },
        ]);
      mockPrisma.program.findMany.mockResolvedValue([
        { id: 'fund', name: 'اشتراكات الصندوق', isProtected: true },
        { id: 'ramadan', name: 'حملة رمضان', isProtected: false },
      ]);

      await expect(service.getDirectoryStats()).resolves.toEqual({
        total: 153,
        inNoProgram: 150,
        inSeveralPrograms: 1,
        withContact: 4,
        programs: [
          {
            id: 'fund',
            name: 'اشتراكات الصندوق',
            isProtected: true,
            enrolled: 0,
            dormant: 0,
          },
          {
            id: 'ramadan',
            name: 'حملة رمضان',
            isProtected: false,
            enrolled: 3,
            dormant: 1,
          },
        ],
      });
    });
  });
});
