import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/exceptions/app.exception';
import type { ProgramRow } from '../programs/program.constant';
import { ProgramService } from '../programs/program.service';
import { toProgramView, type ProgramView } from '../programs/program.util';
import { PrismaService } from '../prisma/prisma.service';
import { CYCLE_LIST_CAP, CYCLE_SELECT, type CycleRow } from './cycle.constant';
import {
  clampYearToCycle,
  cycleEndYear,
  isYearInCycle,
  toCycleView,
  type CycleRange,
  type CycleView,
} from './cycle.util';
import type { CreateCycleDto } from './dto/create-cycle.dto';
import type { UpdateCycleDto } from './dto/update-cycle.dto';

// The slice of a client (or interactive transaction) the range guards read.
type CycleReader = Pick<PrismaService, 'cycle' | 'payment'>;

/** Which year of which program a read or write is about. */
export interface ProgramWindow {
  program: ProgramView;
  // Null exactly when the program has no cycles (continuous flow).
  cycle: CycleView | null;
  year: number;
}

/**
 * Each program's own cycles. The current cycle is the window that program's
 * running totals and grid read from, and the fence its writes stay inside.
 * Lengths are data because the fund has changed them before (5 → 4 years)
 * and may again (→ 3); two programs' cycles need not line up.
 *
 * Exported for PaymentModule and EradatModule via resolveWindow().
 */
@Injectable()
export class CycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly programService: ProgramService,
  ) {}

  /**
   * The program and the year a read or write targets. With cycles: the
   * requested year, which must sit in the current cycle, or this calendar
   * year clamped into it. Without: any year, defaulting to this one — there
   * is no boundary to fence it into. UTC is close enough for a default tab.
   */
  async resolveWindow(
    programId: string,
    requestedYear?: number,
  ): Promise<ProgramWindow> {
    const program = toProgramView(
      await this.programService.assertProgramExists(programId),
    );
    if (!program.hasCycles) {
      return {
        program,
        cycle: null,
        year: requestedYear ?? new Date().getUTCFullYear(),
      };
    }
    const cycle = program.currentCycle;
    if (!cycle) {
      throw new AppException(
        'CYCLE_CURRENT_NOT_FOUND',
        { programId, name: program.name },
        HttpStatus.NOT_FOUND,
      );
    }
    return { program, cycle, year: this.resolveYear(cycle, requestedYear) };
  }

  resolveYear(cycle: CycleRange, requested?: number): number {
    if (requested === undefined) {
      return clampYearToCycle(cycle, new Date().getUTCFullYear());
    }
    this.assertYearInCycle(cycle, requested);
    return requested;
  }

  // Payments outside the current cycle would never reach a running total, and
  // a future-year entry is the unconfirmed advance-payment flow
  // (PaymentService.recordAdvancePayment). Both stop here.
  assertYearInCycle(cycle: CycleRange, year: number): void {
    if (!isYearInCycle(cycle, year)) {
      throw new AppException('CYCLE_YEAR_OUT_OF_RANGE', {
        year,
        startYear: cycle.startYear,
        endYear: cycle.endYear,
      });
    }
  }

  async listCycles(programId: string): Promise<CycleView[]> {
    await this.assertProgramKeepsCycles(programId);
    const cycles = await this.prisma.cycle.findMany({
      where: { programId },
      orderBy: [{ startYear: 'desc' }, { id: 'desc' }],
      take: CYCLE_LIST_CAP,
      select: CYCLE_SELECT,
    });
    return cycles.map(toCycleView);
  }

  async getCurrentCycle(programId: string): Promise<CycleView> {
    const { cycle } = await this.resolveWindow(programId);
    if (!cycle) {
      // resolveWindow only returns null for a program without cycles.
      throw new AppException(
        'PROGRAM_HAS_NO_CYCLES',
        { programId },
        HttpStatus.CONFLICT,
      );
    }
    return cycle;
  }

  async createCycle(programId: string, dto: CreateCycleDto) {
    await this.assertProgramKeepsCycles(programId);
    const { startYear, lengthYears } = dto;
    const endYear = cycleEndYear(startYear, lengthYears);

    // One transaction: the overlap check, demoting the old current cycle and
    // creating the new one commit together, so the program never has two
    // current cycles or, by accident, none.
    const cycle = await this.prisma.$transaction(async (tx) => {
      await this.assertNoOverlap(tx, programId, { startYear, endYear });
      const hasCurrent =
        (await tx.cycle.count({ where: { programId, isCurrent: true } })) > 0;
      // A program's first cycle becomes current without asking — there is
      // nothing else its books could open on.
      const makeCurrent = dto.makeCurrent ?? !hasCurrent;
      if (makeCurrent && hasCurrent) {
        await tx.cycle.updateMany({
          where: { programId, isCurrent: true },
          data: { isCurrent: false },
        });
      }
      return tx.cycle.create({
        data: {
          programId,
          startYear,
          lengthYears,
          endYear,
          isCurrent: makeCurrent,
        },
        select: CYCLE_SELECT,
      });
    });
    return { ...toCycleView(cycle), successCode: 'CYCLE_CREATE_SUCCESS' };
  }

  async updateCycle(programId: string, cycleId: string, dto: UpdateCycleDto) {
    const existing = await this.findCycleOrThrow(programId, cycleId);
    const startYear = dto.startYear ?? existing.startYear;
    const lengthYears = dto.lengthYears ?? existing.lengthYears;
    const next = { startYear, endYear: cycleEndYear(startYear, lengthYears) };

    const cycle = await this.prisma.$transaction(async (tx) => {
      await this.assertNoOverlap(tx, programId, next, cycleId);
      await this.assertNoStrandedPayments(tx, programId, existing, next);
      return tx.cycle.update({
        where: { id: cycleId },
        data: { startYear, lengthYears, endYear: next.endYear },
        select: CYCLE_SELECT,
      });
    });
    return { ...toCycleView(cycle), successCode: 'CYCLE_UPDATE_SUCCESS' };
  }

  async activateCycle(programId: string, cycleId: string) {
    await this.findCycleOrThrow(programId, cycleId);
    const cycle = await this.prisma.$transaction(async (tx) => {
      // Demote first: the partial unique index
      // "Cycle_single_current_per_program" rejects a second current row even
      // for the instant between two statements.
      await tx.cycle.updateMany({
        where: { programId, isCurrent: true, NOT: { id: cycleId } },
        data: { isCurrent: false },
      });
      return tx.cycle.update({
        where: { id: cycleId },
        data: { isCurrent: true },
        select: CYCLE_SELECT,
      });
    });
    return { ...toCycleView(cycle), successCode: 'CYCLE_ACTIVATE_SUCCESS' };
  }

  // A program without cycles runs as continuous flow; giving it a cycle
  // anyway would fence its writes behind a boundary it does not have.
  private async assertProgramKeepsCycles(
    programId: string,
  ): Promise<ProgramRow> {
    const program = await this.programService.assertProgramExists(programId);
    if (!program.hasCycles) {
      throw new AppException(
        'PROGRAM_HAS_NO_CYCLES',
        { programId, name: program.name },
        HttpStatus.CONFLICT,
      );
    }
    return program;
  }

  // findFirst on (id, programId) so a cycle id from another program 404s
  // here instead of being reshaped through the wrong URL.
  private async findCycleOrThrow(
    programId: string,
    cycleId: string,
  ): Promise<CycleRow> {
    await this.assertProgramKeepsCycles(programId);
    const cycle = await this.prisma.cycle.findFirst({
      where: { id: cycleId, programId },
      select: CYCLE_SELECT,
    });
    if (!cycle) {
      throw new AppException(
        'CYCLE_NOT_FOUND',
        { cycleId },
        HttpStatus.NOT_FOUND,
      );
    }
    return cycle;
  }

  // Gives a translatable 409 naming the clashing cycle. EXCLUDE
  // "Cycle_no_overlap_per_program" is the backstop when two creates race
  // past this read.
  private async assertNoOverlap(
    db: CycleReader,
    programId: string,
    range: CycleRange,
    exceptCycleId?: string,
  ): Promise<void> {
    const clash = await db.cycle.findFirst({
      where: {
        programId,
        startYear: { lte: range.endYear },
        endYear: { gte: range.startYear },
        ...(exceptCycleId ? { NOT: { id: exceptCycleId } } : {}),
      },
      select: { startYear: true, endYear: true },
    });
    if (clash) {
      throw new AppException(
        'CYCLE_OVERLAP',
        { startYear: clash.startYear, endYear: clash.endYear },
        HttpStatus.CONFLICT,
      );
    }
  }

  // Shortening a cycle (4 → 3 years) must not silently drop a year of
  // payments out of every running total.
  private async assertNoStrandedPayments(
    db: CycleReader,
    programId: string,
    current: CycleRange,
    next: CycleRange,
  ): Promise<void> {
    const stranded = await db.payment.count({
      where: {
        programId,
        year: { gte: current.startYear, lte: current.endYear },
        OR: [{ year: { lt: next.startYear } }, { year: { gt: next.endYear } }],
      },
    });
    if (stranded > 0) {
      throw new AppException(
        'CYCLE_RANGE_STRANDS_PAYMENTS',
        { count: stranded },
        HttpStatus.CONFLICT,
      );
    }
  }
}
