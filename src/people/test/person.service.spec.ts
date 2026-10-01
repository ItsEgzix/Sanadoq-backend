import { Prisma } from 'generated/prisma/client';
import type { PrismaService } from 'src/prisma/prisma.service';
import type { PersonDuplicateService } from '../person-duplicate.service';
import { PersonService } from '../person.service';

const mockPrisma = {
  $transaction: jest.fn(),
  person: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  programEnrollment: { findMany: jest.fn() },
  personDuplicateFlag: { deleteMany: jest.fn() },
};
const mockDuplicates = { flagPossibleDuplicates: jest.fn() };

const PERSON = {
  id: 'p1',
  name: 'عمر محمد ملهي',
  accountNumber: '2402006',
  phone: null,
  email: null,
};

describe('PersonService', () => {
  let service: PersonService;

  beforeEach(() => {
    jest.resetAllMocks();
    mockDuplicates.flagPossibleDuplicates.mockResolvedValue(0);
    mockPrisma.person.findFirst.mockResolvedValue({
      ...PERSON,
      enrollments: [],
    });
    service = new PersonService(
      mockPrisma as unknown as PrismaService,
      mockDuplicates as unknown as PersonDuplicateService,
    );
  });

  it('checks a new person against everyone else and reports how many flags it raised', async () => {
    mockPrisma.person.create.mockResolvedValue(PERSON);
    mockDuplicates.flagPossibleDuplicates.mockResolvedValue(2);

    const result = await service.createPerson({
      name: PERSON.name,
      accountNumber: PERSON.accountNumber,
    });

    expect(mockDuplicates.flagPossibleDuplicates).toHaveBeenCalledWith(PERSON);
    expect(result).toMatchObject({
      possibleDuplicates: 2,
      successCode: 'PERSON_CREATE_SUCCESS',
    });
  });

  it('turns an account-number clash into PERSON_ACCOUNT_NUMBER_TAKEN', async () => {
    mockPrisma.person.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: '7.10.0',
      }),
    );

    await expect(
      service.createPerson({ name: 'x', accountNumber: '0203002' }),
    ).rejects.toMatchObject({
      errorCode: 'PERSON_ACCOUNT_NUMBER_TAKEN',
      meta: { accountNumber: '0203002' },
    });
    expect(mockDuplicates.flagPossibleDuplicates).not.toHaveBeenCalled();
  });

  it('re-checks for duplicates only when the name or number actually changed', async () => {
    mockPrisma.person.update.mockResolvedValue({ ...PERSON, phone: '123' });

    await service.updatePerson('p1', { phone: '123' });

    expect(mockDuplicates.flagPossibleDuplicates).not.toHaveBeenCalled();
  });

  it('refuses to remove someone still enrolled anywhere, naming the programs, and removes nothing', async () => {
    mockPrisma.programEnrollment.findMany.mockResolvedValue([
      { program: { id: 'fund', name: 'اشتراكات الصندوق' } },
    ]);

    await expect(service.deletePerson('p1')).rejects.toMatchObject({
      errorCode: 'PERSON_HAS_ENROLLMENTS',
      meta: {
        details: {
          blockers: [{ kind: 'PROGRAM', id: 'fund', name: 'اشتراكات الصندوق' }],
        },
      },
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('matches a typed account-number prefix as well as a name fragment', async () => {
    mockPrisma.person.findMany.mockResolvedValue([]);

    await service.listPeople({ limit: 20, q: '0203' });

    const { where } = mockPrisma.person.findMany.mock.calls[0][0];
    expect(where.OR).toContainEqual({ accountNumber: { startsWith: '0203' } });
    expect(where.OR).toContainEqual({
      name: { contains: '0203', mode: 'insensitive' },
    });
  });
});
