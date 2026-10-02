import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from 'generated/prisma/client';
import { AppException } from 'src/common/exceptions/app.exception';
import { assertNoBlockers } from 'src/common/utils/blockers.util';
import { isUniqueViolation } from 'src/common/utils/prisma-error.util';
import { PROGRAM_CAP, PROGRAM_ORDER_BY } from 'src/programs/program.constant';
import { PrismaService } from 'src/prisma/prisma.service';
import type { CreateContributorDto } from './dto/create-contributor.dto';
import {
  IN_NO_PROGRAM,
  type ListContributorsQueryDto,
} from './dto/list-contributors-query.dto';
import type { UpdateContributorDto } from './dto/update-contributor.dto';
import { ContributorDuplicateService } from './contributor-duplicate.service';
import {
  CONTRIBUTOR_DETAIL_SELECT,
  CONTRIBUTOR_ORDER_BY,
  CONTRIBUTOR_SCAN_CAP,
  CONTRIBUTOR_SELECT,
  type ContributorRow,
} from './contributor.constant';
import {
  toContributorDetailView,
  toYearActivity,
  type ContributorDetailView,
  type YearPaymentGroup,
} from './contributor.util';

const DIGITS_ONLY = /^\d+$/;

/**
 * Contributors — one record per human across every program. Saving a
 * contributor checks them against everyone else and raises review flags for
 * likely duplicates, but never merges: that is
 * ContributorDuplicateService.mergeFlag, called by a reviewer.
 *
 * Exported for EnrollmentModule, which enrolls existing contributors and can
 * create a new one in the same step.
 */
@Injectable()
export class ContributorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly duplicates: ContributorDuplicateService,
  ) {}

  async listContributors({
    cursor,
    limit,
    q,
    program,
    year,
  }: ListContributorsQueryDto) {
    // One extra row says whether another page exists without a count().
    const found = await this.prisma.contributor.findMany({
      where: { AND: [this.buildSearch(q), this.buildProgramFilter(program)] },
      orderBy: CONTRIBUTOR_ORDER_BY,
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: CONTRIBUTOR_DETAIL_SELECT,
    });
    const hasMore = found.length > limit;
    const rows = hasMore ? found.slice(0, limit) : found;
    const items = rows.map(toContributorDetailView);
    const nextCursor = hasMore ? rows[rows.length - 1].id : null;
    if (year === undefined) return { items, nextCursor };
    return {
      year,
      items: await this.withYearActivity(items, year),
      nextCursor,
    };
  }

  /**
   * The directory's header: how many contributors there are, how many sit in
   * each program, and how many are in none. Counts only — nothing here adds
   * money across programs. One round trip: every count runs side by side.
   */
  async getDirectoryStats() {
    // Relation filters are not rewritten by the soft-delete extension, so an
    // enrollment in a deleted program — or of a merged-away contributor — is
    // excluded here by name.
    const liveEnrollment = {
      program: { isDeleted: false },
      contributor: { isDeleted: false },
    } satisfies Prisma.ProgramEnrollmentWhereInput;

    const [total, inNoProgram, withContact, severalPrograms, programs, counts] =
      await Promise.all([
        this.prisma.contributor.count(),
        this.prisma.contributor.count({
          where: { enrollments: { none: { program: { isDeleted: false } } } },
        }),
        // Blank phone and email are stored as NULL (see the create DTO), so
        // NOT NULL means a real value.
        this.prisma.contributor.count({
          where: { OR: [{ phone: { not: null } }, { email: { not: null } }] },
        }),
        // Prisma cannot count groups, so the groups come back and are
        // counted here — only contributors in two or more programs, a
        // handful, bounded by the scan cap regardless.
        this.prisma.programEnrollment.groupBy({
          by: ['contributorId'],
          where: liveEnrollment,
          having: { contributorId: { _count: { gt: 1 } } },
          orderBy: { contributorId: 'asc' },
          take: CONTRIBUTOR_SCAN_CAP,
        }),
        this.prisma.program.findMany({
          orderBy: PROGRAM_ORDER_BY,
          take: PROGRAM_CAP,
          select: { id: true, name: true, isProtected: true },
        }),
        // At most two groups per program: ACTIVE and DORMANT.
        this.prisma.programEnrollment.groupBy({
          by: ['programId', 'status'],
          where: liveEnrollment,
          _count: { _all: true },
        }),
      ]);

    const countOf = (programId: string, status: 'ACTIVE' | 'DORMANT') =>
      counts.find((row) => row.programId === programId && row.status === status)
        ?._count._all ?? 0;
    return {
      total,
      inNoProgram,
      inSeveralPrograms: severalPrograms.length,
      withContact,
      programs: programs.map((p) => ({
        ...p,
        enrolled: countOf(p.id, 'ACTIVE') + countOf(p.id, 'DORMANT'),
        dormant: countOf(p.id, 'DORMANT'),
      })),
    };
  }

  async getContributor(contributorId: string): Promise<ContributorDetailView> {
    const contributor = await this.prisma.contributor.findFirst({
      where: { id: contributorId },
      select: CONTRIBUTOR_DETAIL_SELECT,
    });
    if (!contributor) throw this.notFound(contributorId);
    return toContributorDetailView(contributor);
  }

  // findFirst, not findUnique: only findFirst goes through the soft-delete
  // filter, and a deleted or merged-away contributor must 404 like a missing
  // one.
  async assertContributorExists(
    contributorId: string,
  ): Promise<ContributorRow> {
    const contributor = await this.prisma.contributor.findFirst({
      where: { id: contributorId },
      select: CONTRIBUTOR_SELECT,
    });
    if (!contributor) throw this.notFound(contributorId);
    return contributor;
  }

  async createContributor(dto: CreateContributorDto) {
    const contributor = await this.insertContributor(this.prisma, dto);
    const possibleDuplicates =
      await this.duplicates.flagPossibleDuplicates(contributor);
    return {
      ...(await this.getContributor(contributor.id)),
      possibleDuplicates,
      successCode: 'CONTRIBUTOR_CREATE_SUCCESS',
    };
  }

  /**
   * The insert alone, on any client — EnrollmentService runs it inside its
   * own transaction and raises the duplicate check after commit.
   */
  async insertContributor(
    db: Pick<PrismaService, 'contributor'>,
    dto: CreateContributorDto,
  ): Promise<ContributorRow> {
    try {
      return await db.contributor.create({
        data: dto,
        select: CONTRIBUTOR_SELECT,
      });
    } catch (err) {
      throw this.explainAccountNumberClash(err, dto.accountNumber);
    }
  }

  /**
   * The duplicate check for a contributor saved outside createContributor — by
   * EnrollmentService after its transaction commits, since the flags'
   * foreign keys must see the new row.
   */
  flagPossibleDuplicates(contributor: ContributorRow): Promise<number> {
    return this.duplicates.flagPossibleDuplicates(contributor);
  }

  async updateContributor(contributorId: string, dto: UpdateContributorDto) {
    const existing = await this.assertContributorExists(contributorId);
    let contributor: ContributorRow;
    try {
      contributor = await this.prisma.contributor.update({
        where: { id: contributorId },
        data: dto,
        select: CONTRIBUTOR_SELECT,
      });
    } catch (err) {
      throw this.explainAccountNumberClash(
        err,
        dto.accountNumber ?? existing.accountNumber,
      );
    }
    // A corrected name or number can reveal a duplicate the old one hid.
    const identityChanged =
      contributor.name !== existing.name ||
      contributor.accountNumber !== existing.accountNumber;
    const possibleDuplicates = identityChanged
      ? await this.duplicates.flagPossibleDuplicates(contributor)
      : 0;
    return {
      ...(await this.getContributor(contributorId)),
      possibleDuplicates,
      successCode: 'CONTRIBUTOR_UPDATE_SUCCESS',
    };
  }

  /**
   * Only a contributor enrolled nowhere can be removed. Someone with payment
   * history keeps their record forever; per program they can only go
   * dormant. Deleted programs count too — restoring one must not bring back
   * an enrollment that points at a removed contributor.
   */
  async deleteContributor(contributorId: string) {
    const contributor = await this.assertContributorExists(contributorId);
    const enrollments = await this.prisma.programEnrollment.findMany({
      where: { contributorId },
      select: { program: { select: { id: true, name: true } } },
      take: PROGRAM_CAP,
    });
    assertNoBlockers(
      'CONTRIBUTOR_HAS_ENROLLMENTS',
      enrollments.map(({ program }) => ({
        kind: 'PROGRAM' as const,
        id: program.id,
        name: program.name,
      })),
    );

    // Soft delete: the account number stays taken, so it is never reissued
    // to someone else. Open duplicate suggestions about the contributor go with
    // them; decided ones stay as history.
    await this.prisma.$transaction([
      this.prisma.contributor.update({
        where: { id: contributorId },
        data: { isDeleted: true, deletedAt: new Date() },
      }),
      this.prisma.contributorDuplicateFlag.deleteMany({
        where: {
          status: 'OPEN',
          OR: [
            { contributorAId: contributorId },
            { contributorBId: contributorId },
          ],
        },
      }),
    ]);
    return {
      id: contributorId,
      name: contributor.name,
      successCode: 'CONTRIBUTOR_DELETE_SUCCESS',
    };
  }

  private buildSearch(q: string | undefined): Prisma.ContributorWhereInput {
    if (!q) return {};
    return {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        ...(DIGITS_ONLY.test(q) ? [{ accountNumber: { startsWith: q } }] : []),
      ],
    };
  }

  // An unknown program id is not an error: it lists no one, the same answer
  // a deleted program gives.
  private buildProgramFilter(
    program: string | undefined,
  ): Prisma.ContributorWhereInput {
    if (!program) return {};
    if (program === IN_NO_PROGRAM) {
      return { enrollments: { none: { program: { isDeleted: false } } } };
    }
    return {
      enrollments: {
        some: { programId: program, program: { isDeleted: false } },
      },
    };
  }

  /**
   * Attaches one year of payments to every enrollment on the page. A second
   * round trip, so it is skipped when no one on the page is enrolled — today
   * the common case. The groups are bounded by construction: per enrollment,
   * at most twelve months (each paid or ★) plus one group of dated entries.
   */
  private async withYearActivity(items: ContributorDetailView[], year: number) {
    const enrolled = items.filter((item) => item.enrollments.length > 0);
    const groups =
      enrolled.length === 0
        ? []
        : await this.prisma.payment.groupBy({
            by: ['contributorId', 'programId', 'month', 'isStarred'],
            where: {
              contributorId: { in: enrolled.map((item) => item.id) },
              year,
            },
            _sum: { amount: true },
            _count: { _all: true },
          });

    const byEnrollment = new Map<string, YearPaymentGroup[]>();
    for (const group of groups) {
      const key = `${group.contributorId}:${group.programId}`;
      const list = byEnrollment.get(key) ?? [];
      list.push({
        month: group.month,
        isStarred: group.isStarred,
        amount: group._sum.amount,
        count: group._count._all,
      });
      byEnrollment.set(key, list);
    }
    return items.map((item) => ({
      ...item,
      enrollments: item.enrollments.map((enrollment) => ({
        ...enrollment,
        activity: toYearActivity(
          byEnrollment.get(`${item.id}:${enrollment.programId}`) ?? [],
          enrollment.entryMode,
        ),
      })),
    }));
  }

  // The unique index on accountNumber is the dedupe — it also spans deleted
  // and merged contributors, whose numbers are retired rather than reissued.
  private explainAccountNumberClash(
    err: unknown,
    accountNumber: string,
  ): unknown {
    if (!isUniqueViolation(err)) return err;
    return new AppException(
      'CONTRIBUTOR_ACCOUNT_NUMBER_TAKEN',
      { accountNumber },
      HttpStatus.CONFLICT,
    );
  }

  private notFound(contributorId: string): AppException {
    return new AppException(
      'CONTRIBUTOR_NOT_FOUND',
      { contributorId },
      HttpStatus.NOT_FOUND,
    );
  }
}
