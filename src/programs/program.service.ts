import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from 'src/common/exceptions/app.exception';
import { isUniqueViolation } from 'src/common/utils/prisma-error.util';
import { PrismaService } from 'src/prisma/prisma.service';
import type { CreateProgramDto } from './dto/create-program.dto';
import type { UpdateProgramDto } from './dto/update-program.dto';
import {
  PROGRAM_CAP,
  PROGRAM_ORDER_BY,
  PROGRAM_SELECT,
  type ProgramRow,
} from './program.constant';
import { toProgramView, type ProgramView } from './program.util';

/**
 * Programs — every revenue stream, the fund's membership included.
 *
 * Protection is enforced here, not in the UI: the protected program (the
 * fund's membership, created by the baseline migration) can never be
 * deleted, and its type and hasCycles can never change, whoever asks. The
 * trigger "Program_guard_protected" repeats the rule in the database for
 * writes that never pass through this service.
 *
 * Exported for every module that works inside a program: cycles,
 * enrollments, payments and the read side.
 */
@Injectable()
export class ProgramService {
  constructor(private readonly prisma: PrismaService) {}

  async listPrograms(): Promise<ProgramView[]> {
    const programs = await this.prisma.program.findMany({
      orderBy: PROGRAM_ORDER_BY,
      take: PROGRAM_CAP,
      select: PROGRAM_SELECT,
    });
    return programs.map(toProgramView);
  }

  async getProgram(programId: string): Promise<ProgramView> {
    return toProgramView(await this.assertProgramExists(programId));
  }

  // findFirst, not findUnique: only findFirst goes through the soft-delete
  // filter, and a deleted program must 404 like one that never existed.
  async assertProgramExists(programId: string): Promise<ProgramRow> {
    const program = await this.prisma.program.findFirst({
      where: { id: programId },
      select: PROGRAM_SELECT,
    });
    if (!program) {
      throw new AppException(
        'PROGRAM_NOT_FOUND',
        { programId },
        HttpStatus.NOT_FOUND,
      );
    }
    return program;
  }

  async createProgram(dto: CreateProgramDto) {
    // Read-then-create can let two racing creates land one past the cap. The
    // cap is a sanity bound on the sidebar, not a quota, so that is acceptable.
    const existing = await this.prisma.program.aggregate({
      _count: { _all: true },
      _max: { sortOrder: true },
    });
    if (existing._count._all >= PROGRAM_CAP) {
      throw new AppException(
        'PROGRAM_LIMIT_REACHED',
        { limit: PROGRAM_CAP },
        HttpStatus.CONFLICT,
      );
    }
    try {
      const program = await this.prisma.program.create({
        data: {
          name: dto.name,
          type: dto.type,
          hasCycles: dto.hasCycles,
          sortOrder: dto.sortOrder ?? (existing._max.sortOrder ?? 0) + 1,
        },
        select: PROGRAM_SELECT,
      });
      return {
        ...toProgramView(program),
        successCode: 'PROGRAM_CREATE_SUCCESS',
      };
    } catch (err) {
      throw this.explainNameClash(err, dto.name);
    }
  }

  async updateProgram(programId: string, dto: UpdateProgramDto) {
    const existing = await this.assertProgramExists(programId);
    // Sending the current value back is not a change — a form that posts
    // every field must still be able to rename the protected program.
    const shapeChanged =
      (dto.type !== undefined && dto.type !== existing.type) ||
      (dto.hasCycles !== undefined && dto.hasCycles !== existing.hasCycles);
    if (shapeChanged) await this.assertShapeEditable(existing);

    try {
      const program = await this.prisma.program.update({
        where: { id: programId },
        data: dto,
        select: PROGRAM_SELECT,
      });
      return {
        ...toProgramView(program),
        successCode: 'PROGRAM_UPDATE_SUCCESS',
      };
    } catch (err) {
      throw this.explainNameClash(err, dto.name ?? existing.name);
    }
  }

  async deleteProgram(programId: string) {
    const existing = await this.assertProgramExists(programId);
    // Full stop, regardless of who asks: there is no role or flag that lets
    // the fund's own membership program go.
    if (existing.isProtected) {
      throw new AppException(
        'PROGRAM_PROTECTED',
        { programId },
        HttpStatus.CONFLICT,
      );
    }
    // Soft delete: the program's enrollments and payments stay, so a restore
    // brings its books back, and payments it made to other programs still
    // name it. A hard delete is refused by those rows' Restrict FKs anyway.
    await this.prisma.program.update({
      where: { id: programId },
      data: { isDeleted: true, deletedAt: new Date() },
    });
    return {
      id: programId,
      name: existing.name,
      successCode: 'PROGRAM_DELETE_SUCCESS',
    };
  }

  // type and hasCycles decide whether payments are monthly cells or dated
  // entries (programEntryMode). Flipping them under existing payments or
  // cycles would strand rows in a shape the program no longer reads.
  private async assertShapeEditable(program: ProgramRow): Promise<void> {
    if (program.isProtected) {
      throw new AppException(
        'PROGRAM_PROTECTED_SHAPE',
        { programId: program.id },
        HttpStatus.CONFLICT,
      );
    }
    const [payments, cycles] = await Promise.all([
      this.prisma.payment.count({ where: { programId: program.id } }),
      this.prisma.cycle.count({ where: { programId: program.id } }),
    ]);
    if (payments > 0 || cycles > 0) {
      throw new AppException(
        'PROGRAM_SHAPE_LOCKED',
        { payments, cycles },
        HttpStatus.CONFLICT,
      );
    }
  }

  // The partial unique index "Program_live_name_key" is the dedupe; a prior
  // read would race.
  private explainNameClash(err: unknown, name: string): unknown {
    if (!isUniqueViolation(err)) return err;
    return new AppException(
      'PROGRAM_NAME_TAKEN',
      { name },
      HttpStatus.CONFLICT,
    );
  }
}
