import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AppException } from '../common/exceptions/app.exception';
import { toMoneyString, ZERO } from '../common/utils/money.util';
import type { ListEnrollmentsQueryDto } from '../enrollments/dto/list-enrollments-query.dto';
import type { EnrollmentFieldsRow } from '../enrollments/enrollment.constant';
import { EnrollmentService } from '../enrollments/enrollment.service';
import { toEnrollmentView } from '../enrollments/enrollment.util';
import {
  PAYMENT_CELL_SELECT,
  PAYMENT_ENTRY_SELECT,
  type PaymentCellRow,
} from '../payments/payment.constant';
import { toPaymentEntryView } from '../payments/payment.util';
import { PROGRAM_CAP } from '../programs/program.constant';
import type { EntryMode, ProgramView } from '../programs/program.util';
import { PrismaService } from '../prisma/prisma.service';
import type { EradatYearQueryDto } from './dto/eradat-year-query.dto';
import type { LedgerQueryDto } from './dto/ledger-query.dto';
import type { LinesQueryDto } from './dto/lines-query.dto';
import { EradatArrearsService } from './eradat-arrears.service';
import { EradatWindowService, type ReadWindow } from './eradat-window.service';
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
    private readonly windowService: EradatWindowService,
    private readonly enrollmentService: EnrollmentService,
    private readonly arrearsService: EradatArrearsService,
  ) {}

  // Two round trips, each a few queries side by side: the window and the
  // page of enrollments, then the page's contributors and payments. Done one
  // after another these were five, and this is the request every grid waits
  // on. A page read for a program that turns out not to exist is discarded.
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
    const contributorIds = pageRows.map((row) => row.contributorId);
    const withContributors =
      this.enrollmentService.attachContributors(pageRows);

    let items;
    if (window.program.entryMode === 'MONTHLY') {
      const [rows, cells, earlier] = await Promise.all([
        withContributors,
        this.loadContributorCells(programId, contributorIds, window),
        this.loadEarlierSums(programId, window, 'contributorId', {
          contributorId: { in: contributorIds },
        }),
      ]);
      const due = monthsDue(window.year, now);
      items = rows.map((row) => {
        const rowCells = cells.get(row.contributorId) ?? [];
        return {
          ...toEnrollmentView(row),
          ...buildGridLine(
            rowCells,
            window.years,
            window.year,
            row.previousSubscription.plus(
              earlier.get(row.contributorId) ?? ZERO,
            ),
          ),
          // The same arrears() EradatArrearsService filters on, fed the same
          // year's money. null for a dormant enrollment, which nobody chases.
          arrears:
            row.status === 'ACTIVE'
              ? toMoneyString(
                  arrears(
                    row.expectedRate,
                    due,
                    yearlyTotal(rowCells, window.year),
                  ),
                )
              : null,
        };
      });
    } else {
      const [rows, sums] = await Promise.all([
        withContributors,
        this.loadContributorYearSums(programId, contributorIds, window),
      ]);
      items = rows.map((row) => ({
        ...toEnrollmentView(row),
        ...buildLedgerLine(
          sums.get(row.contributorId),
          window.years,
          window.year,
          row.previousSubscription,
        ),
        // A temporary program keeps no pledge, so nobody owes it anything.
        arrears: null,
      }));
    }
    return { year: window.year, years: window.years, items, nextCursor };
  }

  // The year decides who is behind, so here the window comes first and the
  // page waits on the arrears: one round trip more than the unfiltered grid,
  // paid only while the filter is on.
  private async loadBehindPage(
    programId: string,
    requested: number | undefined,
    listQuery: ListEnrollmentsQueryDto,
    now: Date,
  ): Promise<[ReadWindow, EnrollmentPage]> {
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
   * program's revenue; they never appear in the paying program's totals.
   */
  async getTransferLines(programId: string, { year }: EradatYearQueryDto) {
    const window = await this.windowService.resolve(programId, year);
    this.assertEntryMode(window.program, 'MONTHLY');

    const range = this.windowRange(window);
    const [cells, payers, earlier] = await Promise.all([
      this.prisma.payment.findMany({
        where: { programId, payerProgramId: { not: null }, year: range },
        select: { ...PAYMENT_CELL_SELECT, payerProgramId: true },
        // Bounded by construction — one cell per paying program per month —
        // but stated so a broken unique index cannot turn this into a scan.
        take: PROGRAM_CAP * window.years.length * 12,
      }),
      // The paying programs, found by the same filter through the relation
      // so this runs beside the cells instead of after them. The unfiltered
      // client: a payer deleted since is still named.
      this.prisma.raw.program.findMany({
        where: { paymentsMade: { some: { programId, year: range } } },
        select: { id: true, name: true, isProtected: true },
        take: PROGRAM_CAP,
      }),
      this.loadEarlierSums(programId, window, 'payerProgramId', {
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
          window.years,
          window.year,
          earlier.get(payerProgramId) ?? ZERO,
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

  // Every cell of the given contributors in the window, grouped by contributor.
  private async loadContributorCells(
    programId: string,
    contributorIds: string[],
    window: ReadWindow,
  ): Promise<Map<string, PaymentCellRow[]>> {
    const byContributor = new Map<string, PaymentCellRow[]>();
    if (contributorIds.length === 0) return byContributor;

    const cells = await this.prisma.payment.findMany({
      where: {
        programId,
        contributorId: { in: contributorIds },
        year: this.windowRange(window),
      },
      select: { contributorId: true, ...PAYMENT_CELL_SELECT },
      // Bounded by construction — at most one cell per contributor per month —
      // but stated so a broken unique index cannot turn this into a scan.
      take: contributorIds.length * window.years.length * 12,
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
    window: ReadWindow,
  ): Promise<Map<string, Map<number, Prisma.Decimal>>> {
    const byContributor = new Map<string, Map<number, Prisma.Decimal>>();
    if (contributorIds.length === 0) return byContributor;

    const rows = await this.prisma.payment.groupBy({
      by: ['contributorId', 'year'],
      where: {
        programId,
        contributorId: { in: contributorIds },
        year: this.windowRange(window),
      },
      _sum: { amount: true },
    });
    for (const row of rows) {
      if (!row.contributorId) continue;
      const years = byContributor.get(row.contributorId) ?? new Map();
      years.set(row.year, row._sum.amount ?? ZERO);
      byContributor.set(row.contributorId, years);
    }
    return byContributor;
  }

  // What each payer paid in the program's earlier cycles — the running years
  // before the current cycle — summed in SQL, since those years have no
  // cells on screen. Empty, with no query, while the current cycle is the
  // program's first.
  private async loadEarlierSums(
    programId: string,
    window: ReadWindow,
    by: 'contributorId' | 'payerProgramId',
    where: Prisma.PaymentWhereInput,
  ): Promise<Map<string, Prisma.Decimal>> {
    const sums = new Map<string, Prisma.Decimal>();
    const from = window.runningYears[0];
    const to = window.years[0];
    if (from === undefined || to === undefined || from >= to) return sums;

    const rows = await this.prisma.payment.groupBy({
      by: [by],
      where: { programId, year: { gte: from, lt: to }, ...where },
      _sum: { amount: true },
    });
    for (const row of rows) {
      const key = row[by];
      if (key) sums.set(key, row._sum.amount ?? ZERO);
    }
    return sums;
  }

  private windowRange(window: ReadWindow) {
    return { gte: window.years[0], lte: window.years[window.years.length - 1] };
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
