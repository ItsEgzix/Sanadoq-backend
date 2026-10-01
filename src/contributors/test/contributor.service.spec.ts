import { Prisma } from 'generated/prisma/client';
import type { PrismaService } from 'src/prisma/prisma.service';
import type { ContributorDuplicateService } from '../contributor-duplicate.service';
import { ContributorService } from '../contributor.service';

const mockPrisma = {
  $transaction: jest.fn(),
  contributor: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  programEnrollment: { findMany: jest.fn() },
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
    expect(where.OR).toContainEqual({ accountNumber: { startsWith: '0203' } });
    expect(where.OR).toContainEqual({
      name: { contains: '0203', mode: 'insensitive' },
    });
  });
});
