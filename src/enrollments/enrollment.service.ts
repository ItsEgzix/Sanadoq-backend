import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from 'generated/prisma/client';
import { AppException } from 'src/common/exceptions/app.exception';
import { pendingFeature } from 'src/common/utils/pending-feature.util';
import {
  isForeignKeyViolation,
  isUniqueViolation,
} from 'src/common/utils/prisma-error.util';
import { PersonService } from 'src/people/person.service';
import { ProgramService } from 'src/programs/program.service';
import { PrismaService } from 'src/prisma/prisma.service';
import type { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import type { ListEnrollmentsQueryDto } from './dto/list-enrollments-query.dto';
import type { UpdateEnrollmentDto } from './dto/update-enrollment.dto';
import {
  ENROLLMENT_ORDER_BY,
  ENROLLMENT_SELECT,
  type EnrollmentRow,
} from './enrollment.constant';
import { toEnrollmentView } from './enrollment.util';

const DIGITS_ONLY = /^\d+$/;

/**
 * Who participates in a program, and what each person pledged to it. The
 * same person can pledge different amounts to different programs, which is
 * why the rate lives here and not on Person.
 *
 * Exported for PaymentModule (a person can only pay a program they are
 * enrolled in — also a database fact, via Payment's composite FK) and
 * EradatModule (the grid pages through enrollments).
 */
@Injectable()
export class EnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly programService: ProgramService,
    private readonly personService: PersonService,
  ) {}

  /**
   * One cursor page of a program's enrollments; the grid adds payment cells
   * to these. The caller has already resolved the program.
   *
   * Enrollments never point at a deleted person by construction — deleting a
   * person is refused while they have any, and a merge moves them first — so
   * no person filter is needed here.
   */
  async listEnrollmentRows(
    programId: string,
    { cursor, limit, status, q }: ListEnrollmentsQueryDto,
  ): Promise<{ rows: EnrollmentRow[]; nextCursor: string | null }> {
    // One extra row says whether another page exists without a count().
    const found = await this.prisma.programEnrollment.findMany({
      where: {
        programId,
        ...(status ? { status } : {}),
        ...(q ? { person: this.buildPersonSearch(q) } : {}),
      },
      orderBy: ENROLLMENT_ORDER_BY,
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: ENROLLMENT_SELECT,
    });
    const hasMore = found.length > limit;
    const rows = hasMore ? found.slice(0, limit) : found;
    return { rows, nextCursor: hasMore ? rows[rows.length - 1].id : null };
  }

  async listEnrollments(programId: string, query: ListEnrollmentsQueryDto) {
    await this.programService.assertProgramExists(programId);
    const { rows, nextCursor } = await this.listEnrollmentRows(
      programId,
      query,
    );
    return { items: rows.map(toEnrollmentView), nextCursor };
  }

  /** The person's enrollment in the program, or ENROLLMENT_NOT_FOUND. */
  async assertEnrolled(
    programId: string,
    personId: string,
  ): Promise<EnrollmentRow> {
    const enrollment = await this.prisma.programEnrollment.findUnique({
      where: { personId_programId: { personId, programId } },
      select: ENROLLMENT_SELECT,
    });
    if (!enrollment) {
      throw new AppException(
        'ENROLLMENT_NOT_FOUND',
        { programId, personId },
        HttpStatus.NOT_FOUND,
      );
    }
    return enrollment;
  }

  async createEnrollment(programId: string, dto: CreateEnrollmentDto) {
    const program = await this.programService.assertProgramExists(programId);
    // The FK would accept a soft-deleted or merged-away person; this would not.
    if (dto.personId) await this.personService.assertPersonExists(dto.personId);

    // One transaction: a new person and their enrollment land together, so a
    // clash on the enrollment never leaves a half-made person behind.
    const { enrollment, newPerson } = await this.prisma.$transaction(
      async (tx) => {
        const newPerson = dto.person
          ? await this.personService.insertPerson(tx, dto.person)
          : null;
        const personId = newPerson?.id ?? dto.personId;
        // Unreachable past the DTO's refine (exactly one of person /
        // personId); kept so the type narrows without a cast.
        if (!personId) throw new AppException('VALIDATION_FAILED');
        try {
          const enrollment = await tx.programEnrollment.create({
            data: {
              programId,
              personId,
              expectedRate: dto.expectedRate,
              previousSubscription: dto.previousSubscription ?? '0',
            },
            select: ENROLLMENT_SELECT,
          });
          return { enrollment, newPerson };
        } catch (err) {
          // The unique (personId, programId) index is the dedupe.
          if (!isUniqueViolation(err)) throw err;
          throw new AppException(
            'ENROLLMENT_EXISTS',
            { programName: program.name },
            HttpStatus.CONFLICT,
          );
        }
      },
    );

    const possibleDuplicates = newPerson
      ? await this.personService.flagPossibleDuplicates(newPerson)
      : 0;
    return {
      ...toEnrollmentView(enrollment),
      personName: enrollment.person.name,
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
    await this.findEnrollmentOrThrow(programId, enrollmentId);
    const enrollment = await this.prisma.programEnrollment.update({
      where: { id: enrollmentId },
      data: dto,
      select: ENROLLMENT_SELECT,
    });
    return {
      ...toEnrollmentView(enrollment),
      personName: enrollment.person.name,
      successCode: 'ENROLLMENT_UPDATE_SUCCESS',
    };
  }

  async markEnrollmentDormant(programId: string, enrollmentId: string) {
    // The conditional update is the transition: two clicks race and exactly
    // one flips the status.
    const { count } = await this.prisma.programEnrollment.updateMany({
      where: { id: enrollmentId, programId, status: 'ACTIVE' },
      data: { status: 'DORMANT' },
    });
    if (count === 0) {
      await this.findEnrollmentOrThrow(programId, enrollmentId);
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
      personName: enrollment.person.name,
      successCode: 'ENROLLMENT_MARK_DORMANT_SUCCESS',
    };
  }

  /**
   * Undoes a mistaken enrollment. Refused once the person has paid anything
   * to the program: from then on the enrollment anchors part of the books and
   * can only go dormant.
   */
  async removeEnrollment(programId: string, enrollmentId: string) {
    const enrollment = await this.findEnrollmentOrThrow(
      programId,
      enrollmentId,
    );
    const payments = await this.prisma.payment.count({
      where: { programId, personId: enrollment.personId },
    });
    if (payments > 0) throw this.hasPayments(payments);

    // Hard delete: with no payments the enrollment carries no history, and a
    // tombstone would hold the (person, program) unique key and block
    // enrolling the person again.
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
      personName: enrollment.person.name,
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

  private buildPersonSearch(q: string): Prisma.PersonWhereInput {
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
