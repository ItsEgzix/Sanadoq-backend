import { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { UserService } from '../user.service';

jest.mock('../../auth/password.util', () => ({
  hashPassword: jest.fn().mockResolvedValue('$argon2id$hash'),
}));

const mockPrisma = {
  user: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

describe('UserService', () => {
  let service: UserService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u2' });
    service = new UserService(mockPrisma as unknown as PrismaService);
  });

  it('stores only the hash, never the password, and answers USER_EMAIL_TAKEN on a clash', async () => {
    mockPrisma.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: '7.10.0',
      }),
    );

    await expect(
      service.createUser({
        email: 'a@example.org',
        name: 'A',
        password: 'long-enough-1',
      }),
    ).rejects.toMatchObject({ errorCode: 'USER_EMAIL_TAKEN' });
    const { data } = mockPrisma.user.create.mock.calls[0][0];
    expect(data).toEqual({
      email: 'a@example.org',
      name: 'A',
      passwordHash: '$argon2id$hash',
    });
  });

  it('refuses to let a user switch themselves off', async () => {
    await expect(
      service.updateUser('u1', 'u1', { isActive: false }),
    ).rejects.toMatchObject({ errorCode: 'USER_CANNOT_DEACTIVATE_SELF' });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('ends every session of an account the moment it is deactivated', async () => {
    mockPrisma.user.update.mockResolvedValue({ id: 'u2', isActive: false });

    await service.updateUser('u1', 'u2', { isActive: false });

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { isActive: false, tokenVersion: { increment: 1 } },
      }),
    );
  });

  it('leaves sessions alone for a rename', async () => {
    mockPrisma.user.update.mockResolvedValue({ id: 'u2', name: 'B' });

    await service.updateUser('u1', 'u2', { name: 'B' });

    expect(mockPrisma.user.update.mock.calls[0][0].data).toEqual({ name: 'B' });
  });

  it('sends your own password change to the route that checks the current one', async () => {
    await expect(
      service.resetPassword('u1', 'u1', { password: 'long-enough-1' }),
    ).rejects.toMatchObject({ errorCode: 'USER_RESET_OWN_PASSWORD' });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('404s an unknown account before writing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(
      service.updateUser('u1', 'ghost', { name: 'x' }),
    ).rejects.toMatchObject({ errorCode: 'USER_NOT_FOUND' });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});
