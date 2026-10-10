import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { sumMoney, ZERO } from '../common/utils/money.util';
import { EnrollmentTermService } from '../enrollments/enrollment-term.service';
import { owedFor, termsOrFallback } from '../enrollments/enrollment-term.util';
import { PrismaService } from '../prisma/prisma.service';
import { arrears, monthsDue } from './revenue.util';

// A fund program has a few hundred subscribers at most; the cap only stops a
// runaway scan. Reaching it means the "behind" list and the expected total
// are incomplete, which is logged as an error rather than shown as if whole.
const ARREARS_SCAN_CAP = 5_000;

export interface ProgramArrears {
  monthsDue: number;
  // enrollment id → its arrears, for the enrollments that are behind only.
  behind: Map<string, Prisma.Decimal>;
  // What the year's pledges expect in all — each subscription's months as a
  // member, at its pledge. The collection ratio's denominator.
  expectedTotal: Prisma.Decimal;
}

/**
 * Who is behind (عجز) in one periodic program for one year, and by how much,
 * and what the year expected in all — shared by the grid's "behind" filter
 * and the summary's figures, so the list and the numbers above it can never
 * disagree.
 *
 * Read from each subscription's terms: a month counts only while the
 * subscriber was ACTIVE in it, at that month's pledge. So a member frozen
 * from January owes nothing this year and is never listed, one frozen from
 * May still owes January to April, and a mid-year joiner owes from the month
 * they joined (the fund's rules, 2026-10-02).
 *
 * Computed in TypeScript, not SQL, so owedFor() and arrears() are the one
 * copy of each rule; the price is three bounded reads per request, side by
 * side.
 */
@Injectable()
export class EradatArrearsService {
  private readonly logger = new Logger(EradatArrearsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly termService: EnrollmentTermService,
  ) {}

  async loadArrears(
    programId: string,
    year: number,
    now = new Date(),
  ): Promise<ProgramArrears> {
    const due = monthsDue(year, now);
    const [enrollments, termsByEnrollment, paid] = await Promise.all([
      this.prisma.programEnrollment.findMany({
        where: { programId },
        select: {
          id: true,
          contributorId: true,
          status: true,
          expectedRate: true,
        },
        orderBy: { id: 'asc' },
        take: ARREARS_SCAN_CAP + 1,
      }),
      this.termService.loadTerms({ programId }, year),
      // A star's amount is NULL, so the sum skips it — the same rule
      // yearlyTotal() applies to fetched cells.
      this.prisma.payment.groupBy({
        by: ['contributorId'],
        where: { programId, year, contributorId: { not: null } },
        _sum: { amount: true },
        orderBy: { contributorId: 'asc' },
        take: ARREARS_SCAN_CAP + 1,
      }),
    ]);
    if (enrollments.length > ARREARS_SCAN_CAP) {
      this.logger.error(
        `Arrears scan for program ${programId} hit its cap of ${ARREARS_SCAN_CAP} enrollments; the behind list is incomplete`,
      );
    }

    const paidBy = new Map(
      paid.map((row) => [row.contributorId, row._sum.amount ?? ZERO]),
    );
    const behind = new Map<string, Prisma.Decimal>();
    const expected: Prisma.Decimal[] = [];
    for (const enrollment of enrollments.slice(0, ARREARS_SCAN_CAP)) {
      const terms = termsOrFallback(
        enrollment,
        termsByEnrollment.get(enrollment.id),
      );
      expected.push(owedFor(terms, year, 12));
      const short = arrears(
        owedFor(terms, year, due),
        paidBy.get(enrollment.contributorId) ?? ZERO,
      );
      if (!short.isZero()) behind.set(enrollment.id, short);
    }
    return { monthsDue: due, behind, expectedTotal: sumMoney(expected) };
  }
}
