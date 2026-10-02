import { Injectable } from '@nestjs/common';
import { CycleService, type ProgramWindow } from '../cycles/cycle.service';
import { PrismaService } from '../prisma/prisma.service';

// Payment years are 2000..2100 (CHECK "Payment_year_range"), so this bounds
// the distinct-years read by construction.
const MAX_WINDOW_YEARS = 101;

export interface ReadWindow extends ProgramWindow {
  // The years of the book on screen, oldest first: the current cycle's, or —
  // without cycles — every year the program has payments in, plus the one
  // being viewed.
  years: number[];
  // The years every running total (الإجمالي) covers, oldest first: from the
  // program's first cycle through the current one. Earlier cycles stay in,
  // so a member's total does not fall back to their typed previous
  // subscription the day a new cycle becomes current — الاشتراك السابق is
  // what was paid before this system held the books, never re-typed per
  // cycle. Without cycles, the same as years.
  runningYears: number[];
}

/** Every year from `from` to `to`, inclusive. */
function yearRange(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/**
 * The window every read of a program's books is computed over. Shared by the
 * summary and the lines so both always agree on what "running" means.
 */
@Injectable()
export class EradatWindowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cycleService: CycleService,
  ) {}

  async resolve(
    programId: string,
    requestedYear?: number,
  ): Promise<ReadWindow> {
    const [window, rows, firstCycle] = await Promise.all([
      this.cycleService.resolveWindow(programId, requestedYear),
      // Read beside the program rather than after it. Only a program without
      // cycles uses it, but finding that out first would cost a round trip,
      // and this is one scan of the (programId, year) index.
      this.prisma.payment.groupBy({
        by: ['year'],
        where: { programId },
        orderBy: { year: 'asc' },
        take: MAX_WINDOW_YEARS,
      }),
      // Same reasoning: only a program with cycles uses it.
      this.prisma.cycle.aggregate({
        where: { programId },
        _min: { startYear: true },
      }),
    ]);
    if (window.cycle) {
      const { startYear, endYear } = window.cycle;
      const from = Math.min(firstCycle._min.startYear ?? startYear, startYear);
      return {
        ...window,
        years: window.cycle.years,
        runningYears: yearRange(from, endYear),
      };
    }

    const years = [...new Set([...rows.map((row) => row.year), window.year])];
    years.sort((a, b) => a - b);
    return { ...window, years, runningYears: years };
  }
}
