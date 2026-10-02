import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AppException } from '../common/exceptions/app.exception';
import { pendingFeature } from '../common/utils/pending-feature.util';
import {
  isForeignKeyViolation,
  isUniqueViolation,
} from '../common/utils/prisma-error.util';
import { CONTRIBUTOR_SELECT } from '../contributors/contributor.constant';
import { ContributorService } from '../contributors/contributor.service';
import type { ProgramRow } from '../programs/program.constant';
import { ProgramService } from '../programs/program.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import type { ListEnrollmentsQueryDto } from './dto/list-enrollments-query.dto';
import type { UpdateEnrollmentDto } from './dto/update-enrollment.dto';
import {
  ENROLLMENT_FIELDS_SELECT,
  ENROLLMENT_ORDER_BY,
  ENROLLMENT_SELECT,
  type EnrollmentFieldsRow,
  type EnrollmentRow,
} from './enrollment.constant';
import { toEnrollmentView } from './enrollment.util';

const DIGITS_ONLY = /^\d+$/;

/**
 * Who participates in a program, and what each contributor pledged to it. The
 * same contributor can pledge different amounts to different programs, which is
 * why the rate lives here and not on Contributor.
 *
 * Only a PERIODIC program is enrolled in. A TEMPORARY one takes gifts from
 * anyone with no enrolling and keeps no pledge or previous subscription; its
 * rows are donor rows, added by a contributor's first gift and removed with
 * their last (addDonor, removeDonorIfEmpty), because Payment's composite FK
 * still needs one under every contributor payment.
 *
 * Exported for PaymentModule (who may pay, and the donor rows) and
 * EradatModule (the grid pages through enrollments).
 */
@Injectable()
export class EnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly programService: ProgramService,
    private readonly contributorService: ContributorService,
  ) {}

  /**
   * One cursor page of a program's enrollments, without their contributors —
   * attachContributors adds those, so the grid can load them beside its
   * payment cells. Does not check the program: callers resolve it, usually
   * in parallel with this.
   */
  // onlyIds narrows the page to enrollments a caller already picked — the
  // grid's "behind" filter, whose rule needs payments Prisma cannot compare
  // against a pledge in one query. The order and cursor stay the same, so
  // paging a filtered grid works like paging the whole one.
  async listEnrollmentPage(
    programId: string,
    { cursor, limit, status, q }: ListEnrollmentsQueryDto,
    onlyIds?: readonly string[],
  ): Promise<{ rows: EnrollmentFieldsRow[]; nextCursor: string | null }> {
    // One extra row says whether another page exists without a count().
    const found = await this.prisma.programEnrollment.findMany({
      where: {
        programId,
        ...(onlyIds ? { id: { in: [...onlyIds] } } : {}),
        ...(status ? { status } : {}),
        ...(q ? { contributor: this.buildContributorSearch(q) } : {}),
      },
      orderBy: ENROLLMENT_ORDER_BY,
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: ENROLLMENT_FIELDS_SELECT,
    });
    const hasMore = found.length > limit;
    const rows = hasMore ? found.slice(0, limit) : found;
    return { rows, nextCursor: hasMore ? rows[rows.length - 1].id : null };
  }

  /**
   * The rows of one page with their contributors, as the nested
   * ENROLLMENT_SELECT would return them.
   *
   * The unfiltered client, like the nested select it replaces: an
   * enrollment's contributor is live by construction — deleting a contributor
   * is refused while they have any, and a merge moves them first — so this
   * reads by foreign key, never a list that could surface deleted rows.
   */
  async attachContributors(
    rows: EnrollmentFieldsRow[],
  ): Promise<EnrollmentRow[]> {
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.map((row) => row.contributorId))];
    const contributors = await this.prisma.raw.contributor.findMany({
      where: { id: { in: ids } },
      select: CONTRIBUTOR_SELECT,
      take: ids.length,
    });
    const byId = new Map(contributors.map((c) => [c.id, c]));
    return rows.map((row) => {
      const contributor = byId.get(row.contributorId);
      // The FK (Restrict) makes this unreachable; failing loudly beats
      // rendering a line with no name.
      if (!contributor) {
        throw new Error(
          `Enrollment ${row.id} points at missing contributor ${row.contributorId}`,
        );
      }
      return { ...row, contributor };
    });
  }

  async listEnrollments(programId: string, query: ListEnrollmentsQueryDto) {
    const [, page] = await Promise.all([
      this.programService.assertProgramExists(programId),
      this.listEnrollmentPage(programId, query),
    ]);
    const rows = await this.attachContributors(page.rows);
    return { items: rows.map(toEnrollmentView), nextCursor: page.nextCursor };
  }

  /**
   * What the payment path needs to know about a contributor before it knows
   * the program's type, which it reads beside this: whether they are
   * enrolled — all a periodic program accepts — and whether their record is
   * live — all a temporary one needs. Both reads run at once, so either
   * answer costs one round trip.
   */
  async lookUpContributorPayer(
    programId: string,
    contributorId: string,
  ): Promise<{ enrolled: boolean; live: boolean }> {
    const [enrollment, contributor] = await Promise.all([
      this.prisma.programEnrollment.findUnique({
        where: { contributorId_programId: { contributorId, programId } },
        select: { id: true },
      }),
      // findFirst: a deleted or merged-away record cannot start giving.
      this.prisma.contributor.findFirst({
        where: { id: contributorId },
        select: { id: true },
      }),
    ]);
    return { enrolled: enrollment !== null, live: contributor !== null };
  }

  /**
   * A contributor's first gift to a temporary program: the pledge-free donor
   * row Payment's composite FK needs. Runs on the transaction that books the
   * gift, so a refused gift leaves no donor behind. skipDuplicates (ON
   * CONFLICT DO NOTHING): two first gifts racing both land on one row.
   */
  async addDonor(
    db: Pick<PrismaService, 'programEnrollment'>,
    programId: string,
    contributorId: string,
  ): Promise<void> {
    await db.programEnrollment.createMany({
      data: [{ programId, contributorId, expectedRate: '0' }],
      skipDuplicates: true,
    });
  }

  /**
   * After a gift to a temporary program is removed: drops the giver's donor
   * row once nothing of theirs is left there, so they leave the program's
   * donor list and their contributor record can be removed again.
   */
  async removeDonorIfEmpty(
    programId: string,
    contributorId: string,
  ): Promise<void> {
    try {
      await this.prisma.programEnrollment.deleteMany({
        where: { programId, contributorId, payments: { none: {} } },
      });
    } catch (err) {
      // A gift booked between the filter and the delete: the composite FK
      // refused, and the row is still needed.
      if (!isForeignKeyViolation(err)) throw err;
    }
  }

  async createEnrollment(programId: string, dto: CreateEnrollmentDto) {
    const program = await this.assertTakesEnrollments(programId);
    // The FK would accept a soft-deleted or merged-away contributor; this would
    // not.
    if (dto.contributorId)
      await this.contributorService.assertContributorExists(dto.contributorId);

    // One transaction: a new contributor and their enrollment land together, so
    // a clash on the enrollment never leaves a half-made contributor behind.
    const { enrollment, newContributor } = await this.prisma.$transaction(
      async (tx) => {
        const newContributor = dto.contributor
          ? await this.contributorService.insertContributor(tx, dto.contributor)
          : null;
        const contributorId = newContributor?.id ?? dto.contributorId;
        // Unreachable past the DTO's refine (exactly one of contributor /
        // contributorId); kept so the type narrows without a cast.
        if (!contributorId) throw new AppException('VALIDATION_FAILED');
        try {
          const enrollment = await tx.programEnrollment.create({
            data: {
              programId,
              contributorId,
              expectedRate: dto.expectedRate,
              previousSubscription: dto.previousSubscription ?? '0',
            },
            select: ENROLLMENT_SELECT,
          });
          return { enrollment, newContributor };
        } catch (err) {
          // The unique (contributorId, programId) index is the dedupe.
          if (!isUniqueViolation(err)) throw err;
          throw new AppException(
            'ENROLLMENT_EXISTS',
            { programName: program.name },
            HttpStatus.CONFLICT,
          );
        }
      },
    );

    const possibleDuplicates = newContributor
      ? await this.contributorService.flagPossibleDuplicates(newContributor)
      : 0;
    return {
      ...toEnrollmentView(enrollment),
      contributorName: enrollment.contributor.name,
      programName: program.name,
      possibleDuplicates,
      successCode: 'ENROLLMENT_CREATE_SUCCESS',
    };
  }

  async updateEnrollment(
    programId: string,
    enrollmentId: string,
    dto: UpdateEnrollmentDto,
  ) {
    // Side by side, settled so the program's answer always comes first.
    const [program, found] = await Promise.allSettled([
      this.assertTakesEnrollments(programId),
      this.findEnrollmentOrThrow(programId, enrollmentId),
    ]);
    if (program.status === 'rejected') throw program.reason;
    if (found.status === 'rejected') throw found.reason;
    const enrollment = await this.prisma.programEnrollment.update({
      where: { id: enrollmentId },
      data: dto,
      select: ENROLLMENT_SELECT,
    });
    return {
      ...toEnrollmentView(enrollment),
      contributorName: enrollment.contributor.name,
      successCode: 'ENROLLMENT_UPDATE_SUCCESS',
    };
  }

  async markEnrollmentDormant(programId: string, enrollmentId: string) {
    // The conditional update is the transition: two clicks race and exactly
    // one flips the status. A donor row in a temporary program never goes
    // dormant — there is no subscription to pause — so the filter skips it
    // and the miss is explained below.
    const { count } = await this.prisma.programEnrollment.updateMany({
      where: {
        id: enrollmentId,
        programId,
        status: 'ACTIVE',
        program: { type: 'PERIODIC' },
      },
      data: { status: 'DORMANT' },
    });
    if (count === 0) {
      await this.findEnrollmentOrThrow(programId, enrollmentId);
      await this.assertTakesEnrollments(programId);
      throw new AppException(
        'ENROLLMENT_ALREADY_DORMANT',
        { enrollmentId },
        HttpStatus.CONFLICT,
      );
    }
    const enrollment = await this.findEnrollmentOrThrow(
      programId,
      enrollmentId,
    );
    return {
      ...toEnrollmentView(enrollment),
      contributorName: enrollment.contributor.name,
      successCode: 'ENROLLMENT_MARK_DORMANT_SUCCESS',
    };
  }

  /**
   * Undoes a mistaken enrollment. Refused once the contributor has paid
   * anything to the program: from then on the enrollment anchors part of the
   * books and can only go dormant.
   */
  async removeEnrollment(programId: string, enrollmentId: string) {
    const enrollment = await this.findEnrollmentOrThrow(
      programId,
      enrollmentId,
    );
    const payments = await this.prisma.payment.count({
      where: { programId, contributorId: enrollment.contributorId },
    });
    if (payments > 0) throw this.hasPayments(payments);

    // Hard delete: with no payments the enrollment carries no history, and a
    // tombstone would hold the (contributor, program) unique key and block
    // enrolling the contributor again.
    try {
      await this.prisma.programEnrollment.delete({
        where: { id: enrollmentId },
      });
    } catch (err) {
      // A payment written between the count and the delete; the composite
      // FK refused the delete, which is the answer the count would have given.
      if (!isForeignKeyViolation(err)) throw err;
      throw this.hasPayments(1);
    }
    return {
      id: enrollmentId,
      contributorName: enrollment.contributor.name,
      successCode: 'ENROLLMENT_REMOVE_SUCCESS',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Pending confirmation from the fund. Each flow has its method so wiring it
  // up replaces one `throw`; none is routed yet, and the UI shows each as a
  // disabled control.
  // ═══════════════════════════════════════════════════════════════════════

  // TODO(dormant-reactivation): the fund has not confirmed where a dormant
  // enrollment's prior balance goes or how rejoining restores
  // previousSubscription. This is meant to be the only DORMANT → ACTIVE path —
  // UpdateEnrollmentDto deliberately carries no `status`.
  reactivateEnrollment(_programId: string, _enrollmentId: string): never {
    throw pendingFeature('enrollment.reactivate');
  }

  // TODO(mid-cycle-rate-change): unconfirmed whether a pledge can change
  // mid-cycle and from when it would apply. Expected shape: an
  // EnrollmentRate history (enrollmentId, effectiveYear, rate) that the
  // collection ratio reads per year, with expectedRate kept as the latest.
  scheduleRateChange(
    _programId: string,
    _enrollmentId: string,
    _effectiveYear: number,
    _expectedRate: string,
  ): never {
    throw pendingFeature('enrollment.rate-change');
  }

  // TODO(collector-assignment): the rules mapping collectors to enrollments
  // are unknown. Expected shape: a Collector model (likely a User with a
  // collector role — a Role row, see AuthGuard) and a nullable collectorId
  // on ProgramEnrollment.
  assignCollector(
    _programId: string,
    _enrollmentId: string,
    _collectorId: string | null,
  ): never {
    throw pendingFeature('enrollment.assign-collector');
  }

  // A temporary program's rows belong to the payment path, which adds and
  // removes them with the gifts; enrolling, a pledge or dormancy there would
  // turn a donor into a subscriber the program does not have.
  private async assertTakesEnrollments(programId: string): Promise<ProgramRow> {
    const program = await this.programService.assertProgramExists(programId);
    if (program.type === 'TEMPORARY') {
      throw new AppException(
        'ENROLLMENT_PROGRAM_TEMPORARY',
        { programName: program.name },
        HttpStatus.CONFLICT,
      );
    }
    return program;
  }

  // findFirst on (id, programId) so an enrollment id from another program
  // 404s here instead of being edited through the wrong URL.
  private async findEnrollmentOrThrow(
    programId: string,
    enrollmentId: string,
  ): Promise<EnrollmentRow> {
    const enrollment = await this.prisma.programEnrollment.findFirst({
      where: { id: enrollmentId, programId },
      select: ENROLLMENT_SELECT,
    });
    if (!enrollment) {
      throw new AppException(
        'ENROLLMENT_NOT_FOUND',
        { programId, enrollmentId },
        HttpStatus.NOT_FOUND,
      );
    }
    return enrollment;
  }

  private buildContributorSearch(q: string): Prisma.ContributorWhereInput {
    return {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        ...(DIGITS_ONLY.test(q) ? [{ accountNumber: { startsWith: q } }] : []),
      ],
    };
  }

  private hasPayments(count: number): AppException {
    return new AppException(
      'ENROLLMENT_HAS_PAYMENTS',
      { count },
      HttpStatus.CONFLICT,
    );
  }
}
