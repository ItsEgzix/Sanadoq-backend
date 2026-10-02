import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { ZERO } from '../common/utils/money.util';
import { PrismaService } from '../prisma/prisma.service';
import { arrears, monthsDue } from './revenue.util';

// A fund program has a few hundred subscribers at most; the cap only stops a
// runaway scan. Reaching it means the "behind" list is incomplete, which is
// logged as an error rather than shown as if it were whole.
const ARREARS_SCAN_CAP = 5_000;

export interface ProgramArrears {
  monthsDue: number;
  // enrollment id → its arrears, for the enrollments that are behind only.
  behind: Map<string, Prisma.Decimal>;
}

/**
 * Who is behind (عجز) in one periodic program for one year, and by how much —
 * shared by the grid's "behind" filter and the summary's count and total, so
 * the list and the figures above it can never disagree.
 *
 * Active subscribers only. A dormant enrollment is on the fund's frozen list
 * (الحسابات الخاملة): nobody chases it for payment while it stays frozen, so
 * it is never listed as behind. Its pledge still counts toward the program's
 * expected total — that is a separate open question.
 *
 * Computed in TypeScript, not SQL, so arrears() in revenue.util.ts is the
 * one copy of the rule; the price is two bounded reads per request.
 */
@Injectable()
export class EradatArrearsService {
  private readonly logger = new Logger(EradatArrearsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async loadArrears(
    programId: string,
    year: number,
    now = new Date(),
  ): Promise<ProgramArrears> {
    const due = monthsDue(year, now);
    // Nothing of the year has ended yet: nobody can be behind, so skip both
    // reads.
    if (due === 0) return { monthsDue: due, behind: new Map() };

    const [enrollments, paid] = await Promise.all([
      this.prisma.programEnrollment.findMany({
        // A zero pledge can never be behind.
        where: { programId, status: 'ACTIVE', expectedRate: { gt: 0 } },
        select: { id: true, contributorId: true, expectedRate: true },
        orderBy: { id: 'asc' },
        take: ARREARS_SCAN_CAP + 1,
      }),
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
    for (const enrollment of enrollments.slice(0, ARREARS_SCAN_CAP)) {
      const short = arrears(
        enrollment.expectedRate,
        due,
        paidBy.get(enrollment.contributorId) ?? ZERO,
      );
      if (!short.isZero()) behind.set(enrollment.id, short);
    }
    return { monthsDue: due, behind };
  }
}
