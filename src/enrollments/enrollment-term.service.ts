import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma, type EnrollmentStatus } from '../../generated/prisma/client';
import { AppException } from '../common/exceptions/app.exception';
import { toMoneyString, ZERO } from '../common/utils/money.util';
import { ProgramService } from '../programs/program.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RateChangeDto } from './dto/rate-change.dto';
import type { TermChangeDto } from './dto/term-change.dto';
import {
  ENROLLMENT_SELECT,
  TERM_HISTORY_CAP,
  TERM_ORDER_BY,
  TERM_SCAN_CAP,
  TERM_SELECT,
  type EnrollmentRow,
  type TermFieldsRow,
} from './enrollment.constant';
import {
  currentMonth,
  fallbackTerm,
  formatMonth,
  monthIndex,
  owedFor,
  placeChange,
  sameTerms,
  termsOrFallback,
  termStart,
  type MonthRef,
  type TermRow,
} from './enrollment-term.util';
import {
  assertTakesEnrollments,
  toEnrollmentView,
  toTermView,
} from './enrollment.util';

// The slice of a client (or interactive transaction) a term write touches.
type TermDb = Pick<PrismaService, 'enrollmentTerm' | 'programEnrollment'>;

// An enrollment with its history, as every change reads it first.
interface Subscription {
  enrollment: EnrollmentRow;
  updatedAt: Date;
  // Date order. Empty only for an enrollment written by something that
  // skipped its terms — see fallbackTerm.
  terms: TermFieldsRow[];
}

/**
 * A periodic subscription's dated history — joining, dormancy, reactivation
 * and pledge changes, each from a month (see EnrollmentTerm in
 * prisma/schema.prisma and the rules in enrollment-term.util.ts).
 *
 * Every change appends a term in date order and never past the current
 * month, and in the same transaction rewrites the enrollment's mirror of the
 * latest term (status, expectedRate). The mirror's updatedAt is the claim: a
 * change that read the history goes through only if nobody changed the
 * enrollment since, so two managers clicking at once cannot interleave two
 * histories.
 *
 * Exported for EnrollmentService (the joining term, a pledge correction) and
 * EradatModule (arrears and expected totals read the terms).
 */
@Injectable()
export class EnrollmentTermService {
  private readonly logger = new Logger(EnrollmentTermService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly programService: ProgramService,
  ) {}

  /**
   * Terms per enrollment, in date order, up to December of `throughYear` —
   * everything it takes to know each month of that year. Later terms change
   * nothing about it. An enrollment with no terms is absent from the map;
   * termsOrFallback reads it.
   */
  async loadTerms(
    scope: { programId: string } | { enrollmentIds: readonly string[] },
    throughYear: number,
  ): Promise<Map<string, TermRow[]>> {
    const byEnrollment = new Map<string, TermRow[]>();
    if ('enrollmentIds' in scope && scope.enrollmentIds.length === 0) {
      return byEnrollment;
    }
    const rows = await this.prisma.enrollmentTerm.findMany({
      where: {
        fromYear: { lte: throughYear },
        ...('programId' in scope
          ? { enrollment: { programId: scope.programId } }
          : { enrollmentId: { in: [...scope.enrollmentIds] } }),
      },
      orderBy: [{ enrollmentId: 'asc' }, ...TERM_ORDER_BY],
      take: TERM_SCAN_CAP + 1,
      select: TERM_SELECT,
    });
    if (rows.length > TERM_SCAN_CAP) {
      this.logger.error(
        `Term scan hit its cap of ${TERM_SCAN_CAP} rows; arrears and expected totals are incomplete`,
      );
    }
    for (const { enrollmentId, ...term } of rows.slice(0, TERM_SCAN_CAP)) {
      const list = byEnrollment.get(enrollmentId);
      if (list) list.push(term);
      else byEnrollment.set(enrollmentId, [term]);
    }
    return byEnrollment;
  }

  async listTerms(programId: string, enrollmentId: string) {
    const { terms } = await this.loadSubscription(programId, enrollmentId);
    return { items: terms.map(toTermView) };
  }

  /**
   * Freezes a subscription from a month on: the months from then drop out of
   * العجز and the year's expected total; the months before stay owed.
   */
  async markDormant(
    userId: string,
    programId: string,
    enrollmentId: string,
    dto: TermChangeDto,
  ) {
    return this.changeStatus(
      userId,
      programId,
      enrollmentId,
      'DORMANT',
      dto.from,
    );
  }

  /**
   * Brings a dormant subscriber back. From January (the default), the whole
   * year counts again, as it does for a returnee who settles the year; from
   * the month they returned, the dormant months before it stay out. The
   * fund decides per case (2026-10-02).
   */
  async reactivate(
    userId: string,
    programId: string,
    enrollmentId: string,
    dto: TermChangeDto,
  ) {
    return this.changeStatus(
      userId,
      programId,
      enrollmentId,
      'ACTIVE',
      dto.from,
    );
  }

  /**
   * A new yearly pledge from a month on; the months before keep the old one.
   * The fund's rule (2026-10-02): a pledge can change mid-year only once the
   * year so far is paid at the old pledge — going from 6,000 to 12,000 in
   * June means paying January to May first. From January there is nothing
   * before it to settle.
   */
  async changeRate(
    userId: string,
    programId: string,
    enrollmentId: string,
    dto: RateChangeDto,
  ) {
    const from = dto.from;
    // The year's payments are read beside the history: the settling rule
    // needs both, and neither waits on the other. Through the enrollment
    // relation, so the read needs no contributor id from the first.
    const [subscription, paid] = await Promise.all([
      this.loadSubscription(programId, enrollmentId),
      this.prisma.payment.aggregate({
        where: { programId, year: from.year, enrollment: { id: enrollmentId } },
        _sum: { amount: true },
      }),
    ]);
    const terms = termsOrFallback(subscription.enrollment, subscription.terms);
    const latest = terms[terms.length - 1];
    const rate = new Prisma.Decimal(dto.expectedRate);
    const placement = this.place(subscription, from);
    if (placement === 'APPEND' && rate.equals(latest.expectedRate)) {
      throw new AppException('ENROLLMENT_RATE_UNCHANGED', {
        expectedRate: toMoneyString(rate),
      });
    }

    const owed = owedFor(terms, from.year, from.month - 1);
    const short = owed.minus(paid._sum.amount ?? ZERO);
    if (short.greaterThan(0)) {
      throw new AppException(
        'ENROLLMENT_RATE_CHANGE_UNSETTLED',
        { owed: toMoneyString(short), year: from.year },
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.writeChange(userId, subscription, placement, {
      fromYear: from.year,
      fromMonth: from.month,
      status: latest.status,
      expectedRate: rate,
    });
    return {
      ...toEnrollmentView(updated),
      contributorName: updated.contributor.name,
      from: formatMonth(from),
      successCode: 'ENROLLMENT_RATE_CHANGE_SUCCESS',
    };
  }

  /**
   * The joining term of a new enrollment, on the transaction that creates it
   * — so an enrollment never exists without its start. The caller has
   * checked `from` with assertJoinable.
   */
  async addJoiningTerm(
    db: Pick<PrismaService, 'enrollmentTerm'>,
    userId: string,
    enrollmentId: string,
    from: MonthRef,
    expectedRate: string,
  ): Promise<void> {
    await db.enrollmentTerm.create({
      data: {
        enrollmentId,
        fromYear: from.year,
        fromMonth: from.month,
        status: 'ACTIVE',
        expectedRate,
        recordedById: userId,
      },
    });
  }

  /** A joining month may be any month up to this one. */
  assertJoinable(from: MonthRef): void {
    if (placeChange(null, from) === 'FUTURE') throw this.inFuture();
  }

  /**
   * A pledge that was wrong from the start: the latest term takes the
   * corrected amount for as long as it has run — the fix for an imported
   * rate of 0, say — instead of a new term from a month. On the transaction
   * that rewrites the enrollment's mirror.
   */
  async correctLatestRate(
    db: TermDb,
    userId: string,
    enrollment: EnrollmentRow,
    expectedRate: string,
  ): Promise<void> {
    const latest = await db.enrollmentTerm.findFirst({
      where: { enrollmentId: enrollment.id },
      orderBy: [{ fromYear: 'desc' }, { fromMonth: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (latest) {
      await db.enrollmentTerm.update({
        where: { id: latest.id },
        data: { expectedRate, recordedById: userId },
      });
      return;
    }
    await db.enrollmentTerm.create({
      data: {
        ...this.termData(fallbackTerm(enrollment)),
        enrollmentId: enrollment.id,
        expectedRate,
        recordedById: userId,
      },
    });
  }

  private async changeStatus(
    userId: string,
    programId: string,
    enrollmentId: string,
    status: EnrollmentStatus,
    requested: MonthRef | undefined,
  ) {
    const subscription = await this.loadSubscription(programId, enrollmentId);
    const { enrollment } = subscription;
    if (enrollment.status === status) {
      throw new AppException(
        status === 'DORMANT'
          ? 'ENROLLMENT_ALREADY_DORMANT'
          : 'ENROLLMENT_ALREADY_ACTIVE',
        { enrollmentId },
        HttpStatus.CONFLICT,
      );
    }
    const terms = termsOrFallback(enrollment, subscription.terms);
    const latest = terms[terms.length - 1];
    const from = requested ?? this.defaultFrom(latest);
    const placement = this.place(subscription, from);

    const updated = await this.writeChange(userId, subscription, placement, {
      fromYear: from.year,
      fromMonth: from.month,
      status,
      expectedRate: latest.expectedRate,
    });
    return {
      ...toEnrollmentView(updated),
      contributorName: updated.contributor.name,
      from: formatMonth(from),
      successCode:
        status === 'DORMANT'
          ? 'ENROLLMENT_MARK_DORMANT_SUCCESS'
          : 'ENROLLMENT_REACTIVATE_SUCCESS',
    };
  }

  // January of this year — the fund's usual start for a dormancy and for a
  // returnee's dues — unless the latest change starts later in the year, in
  // which case the new one takes its place.
  private defaultFrom(latest: TermRow): MonthRef {
    const january = { year: currentMonth().year, month: 1 };
    return monthIndex(termStart(latest)) > monthIndex(january)
      ? termStart(latest)
      : january;
  }

  // Where `from` goes, or why it cannot. An enrollment without terms is
  // placed against the term it is read as, which writeChange then stores.
  private place(subscription: Subscription, from: MonthRef) {
    const terms = termsOrFallback(subscription.enrollment, subscription.terms);
    const latest = terms[terms.length - 1];
    const placement = placeChange(latest, from);
    if (placement === 'FUTURE') throw this.inFuture();
    if (placement === 'BEFORE') {
      throw new AppException(
        'ENROLLMENT_TERM_BEFORE_LAST',
        { from: formatMonth(termStart(latest)) },
        HttpStatus.CONFLICT,
      );
    }
    return placement;
  }

  /**
   * Stores one change and the enrollment's new mirror together. A change in
   * the latest term's month replaces it — and when that leaves it saying
   * what the term before it says (a dormancy from March undone in March),
   * the latest term is dropped instead, so the history shows no change that
   * never took effect.
   */
  private async writeChange(
    userId: string,
    subscription: Subscription,
    placement: 'APPEND' | 'REPLACE',
    next: TermRow,
  ): Promise<EnrollmentRow> {
    const { enrollment, terms, updatedAt } = subscription;
    const latest = terms[terms.length - 1] as TermFieldsRow | undefined;
    const previous = terms[terms.length - 2] as TermFieldsRow | undefined;

    await this.prisma.$transaction(async (tx) => {
      // The claim: matches only if nobody changed this enrollment since it
      // was read. It also rewrites the mirror, which the latest term decides.
      const { count } = await tx.programEnrollment.updateMany({
        where: { id: enrollment.id, updatedAt },
        data: { status: next.status, expectedRate: next.expectedRate },
      });
      if (count === 0) {
        throw new AppException(
          'ENROLLMENT_CHANGED_CONCURRENTLY',
          { enrollmentId: enrollment.id },
          HttpStatus.CONFLICT,
        );
      }

      if (!latest) {
        // Store the term this enrollment was read as, then the change after
        // it — unless the change starts in that same first month.
        const base = fallbackTerm(enrollment);
        await tx.enrollmentTerm.createMany({
          data: (placement === 'REPLACE' ? [next] : [base, next]).map(
            (term) => ({
              ...this.termData(term),
              enrollmentId: enrollment.id,
              recordedById: term === next ? userId : null,
            }),
          ),
        });
        return;
      }
      if (placement === 'REPLACE') {
        if (previous && sameTerms(previous, next)) {
          await tx.enrollmentTerm.delete({ where: { id: latest.id } });
        } else {
          await tx.enrollmentTerm.update({
            where: { id: latest.id },
            data: { ...this.termData(next), recordedById: userId },
          });
        }
        return;
      }
      await tx.enrollmentTerm.create({
        data: {
          ...this.termData(next),
          enrollmentId: enrollment.id,
          recordedById: userId,
        },
      });
    });
    return {
      ...enrollment,
      status: next.status,
      expectedRate: next.expectedRate,
    };
  }

  // The program, the enrollment and its history side by side, settled so
  // the program's answer always comes first: an unknown program reads as
  // PROGRAM_NOT_FOUND, a temporary one as ENROLLMENT_PROGRAM_TEMPORARY. The
  // history of an enrollment in another program is read and discarded.
  private async loadSubscription(
    programId: string,
    enrollmentId: string,
  ): Promise<Subscription> {
    const [program, found, terms] = await Promise.allSettled([
      this.programService.assertProgramExists(programId),
      this.prisma.programEnrollment.findFirst({
        where: { id: enrollmentId, programId },
        select: { ...ENROLLMENT_SELECT, updatedAt: true },
      }),
      this.prisma.enrollmentTerm.findMany({
        where: { enrollmentId },
        orderBy: TERM_ORDER_BY,
        take: TERM_HISTORY_CAP,
        select: TERM_SELECT,
      }),
    ]);
    if (program.status === 'rejected') throw program.reason;
    assertTakesEnrollments(program.value);
    if (found.status === 'rejected') throw found.reason;
    if (!found.value) {
      throw new AppException(
        'ENROLLMENT_NOT_FOUND',
        { programId, enrollmentId },
        HttpStatus.NOT_FOUND,
      );
    }
    if (terms.status === 'rejected') throw terms.reason;
    const { updatedAt, ...enrollment } = found.value;
    return { enrollment, updatedAt, terms: terms.value };
  }

  private termData(term: TermRow) {
    return {
      fromYear: term.fromYear,
      fromMonth: term.fromMonth,
      status: term.status,
      expectedRate: term.expectedRate,
    };
  }

  private inFuture(): AppException {
    return new AppException('ENROLLMENT_TERM_IN_FUTURE', {
      month: formatMonth(currentMonth()),
    });
  }
}
