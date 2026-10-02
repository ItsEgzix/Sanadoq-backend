import { Injectable } from '@nestjs/common';
import { CycleService, type ProgramWindow } from '../cycles/cycle.service';
import { PrismaService } from '../prisma/prisma.service';

// Payment years are 2000..2100 (CHECK "Payment_year_range"), so this bounds
// the distinct-years read by construction.
const MAX_WINDOW_YEARS = 101;

export interface ReadWindow extends ProgramWindow {
  // The years running totals cover, oldest first: the current cycle's, or —
  // without cycles — every year the program has payments in, plus the one
  // being viewed.
  years: number[];
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
    const [window, rows] = await Promise.all([
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
    ]);
    if (window.cycle) return { ...window, years: window.cycle.years };

    const years = [...new Set([...rows.map((row) => row.year), window.year])];
    return { ...window, years: years.sort((a, b) => a - b) };
  }
}
