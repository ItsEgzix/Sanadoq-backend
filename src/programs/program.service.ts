import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from 'generated/prisma/client';
import { AppException } from 'src/common/exceptions/app.exception';
import { isUniqueViolation } from 'src/common/utils/prisma-error.util';
import { CYCLE_SELECT, type CycleRow } from 'src/cycles/cycle.constant';
import { PrismaService } from 'src/prisma/prisma.service';
import type { CreateProgramDto } from './dto/create-program.dto';
import type { UpdateProgramDto } from './dto/update-program.dto';
import {
  PROGRAM_CAP,
  PROGRAM_FIELDS_SELECT,
  PROGRAM_ORDER_BY,
  PROGRAM_SELECT,
  type ProgramRow,
} from './program.constant';
import { toProgramView, type ProgramView } from './program.util';

type ProgramFieldsRow = Prisma.ProgramGetPayload<{
  select: typeof PROGRAM_FIELDS_SELECT;
}>;

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
    const [programs, currentCycles] = await Promise.all([
      this.prisma.program.findMany({
        orderBy: PROGRAM_ORDER_BY,
        take: PROGRAM_CAP,
        select: PROGRAM_FIELDS_SELECT,
      }),
      // Ordered like the programs, so the first PROGRAM_CAP current cycles
      // belong to exactly the programs listed (at most one each, by the
      // partial unique index "Cycle_single_current_per_program"). The
      // soft-delete extension never reaches into relation filters, so the
      // deleted programs are excluded by name.
      this.prisma.cycle.findMany({
        where: { isCurrent: true, program: { isDeleted: false } },
        orderBy: PROGRAM_ORDER_BY.map((order) => ({ program: order })),
        take: PROGRAM_CAP,
        select: CYCLE_SELECT,
      }),
    ]);
    return this.withCurrentCycles(programs, currentCycles).map(toProgramView);
  }

  async getProgram(programId: string): Promise<ProgramView> {
    return toProgramView(await this.assertProgramExists(programId));
  }

  // findFirst, not findUnique: only findFirst goes through the soft-delete
  // filter, and a deleted program must 404 like one that never existed.
  async assertProgramExists(programId: string): Promise<ProgramRow> {
    // Both at once: every read and write inside a program starts here, so a
    // sequential pair would put a second round trip in front of all of them.
    // The cycle of a deleted program is read and discarded.
    const [program, current] = await Promise.all([
      this.prisma.program.findFirst({
        where: { id: programId },
        select: PROGRAM_FIELDS_SELECT,
      }),
      this.prisma.cycle.findFirst({
        where: { programId, isCurrent: true },
        select: CYCLE_SELECT,
      }),
    ]);
    if (!program) {
      throw new AppException(
        'PROGRAM_NOT_FOUND',
        { programId },
        HttpStatus.NOT_FOUND,
      );
    }
    return this.withCurrentCycles([program], current ? [current] : [])[0];
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
    const typeChanged = dto.type !== undefined && dto.type !== existing.type;
    const shapeChanged =
      typeChanged ||
      (dto.hasCycles !== undefined && dto.hasCycles !== existing.hasCycles);
    if (shapeChanged) await this.assertShapeEditable(existing, typeChanged);

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
  // cycles would strand rows in a shape the program no longer reads. type
  // also decides whether the program has subscribers at all: a periodic
  // program's enrollments carry pledges a temporary one does not keep.
  private async assertShapeEditable(
    program: ProgramRow,
    typeChanged: boolean,
  ): Promise<void> {
    if (program.isProtected) {
      throw new AppException(
        'PROGRAM_PROTECTED_SHAPE',
        { programId: program.id },
        HttpStatus.CONFLICT,
      );
    }
    const [payments, cycles, enrollments] = await Promise.all([
      this.prisma.payment.count({ where: { programId: program.id } }),
      this.prisma.cycle.count({ where: { programId: program.id } }),
      typeChanged
        ? this.prisma.programEnrollment.count({
            where: { programId: program.id },
          })
        : 0,
    ]);
    if (payments > 0 || cycles > 0) {
      throw new AppException(
        'PROGRAM_SHAPE_LOCKED',
        { payments, cycles },
        HttpStatus.CONFLICT,
      );
    }
    if (enrollments > 0) {
      throw new AppException(
        'PROGRAM_TYPE_LOCKED',
        { enrollments },
        HttpStatus.CONFLICT,
      );
    }
  }

  // Rebuilds the PROGRAM_SELECT shape from the two parallel reads, so
  // toProgramView and every caller see what the nested select returned.
  private withCurrentCycles(
    programs: ProgramFieldsRow[],
    currentCycles: CycleRow[],
  ): ProgramRow[] {
    const byProgram = new Map(
      currentCycles.map((cycle) => [cycle.programId, cycle]),
    );
    return programs.map((program) => {
      const current = byProgram.get(program.id);
      return { ...program, cycles: current ? [current] : [] };
    });
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
