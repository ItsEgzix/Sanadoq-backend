import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AppException } from '../common/exceptions/app.exception';
import { toMoneyString, ZERO } from '../common/utils/money.util';
import type { ListEnrollmentsQueryDto } from '../enrollments/dto/list-enrollments-query.dto';
import type { EnrollmentFieldsRow } from '../enrollments/enrollment.constant';
import { EnrollmentTermService } from '../enrollments/enrollment-term.service';
import { owedFor, termsOrFallback } from '../enrollments/enrollment-term.util';
import { EnrollmentService } from '../enrollments/enrollment.service';
import { toEnrollmentView } from '../enrollments/enrollment.util';
import {
  PAYMENT_CELL_SELECT,
  PAYMENT_ENTRY_SELECT,
  type PaymentCellRow,
} from '../payments/payment.constant';
import { toPaymentEntryView } from '../payments/payment.util';
import { MAX_BOOK_YEARS, PROGRAM_CAP } from '../programs/program.constant';
import {
  ProgramWindowService,
  type ProgramWindow,
} from '../programs/program-window.service';
import type { EntryMode, ProgramView } from '../programs/program.util';
import { PrismaService } from '../prisma/prisma.service';
import type { EradatYearQueryDto } from './dto/eradat-year-query.dto';
import type { LedgerQueryDto } from './dto/ledger-query.dto';
import type { LinesQueryDto } from './dto/lines-query.dto';
import { EradatArrearsService } from './eradat-arrears.service';
import {
  arrears,
  buildGridLine,
  buildLedgerLine,
  monthsDue,
  yearlyTotal,
} from './revenue.util';

type EnrollmentPage = {
  rows: EnrollmentFieldsRow[];
  nextCursor: string | null;
};

/**
 * The rows of a program's books: one line per enrollment (with month cells
 * on a monthly grid), one line per paying program on a monthly grid, and the
 * dated entries of a ledger. Reads only — PaymentService writes.
 */
@Injectable()
export class EradatLinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly windowService: ProgramWindowService,
    private readonly enrollmentService: EnrollmentService,
    private readonly termService: EnrollmentTermService,
    private readonly arrearsService: EradatArrearsService,
  ) {}

  // Two round trips, each a few queries side by side: the window and the
  // page of enrollments, then the page's contributors, payments and terms.
  // Done one after another these were six, and this is the request every
  // grid waits on. A page read for a program that turns out not to exist is
  // discarded.
  async getEnrollmentLines(
    programId: string,
    { year: requested, behind, ...listQuery }: LinesQueryDto,
  ) {
    // One clock for the request, so a row's arrears and the filter that
    // picked it agree even across a month boundary.
    const now = new Date();
    const [window, { rows: pageRows, nextCursor }] = behind
      ? await this.loadBehindPage(programId, requested, listQuery, now)
      : await Promise.all([
          this.windowService.resolve(programId, requested),
          this.enrollmentService.listEnrollmentPage(programId, listQuery),
        ]);
    const { year } = window;
    const contributorIds = pageRows.map((row) => row.contributorId);
    const withContributors =
      this.enrollmentService.attachContributors(pageRows);

    let items;
    if (window.program.entryMode === 'MONTHLY') {
      const [rows, cells, otherYears, termsByEnrollment] = await Promise.all([
        withContributors,
        this.loadContributorCells(programId, contributorIds, year),
        this.loadOtherYearSums(programId, year, 'contributorId', {
          contributorId: { in: contributorIds },
        }),
        this.termService.loadTerms(
          { enrollmentIds: pageRows.map((row) => row.id) },
          year,
        ),
      ]);
      const due = monthsDue(year, now);
      items = rows.map((row) => {
        const rowCells = cells.get(row.contributorId) ?? [];
        const terms = termsOrFallback(row, termsByEnrollment.get(row.id));
        return {
          ...toEnrollmentView(row),
          ...buildGridLine(
            rowCells,
            year,
            row.previousSubscription.plus(
              otherYears.get(row.contributorId) ?? ZERO,
            ),
          ),
          // The same owedFor() and arrears() EradatArrearsService filters on,
          // fed the same year's money — so a dormant member still shows what
          // they owe for the months before they were frozen.
          arrears: toMoneyString(
            arrears(owedFor(terms, year, due), yearlyTotal(rowCells, year)),
          ),
        };
      });
    } else {
      const [rows, sums] = await Promise.all([
        withContributors,
        this.loadContributorYearSums(programId, contributorIds),
      ]);
      items = rows.map((row) => ({
        ...toEnrollmentView(row),
        ...buildLedgerLine(
          sums.get(row.contributorId),
          year,
          row.previousSubscription,
        ),
        // A temporary program keeps no pledge, so nobody owes it anything.
        arrears: null,
      }));
    }
    return { year, years: window.years, items, nextCursor };
  }

  // The year decides who is behind, so here the window comes first and the
  // page waits on the arrears: one round trip more than the unfiltered grid,
  // paid only while the filter is on.
  private async loadBehindPage(
    programId: string,
    requested: number | undefined,
    listQuery: ListEnrollmentsQueryDto,
    now: Date,
  ): Promise<[ProgramWindow, EnrollmentPage]> {
    const window = await this.windowService.resolve(programId, requested);
    const none: EnrollmentPage = { rows: [], nextCursor: null };
    // A temporary program keeps no pledges, so nobody in it is behind.
    if (window.program.entryMode !== 'MONTHLY') return [window, none];

    const { behind } = await this.arrearsService.loadArrears(
      programId,
      window.year,
      now,
    );
    if (behind.size === 0) return [window, none];
    const page = await this.enrollmentService.listEnrollmentPage(
      programId,
      listQuery,
      [...behind.keys()],
    );
    return [window, page];
  }

  /**
   * On a monthly grid, one line per program that pays into this one — the
   * fund's monthly contribution to مواساة, say. These lines are this
   * program's revenue and the paying program's expense; they never appear in
   * the paying program's revenue.
   */
  async getTransferLines(programId: string, { year }: EradatYearQueryDto) {
    const window = await this.windowService.resolve(programId, year);
    this.assertEntryMode(window.program, 'MONTHLY');

    const [cells, payers, otherYears] = await Promise.all([
      this.prisma.payment.findMany({
        where: { programId, payerProgramId: { not: null }, year: window.year },
        select: { ...PAYMENT_CELL_SELECT, payerProgramId: true },
        // Bounded by construction — one cell per paying program per month —
        // but stated so a broken unique index cannot turn this into a scan.
        take: PROGRAM_CAP * 12,
      }),
      // The paying programs, found by the same filter through the relation
      // so this runs beside the cells instead of after them. The unfiltered
      // client: a payer deleted since is still named.
      this.prisma.raw.program.findMany({
        where: { paymentsMade: { some: { programId, year: window.year } } },
        select: { id: true, name: true, isProtected: true },
        take: PROGRAM_CAP,
      }),
      this.loadOtherYearSums(programId, window.year, 'payerProgramId', {
        payerProgramId: { not: null },
      }),
    ]);
    const payerById = new Map(payers.map(({ id, ...payer }) => [id, payer]));

    const byPayer = new Map<
      string,
      { name: string; isProtected: boolean; cells: PaymentCellRow[] }
    >();
    for (const { payerProgramId, ...cell } of cells) {
      const payerProgram = payerProgramId && payerById.get(payerProgramId);
      if (!payerProgramId || !payerProgram) continue;
      const line = byPayer.get(payerProgramId);
      if (line) line.cells.push(cell);
      else byPayer.set(payerProgramId, { ...payerProgram, cells: [cell] });
    }

    const items = [...byPayer.entries()]
      .map(([payerProgramId, { cells: lineCells, ...payer }]) => ({
        payerProgramId,
        ...payer,
        ...buildGridLine(
          lineCells,
          window.year,
          otherYears.get(payerProgramId) ?? ZERO,
        ),
      }))
      // The fund first, like everywhere else, then by name.
      .sort(
        (a, b) =>
          Number(b.isProtected) - Number(a.isProtected) ||
          a.name.localeCompare(b.name),
      );
    return { year: window.year, items };
  }

  /** A ledger program's dated entries for one year, newest first. */
  async getLedger(
    programId: string,
    { year: requested, cursor, limit }: LedgerQueryDto,
  ) {
    const window = await this.windowService.resolve(programId, requested);
    this.assertEntryMode(window.program, 'DATED');

    // One extra row says whether another page exists without a count().
    const found = await this.prisma.payment.findMany({
      where: { programId, year: window.year },
      orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: PAYMENT_ENTRY_SELECT,
    });
    const hasMore = found.length > limit;
    const rows = hasMore ? found.slice(0, limit) : found;
    return {
      year: window.year,
      items: rows.map(toPaymentEntryView),
      nextCursor: hasMore ? rows[rows.length - 1].id : null,
    };
  }

  // Every cell of the given contributors in the year, grouped by contributor.
  private async loadContributorCells(
    programId: string,
    contributorIds: string[],
    year: number,
  ): Promise<Map<string, PaymentCellRow[]>> {
    const byContributor = new Map<string, PaymentCellRow[]>();
    if (contributorIds.length === 0) return byContributor;

    const cells = await this.prisma.payment.findMany({
      where: { programId, contributorId: { in: contributorIds }, year },
      select: { contributorId: true, ...PAYMENT_CELL_SELECT },
      // Bounded by construction — at most one cell per contributor per month —
      // but stated so a broken unique index cannot turn this into a scan.
      take: contributorIds.length * 12,
    });
    for (const { contributorId, ...cell } of cells) {
      if (!contributorId) continue;
      const list = byContributor.get(contributorId);
      if (list) list.push(cell);
      else byContributor.set(contributorId, [cell]);
    }
    return byContributor;
  }

  // A ledger can hold any number of entries per contributor, so totals come
  // from SQL rather than fetched rows: at most one group per contributor per
  // year.
  private async loadContributorYearSums(
    programId: string,
    contributorIds: string[],
  ): Promise<Map<string, Map<number, Prisma.Decimal>>> {
    const byContributor = new Map<string, Map<number, Prisma.Decimal>>();
    if (contributorIds.length === 0) return byContributor;

    const rows = await this.prisma.payment.groupBy({
      by: ['contributorId', 'year'],
      where: { programId, contributorId: { in: contributorIds } },
      _sum: { amount: true },
      orderBy: [{ contributorId: 'asc' }, { year: 'asc' }],
      take: contributorIds.length * MAX_BOOK_YEARS,
    });
    for (const row of rows) {
      if (!row.contributorId) continue;
      const years = byContributor.get(row.contributorId) ?? new Map();
      years.set(row.year, row._sum.amount ?? ZERO);
      byContributor.set(row.contributorId, years);
    }
    return byContributor;
  }

  // What each payer paid in every year but the one on screen, summed in SQL —
  // the rest of the running total, whose cells are not on screen.
  private async loadOtherYearSums(
    programId: string,
    year: number,
    by: 'contributorId' | 'payerProgramId',
    where: Prisma.PaymentWhereInput,
  ): Promise<Map<string, Prisma.Decimal>> {
    const rows = await this.prisma.payment.groupBy({
      by: [by],
      where: { programId, year: { not: year }, ...where },
      _sum: { amount: true },
    });
    const sums = new Map<string, Prisma.Decimal>();
    for (const row of rows) {
      const key = row[by];
      if (key) sums.set(key, row._sum.amount ?? ZERO);
    }
    return sums;
  }

  private assertEntryMode(program: ProgramView, mode: EntryMode): void {
    if (program.entryMode === mode) return;
    throw new AppException(
      mode === 'MONTHLY' ? 'PROGRAM_NOT_MONTHLY' : 'PROGRAM_NOT_DATED',
      { name: program.name },
      HttpStatus.CONFLICT,
    );
  }
}
