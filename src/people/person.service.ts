import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from 'generated/prisma/client';
import { AppException } from 'src/common/exceptions/app.exception';
import { assertNoBlockers } from 'src/common/utils/blockers.util';
import { isUniqueViolation } from 'src/common/utils/prisma-error.util';
import { PROGRAM_CAP } from 'src/programs/program.constant';
import { PrismaService } from 'src/prisma/prisma.service';
import type { CreatePersonDto } from './dto/create-person.dto';
import type { ListPeopleQueryDto } from './dto/list-people-query.dto';
import type { UpdatePersonDto } from './dto/update-person.dto';
import { PersonDuplicateService } from './person-duplicate.service';
import {
  PERSON_DETAIL_SELECT,
  PERSON_ORDER_BY,
  PERSON_SELECT,
  type PersonRow,
} from './person.constant';
import { toPersonDetailView, type PersonDetailView } from './person.util';

const DIGITS_ONLY = /^\d+$/;

/**
 * People — one record per human across every program. Saving a person checks
 * them against everyone else and raises review flags for likely duplicates,
 * but never merges: that is PersonDuplicateService.mergeFlag, called by a
 * reviewer.
 *
 * Exported for EnrollmentModule, which enrolls existing people and can create
 * a new one in the same step.
 */
@Injectable()
export class PersonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly duplicates: PersonDuplicateService,
  ) {}

  async listPeople({ cursor, limit, q }: ListPeopleQueryDto) {
    // One extra row says whether another page exists without a count().
    const found = await this.prisma.person.findMany({
      where: this.buildSearch(q),
      orderBy: PERSON_ORDER_BY,
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: PERSON_DETAIL_SELECT,
    });
    const hasMore = found.length > limit;
    const rows = hasMore ? found.slice(0, limit) : found;
    return {
      items: rows.map(toPersonDetailView),
      nextCursor: hasMore ? rows[rows.length - 1].id : null,
    };
  }

  async getPerson(personId: string): Promise<PersonDetailView> {
    const person = await this.prisma.person.findFirst({
      where: { id: personId },
      select: PERSON_DETAIL_SELECT,
    });
    if (!person) throw this.notFound(personId);
    return toPersonDetailView(person);
  }

  // findFirst, not findUnique: only findFirst goes through the soft-delete
  // filter, and a deleted or merged-away person must 404 like a missing one.
  async assertPersonExists(personId: string): Promise<PersonRow> {
    const person = await this.prisma.person.findFirst({
      where: { id: personId },
      select: PERSON_SELECT,
    });
    if (!person) throw this.notFound(personId);
    return person;
  }

  async createPerson(dto: CreatePersonDto) {
    const person = await this.insertPerson(this.prisma, dto);
    const possibleDuplicates =
      await this.duplicates.flagPossibleDuplicates(person);
    return {
      ...(await this.getPerson(person.id)),
      possibleDuplicates,
      successCode: 'PERSON_CREATE_SUCCESS',
    };
  }

  /**
   * The insert alone, on any client — EnrollmentService runs it inside its
   * own transaction and raises the duplicate check after commit.
   */
  async insertPerson(
    db: Pick<PrismaService, 'person'>,
    dto: CreatePersonDto,
  ): Promise<PersonRow> {
    try {
      return await db.person.create({ data: dto, select: PERSON_SELECT });
    } catch (err) {
      throw this.explainAccountNumberClash(err, dto.accountNumber);
    }
  }

  /**
   * The duplicate check for a person saved outside createPerson — by
   * EnrollmentService after its transaction commits, since the flags'
   * foreign keys must see the new row.
   */
  flagPossibleDuplicates(person: PersonRow): Promise<number> {
    return this.duplicates.flagPossibleDuplicates(person);
  }

  async updatePerson(personId: string, dto: UpdatePersonDto) {
    const existing = await this.assertPersonExists(personId);
    let person: PersonRow;
    try {
      person = await this.prisma.person.update({
        where: { id: personId },
        data: dto,
        select: PERSON_SELECT,
      });
    } catch (err) {
      throw this.explainAccountNumberClash(
        err,
        dto.accountNumber ?? existing.accountNumber,
      );
    }
    // A corrected name or number can reveal a duplicate the old one hid.
    const identityChanged =
      person.name !== existing.name ||
      person.accountNumber !== existing.accountNumber;
    const possibleDuplicates = identityChanged
      ? await this.duplicates.flagPossibleDuplicates(person)
      : 0;
    return {
      ...(await this.getPerson(personId)),
      possibleDuplicates,
      successCode: 'PERSON_UPDATE_SUCCESS',
    };
  }

  /**
   * Only a person enrolled nowhere can be removed. Someone with payment
   * history keeps their record forever; per program they can only go
   * dormant. Deleted programs count too — restoring one must not bring back
   * an enrollment that points at a removed person.
   */
  async deletePerson(personId: string) {
    const person = await this.assertPersonExists(personId);
    const enrollments = await this.prisma.programEnrollment.findMany({
      where: { personId },
      select: { program: { select: { id: true, name: true } } },
      take: PROGRAM_CAP,
    });
    assertNoBlockers(
      'PERSON_HAS_ENROLLMENTS',
      enrollments.map(({ program }) => ({
        kind: 'PROGRAM' as const,
        id: program.id,
        name: program.name,
      })),
    );

    // Soft delete: the account number stays taken, so it is never reissued
    // to someone else. Open duplicate suggestions about the person go with
    // them; decided ones stay as history.
    await this.prisma.$transaction([
      this.prisma.person.update({
        where: { id: personId },
        data: { isDeleted: true, deletedAt: new Date() },
      }),
      this.prisma.personDuplicateFlag.deleteMany({
        where: {
          status: 'OPEN',
          OR: [{ personAId: personId }, { personBId: personId }],
        },
      }),
    ]);
    return {
      id: personId,
      name: person.name,
      successCode: 'PERSON_DELETE_SUCCESS',
    };
  }

  private buildSearch(q: string | undefined): Prisma.PersonWhereInput {
    if (!q) return {};
    return {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        ...(DIGITS_ONLY.test(q) ? [{ accountNumber: { startsWith: q } }] : []),
      ],
    };
  }

  // The unique index on accountNumber is the dedupe — it also spans deleted
  // and merged people, whose numbers are retired rather than reissued.
  private explainAccountNumberClash(
    err: unknown,
    accountNumber: string,
  ): unknown {
    if (!isUniqueViolation(err)) return err;
    return new AppException(
      'PERSON_ACCOUNT_NUMBER_TAKEN',
      { accountNumber },
      HttpStatus.CONFLICT,
    );
  }

  private notFound(personId: string): AppException {
    return new AppException(
      'PERSON_NOT_FOUND',
      { personId },
      HttpStatus.NOT_FOUND,
    );
  }
}
