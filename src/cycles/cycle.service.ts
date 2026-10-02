import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/exceptions/app.exception';
import type { ProgramRow } from '../programs/program.constant';
import { ProgramService } from '../programs/program.service';
import {
  runsInCycles,
  toProgramView,
  type ProgramView,
} from '../programs/program.util';
import { PrismaService } from '../prisma/prisma.service';
import { CYCLE_LIST_CAP, CYCLE_SELECT, type CycleRow } from './cycle.constant';
import {
  clampYearToCycle,
  cycleEndYear,
  isYearInCycle,
  removedYears,
  toCycleView,
  type CycleRange,
  type CycleView,
} from './cycle.util';
import type { CreateCycleDto } from './dto/create-cycle.dto';
import type { SplitCycleDto } from './dto/split-cycle.dto';
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
   * The program and the year a read or write targets. A periodic program:
   * the requested year, which must sit in the current cycle, or this calendar
   * year clamped into it. A temporary one: any year, defaulting to this one —
   * it has no cycle to fence it into. UTC is close enough for a default tab.
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

    this.assertKeepsThisYear(existing, [next]);

    const cycle = await this.prisma.$transaction(async (tx) => {
      await this.assertNoOverlap(tx, programId, next, cycleId);
      await this.assertNoStrandedPayments(tx, programId, existing, next);
      await this.assertNoGap(tx, programId, cycleId, existing, [next]);
      return tx.cycle.update({
        where: { id: cycleId },
        data: { startYear, lengthYears, endYear: next.endYear },
        select: CYCLE_SELECT,
      });
    });
    return { ...toCycleView(cycle), successCode: 'CYCLE_UPDATE_SUCCESS' };
  }

  /**
   * Shortens a cycle and starts the next one the year after, in one
   * transaction. Payments are stored by year, not by cycle, so the years cut
   * off simply become the new cycle's — with every payment in them — and
   * nothing has to be deleted to change a cycle's length.
   *
   * The new cycle becomes current only when this was the current cycle and
   * this year now falls in the new one; otherwise currency stays put.
   */
  async splitCycle(programId: string, cycleId: string, dto: SplitCycleDto) {
    const existing = await this.findCycleOrThrow(programId, cycleId);
    if (dto.lengthYears >= existing.lengthYears) {
      throw new AppException('CYCLE_SPLIT_NOT_SHORTER', {
        lengthYears: existing.lengthYears,
      });
    }
    const kept: CycleRange = {
      startYear: existing.startYear,
      endYear: cycleEndYear(existing.startYear, dto.lengthYears),
    };
    const nextStart = kept.endYear + 1;
    const next: CycleRange = {
      startYear: nextStart,
      endYear: cycleEndYear(nextStart, dto.nextLengthYears),
    };
    // Both halves together: what the program's cycles cover after the split.
    const span = { startYear: kept.startYear, endYear: next.endYear };
    this.assertKeepsThisYear(existing, [kept, next]);
    const thisYear = new Date().getUTCFullYear();
    const nextIsCurrent =
      existing.isCurrent &&
      !isYearInCycle(kept, thisYear) &&
      isYearInCycle(next, thisYear);

    const [shortened, created] = await this.prisma.$transaction(async (tx) => {
      await this.assertNoOverlap(tx, programId, span, cycleId);
      await this.assertNoStrandedPayments(tx, programId, existing, span);
      await this.assertNoGap(tx, programId, cycleId, existing, [kept, next]);
      // Shrink first: until it does, the new cycle would overlap it and
      // EXCLUDE "Cycle_no_overlap_per_program" would refuse the insert. The
      // demotion rides on the same update, ahead of the insert, so the
      // per-program current index never sees two.
      const updated = await tx.cycle.update({
        where: { id: cycleId },
        data: {
          lengthYears: dto.lengthYears,
          endYear: kept.endYear,
          ...(nextIsCurrent ? { isCurrent: false } : {}),
        },
        select: CYCLE_SELECT,
      });
      const inserted = await tx.cycle.create({
        data: {
          programId,
          startYear: next.startYear,
          lengthYears: dto.nextLengthYears,
          endYear: next.endYear,
          isCurrent: nextIsCurrent,
        },
        select: CYCLE_SELECT,
      });
      return [updated, inserted];
    });
    return {
      startYear: shortened.startYear,
      endYear: shortened.endYear,
      nextStartYear: created.startYear,
      nextEndYear: created.endYear,
      cycles: [toCycleView(shortened), toCycleView(created)],
      successCode: 'CYCLE_SPLIT_SUCCESS',
    };
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

  // A temporary program is one need, collected once; giving it a cycle would
  // fence its gifts behind a boundary it does not have.
  private async assertProgramKeepsCycles(
    programId: string,
  ): Promise<ProgramRow> {
    const program = await this.programService.assertProgramExists(programId);
    if (!runsInCycles(program)) {
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

  // The current cycle is the fence every write stays inside. A change that
  // moves this year out of it would refuse every payment for this year, with
  // no warning, until someone created and activated another cycle.
  private assertKeepsThisYear(existing: CycleRow, after: CycleRange[]): void {
    const year = new Date().getUTCFullYear();
    if (!existing.isCurrent || !isYearInCycle(existing, year)) return;
    if (after.some((range) => isYearInCycle(range, year))) return;
    throw new AppException(
      'CYCLE_CURRENT_DROPS_THIS_YEAR',
      { year, startYear: existing.startYear, endYear: existing.endYear },
      HttpStatus.CONFLICT,
    );
  }

  // A year cut from this cycle that sits between two of the program's
  // cycles would belong to none of them: no cycle could ever be made current
  // with it inside, so its payments could never be recorded or read. Years
  // cut from the far end, with no cycle after them yet, are fine — the next
  // cycle will start there.
  private async assertNoGap(
    db: CycleReader,
    programId: string,
    cycleId: string,
    before: CycleRange,
    after: CycleRange[],
  ): Promise<void> {
    const outside = removedYears(before, {
      startYear: Math.min(...after.map((range) => range.startYear)),
      endYear: Math.max(...after.map((range) => range.endYear)),
    });
    if (outside.length === 0) return;
    const others = await db.cycle.findMany({
      where: { programId, NOT: { id: cycleId } },
      select: { startYear: true, endYear: true },
      take: CYCLE_LIST_CAP,
    });
    const ranges = [...others, ...after];
    const gap = outside.filter(
      (year) =>
        ranges.some((range) => range.endYear < year) &&
        ranges.some((range) => range.startYear > year),
    );
    if (gap.length > 0) {
      const [first, last] = [gap[0], gap[gap.length - 1]];
      throw new AppException(
        'CYCLE_LEAVES_GAP',
        { years: first === last ? `${first}` : `${first}–${last}` },
        HttpStatus.CONFLICT,
      );
    }
  }

  // Shortening a cycle (4 → 3 years) must not silently drop a year of
  // payments out of every running total. splitCycle passes both halves as
  // one range, so the cut years count as kept when the new cycle takes them.
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
