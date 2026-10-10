import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_BOOK_YEARS } from './program.constant';
import { ProgramService } from './program.service';
import { thisYear, type ProgramView } from './program.util';

/** Which year of which program a page of its books is about. */
export interface ProgramWindow {
  program: ProgramView;
  year: number;
  // The years the year tabs offer, oldest first: every year the program's
  // books hold anything in — money received, paid out, or paid to another
  // program — plus this year and the year asked for. Not a fence: any year
  // can be opened and written, which is how the fund starts a new year or
  // goes back to fix an old one.
  years: number[];
}

/**
 * The year every read of a program's books is computed for, shared by the
 * revenue, expense and dashboard reads so the three pages always offer the
 * same years. There are no cycles: each year stands on its own.
 *
 * Exported by ProgramModule.
 */
@Injectable()
export class ProgramWindowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly programService: ProgramService,
  ) {}

  // One round trip: the program and the three year lists side by side. The
  // year lists for a program that turns out not to exist are discarded.
  async resolve(
    programId: string,
    requestedYear?: number,
  ): Promise<ProgramWindow> {
    const [program, received, spent, paidOut] = await Promise.all([
      this.programService.getProgram(programId),
      this.prisma.payment.groupBy({
        by: ['year'],
        where: { programId },
        orderBy: { year: 'asc' },
        take: MAX_BOOK_YEARS,
      }),
      this.prisma.expense.groupBy({
        by: ['year'],
        where: { programId },
        orderBy: { year: 'asc' },
        take: MAX_BOOK_YEARS,
      }),
      this.prisma.payment.groupBy({
        by: ['year'],
        where: { payerProgramId: programId },
        orderBy: { year: 'asc' },
        take: MAX_BOOK_YEARS,
      }),
    ]);
    const year = requestedYear ?? thisYear();
    const years = [
      ...new Set([
        ...[...received, ...spent, ...paidOut].map((row) => row.year),
        thisYear(),
        year,
      ]),
    ].sort((a, b) => a - b);
    return { program, year, years };
  }
}
