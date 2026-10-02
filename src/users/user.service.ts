import { HttpStatus, Injectable } from '@nestjs/common';
import { hashPassword } from '../auth/password.util';
import { AppException } from '../common/exceptions/app.exception';
import { isUniqueViolation } from '../common/utils/prisma-error.util';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateUserDto } from './dto/create-user.dto';
import type { ResetPasswordDto } from './dto/reset-password.dto';
import type { UpdateUserDto } from './dto/update-user.dto';
import { USER_LIST_CAP, USER_SELECT, type UserRow } from './user.constant';

/**
 * The accounts that can sign in — a plain list, every one equal while there
 * is a single role. Accounts are deactivated, never deleted, so payments and
 * duplicate decisions keep pointing at who made them.
 */
@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  // A plain array: USER_LIST_CAP bounds it by design.
  listUsers(): Promise<UserRow[]> {
    return this.prisma.user.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      take: USER_LIST_CAP,
      select: USER_SELECT,
    });
  }

  async createUser(dto: CreateUserDto) {
    try {
      const user = await this.prisma.user.create({
        data: {
          email: dto.email,
          name: dto.name,
          passwordHash: await hashPassword(dto.password),
        },
        select: USER_SELECT,
      });
      return { ...user, successCode: 'USER_CREATE_SUCCESS' };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      throw new AppException(
        'USER_EMAIL_TAKEN',
        { email: dto.email },
        HttpStatus.CONFLICT,
      );
    }
  }

  async updateUser(actorId: string, userId: string, dto: UpdateUserDto) {
    await this.assertUserExists(userId);
    // Nobody switches themselves off. Since the caller is active, this also
    // guarantees at least one active account always remains to sign in with.
    if (dto.isActive === false && userId === actorId) {
      throw new AppException(
        'USER_CANNOT_DEACTIVATE_SELF',
        {},
        HttpStatus.CONFLICT,
      );
    }
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...dto,
        // Deactivating ends every session the account holds right now, not
        // when its access token happens to expire.
        ...(dto.isActive === false ? { tokenVersion: { increment: 1 } } : {}),
      },
      select: USER_SELECT,
    });
    return { ...user, successCode: 'USER_UPDATE_SUCCESS' };
  }

  /** Sets another user's password and signs them out everywhere. */
  async resetPassword(actorId: string, userId: string, dto: ResetPasswordDto) {
    // Your own password goes through POST /auth/password, which checks the
    // current one — otherwise a borrowed, unlocked session could lock you out.
    if (userId === actorId) {
      throw new AppException(
        'USER_RESET_OWN_PASSWORD',
        {},
        HttpStatus.CONFLICT,
      );
    }
    await this.assertUserExists(userId);
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(dto.password),
        tokenVersion: { increment: 1 },
      },
      select: USER_SELECT,
    });
    return { ...user, successCode: 'USER_PASSWORD_RESET_SUCCESS' };
  }

  private async assertUserExists(userId: string): Promise<void> {
    const found = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!found) {
      throw new AppException(
        'USER_NOT_FOUND',
        { userId },
        HttpStatus.NOT_FOUND,
      );
    }
  }
}
