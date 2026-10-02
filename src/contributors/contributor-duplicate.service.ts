import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from 'generated/prisma/client';
import { AppException } from 'src/common/exceptions/app.exception';
import { assertNoBlockers } from 'src/common/utils/blockers.util';
import { errorMessage } from 'src/common/utils/error.util';
import { PrismaService } from 'src/prisma/prisma.service';
import type { ListDuplicatesQueryDto } from './dto/list-duplicates-query.dto';
import type { MergeDuplicateDto } from './dto/merge-duplicate.dto';
import {
  duplicateReasons,
  findDuplicatePairs,
  orderedPair,
  type DuplicatePair,
  type ContributorKey,
} from './contributor-duplicate.util';
import {
  CONTRIBUTOR_DETAIL_SELECT,
  CONTRIBUTOR_SCAN_CAP,
} from './contributor.constant';
import { toContributorDetailView } from './contributor.util';

const FLAG_CONTRIBUTOR_SELECT = {
  ...CONTRIBUTOR_DETAIL_SELECT,
  // A resolved flag still shows both records; the merged one is retired.
  isDeleted: true,
  mergedIntoId: true,
} satisfies Prisma.ContributorSelect;

const FLAG_SELECT = {
  id: true,
  status: true,
  reasons: true,
  createdAt: true,
  resolvedAt: true,
  resolvedBy: { select: { name: true } },
  contributorA: { select: FLAG_CONTRIBUTOR_SELECT },
  contributorB: { select: FLAG_CONTRIBUTOR_SELECT },
} satisfies Prisma.ContributorDuplicateFlagSelect;

type FlagRow = Prisma.ContributorDuplicateFlagGetPayload<{
  select: typeof FLAG_SELECT;
}>;
type FlagContributorRow = FlagRow['contributorA'];

function toFlagContributorView({
  isDeleted,
  mergedIntoId,
  ...contributor
}: FlagContributorRow) {
  return { ...toContributorDetailView(contributor), isDeleted, mergedIntoId };
}

function toFlagView(flag: FlagRow) {
  return {
    ...flag,
    contributorA: toFlagContributorView(flag.contributorA),
    contributorB: toFlagContributorView(flag.contributorB),
  };
}

// Each statement of a merge runs on the transaction client.
type MergeClient = Pick<
  PrismaService,
  'contributor' | 'programEnrollment' | 'payment' | 'contributorDuplicateFlag'
>;

const FLAG_INSERT_BATCH = 500;

class ScanTooLargeError extends AppException {
  constructor() {
    super(
      'CONTRIBUTOR_SCAN_TOO_LARGE',
      { limit: CONTRIBUTOR_SCAN_CAP },
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * The duplicate-contributor review queue. A scan *proposes* pairs
 * (contributor-duplicate.util.ts) and stores them as OPEN flags; a reviewer
 * then confirms (merge) or rejects (dismiss) each one. Nothing merges on a
 * match. Migrations and imports create one Contributor per source row and leave
 * the identity question to this queue — except seed:contributors, which was
 * asked to fold the workbook's cross-sheet pairs (same first two names, same
 * serial) itself; see src/scripts/seed-contributors.ts.
 *
 * Exported for ContributorService, which checks each new or renamed contributor
 * against everyone else as it is saved.
 */
@Injectable()
export class ContributorDuplicateService {
  private readonly logger = new Logger(ContributorDuplicateService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Flags `contributor` against every other live contributor. Returns how many new flags it raised. */
  async flagPossibleDuplicates(contributor: ContributorKey): Promise<number> {
    let others: ContributorKey[];
    try {
      others = await this.loadScanContributors();
    } catch (err) {
      // The contributor is already saved; failing their save over an advisory
      // check would be worse than skipping it. The full scan still covers them.
      if (!(err instanceof ScanTooLargeError)) throw err;
      this.logger.warn(
        `Skipped duplicate check for contributor ${contributor.id}: ${errorMessage(err)}`,
      );
      return 0;
    }
    const flags = others.flatMap((other) => {
      const reasons = duplicateReasons(contributor, other);
      return reasons.length > 0
        ? [{ ...orderedPair(contributor.id, other.id), reasons }]
        : [];
    });
    return this.insertFlags(flags);
  }

  /** Compares every live contributor with every other and raises flags for new candidate pairs. */
  async scanAll() {
    const contributors = await this.loadScanContributors();
    const pairs = findDuplicatePairs(contributors);
    const newFlags = await this.insertFlags(pairs);
    return {
      scanned: contributors.length,
      candidates: pairs.length,
      newFlags,
      successCode: 'CONTRIBUTOR_DUPLICATE_SCAN_SUCCESS',
    };
  }

  async listFlags({ cursor, limit, status }: ListDuplicatesQueryDto) {
    const [found, openCount] = await Promise.all([
      this.prisma.contributorDuplicateFlag.findMany({
        where: { status },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        // One extra row says whether another page exists without a count().
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: FLAG_SELECT,
      }),
      this.prisma.contributorDuplicateFlag.count({ where: { status: 'OPEN' } }),
    ]);
    const hasMore = found.length > limit;
    const rows = hasMore ? found.slice(0, limit) : found;
    return {
      items: rows.map(toFlagView),
      nextCursor: hasMore ? rows[rows.length - 1].id : null,
      openCount,
    };
  }

  async countOpenFlags(): Promise<{ openCount: number }> {
    const openCount = await this.prisma.contributorDuplicateFlag.count({
      where: { status: 'OPEN' },
    });
    return { openCount };
  }

  /** "These are different people." The pair is never raised again. */
  async dismissFlag(userId: string, flagId: string) {
    // The conditional update is the decision: two reviewers racing on one
    // flag both run this and exactly one wins.
    const { count } = await this.prisma.contributorDuplicateFlag.updateMany({
      where: { id: flagId, status: 'OPEN' },
      data: {
        status: 'DISMISSED',
        resolvedById: userId,
        resolvedAt: new Date(),
      },
    });
    if (count === 0) await this.explainUnclaimable(this.prisma, flagId);
    return {
      ...(await this.getFlag(flagId)),
      successCode: 'CONTRIBUTOR_DUPLICATE_DISMISS_SUCCESS',
    };
  }

  /**
   * "These are the same person — keep this one." Moves every enrollment of
   * the other record (and, through the composite FK's ON UPDATE CASCADE,
   * every payment under it) onto the kept record, then retires the other.
   *
   * Refused when both records are enrolled in the same periodic program:
   * their pledges, previous subscriptions and possibly the same months would
   * collide, and which figures are right is a call for a reviewer to make —
   * by removing or correcting one enrollment first. Both having given to the
   * same temporary program is no conflict: donor rows carry no figures and
   * dated gifts never collide, so the gifts move and one row remains.
   */
  async mergeFlag(userId: string, flagId: string, dto: MergeDuplicateDto) {
    // One transaction: claiming the flag, retiring one record and moving its
    // enrollments commit together or not at all — a half-done merge would
    // leave payments under a retired contributor.
    const merged = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.contributorDuplicateFlag.updateMany({
        where: { id: flagId, status: 'OPEN' },
        data: {
          status: 'MERGED',
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      });
      if (count === 0) await this.explainUnclaimable(tx, flagId);

      const flag = await tx.contributorDuplicateFlag.findUniqueOrThrow({
        where: { id: flagId },
        select: { contributorAId: true, contributorBId: true },
      });
      if (
        dto.keepContributorId !== flag.contributorAId &&
        dto.keepContributorId !== flag.contributorBId
      ) {
        throw new AppException('DUPLICATE_MERGE_KEEP_INVALID', {
          keepContributorId: dto.keepContributorId,
        });
      }
      const dropContributorId =
        dto.keepContributorId === flag.contributorAId
          ? flag.contributorBId
          : flag.contributorAId;
      return this.mergeContributors(
        tx,
        dto.keepContributorId,
        dropContributorId,
      );
    });
    return {
      ...(await this.getFlag(flagId)),
      ...merged,
      successCode: 'CONTRIBUTOR_DUPLICATE_MERGE_SUCCESS',
    };
  }

  private async mergeContributors(
    tx: MergeClient,
    keepContributorId: string,
    dropContributorId: string,
  ) {
    // Retire the merged-away record first, conditionally. The row lock this
    // takes serialises against any other merge touching the same contributor,
    // and a record another reviewer already merged away fails here rather than
    // being merged twice. updateMany is not soft-delete filtered, hence the
    // explicit isDeleted.
    const retired = await tx.contributor.updateMany({
      where: { id: dropContributorId, isDeleted: false },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        mergedIntoId: keepContributorId,
      },
    });
    const kept = await tx.contributor.findFirst({
      where: { id: keepContributorId, isDeleted: false },
      select: { id: true, phone: true, email: true },
    });
    if (retired.count === 0 || !kept) {
      throw new AppException(
        'DUPLICATE_CONTRIBUTOR_GONE',
        {},
        HttpStatus.CONFLICT,
      );
    }

    // Bounded by the number of programs: one enrollment per contributor per
    // program.
    const keepEnrollments = await tx.programEnrollment.findMany({
      where: { contributorId: keepContributorId },
      select: { programId: true },
    });
    const dropEnrollments = await tx.programEnrollment.findMany({
      where: { contributorId: dropContributorId },
      select: {
        programId: true,
        program: { select: { name: true, type: true } },
      },
    });
    const keepPrograms = new Set(keepEnrollments.map((e) => e.programId));
    const shared = dropEnrollments.filter((e) => keepPrograms.has(e.programId));
    assertNoBlockers(
      'CONTRIBUTOR_MERGE_CONFLICT',
      shared
        .filter((e) => e.program.type === 'PERIODIC')
        .map((e) => ({
          kind: 'PROGRAM' as const,
          id: e.programId,
          name: e.program.name,
        })),
    );

    // Programs both gave to: the gifts move onto the kept donor row (the
    // composite FK finds it already there), then the emptied row goes. The
    // updateMany below would otherwise hit the (contributor, program) key.
    const sharedDonations = shared.map((e) => e.programId);
    if (sharedDonations.length > 0) {
      await tx.payment.updateMany({
        where: {
          contributorId: dropContributorId,
          programId: { in: sharedDonations },
        },
        data: { contributorId: keepContributorId },
      });
      await tx.programEnrollment.deleteMany({
        where: {
          contributorId: dropContributorId,
          programId: { in: sharedDonations },
        },
      });
    }

    // ON UPDATE CASCADE on Payment's (contributorId, programId) FK re-points
    // every payment of each moved enrollment in this same statement.
    const moved = await tx.programEnrollment.updateMany({
      where: { contributorId: dropContributorId },
      data: { contributorId: keepContributorId },
    });

    // The kept record wins every field it has; it only gains contact details
    // it was missing.
    const dropped = await tx.contributor.findUniqueOrThrow({
      where: { id: dropContributorId },
      select: { phone: true, email: true },
    });
    if ((!kept.phone && dropped.phone) || (!kept.email && dropped.email)) {
      await tx.contributor.update({
        where: { id: keepContributorId },
        data: {
          phone: kept.phone ?? dropped.phone,
          email: kept.email ?? dropped.email,
        },
      });
    }

    // Other open suggestions about the retired record are moot: a rescan
    // raises any (kept, X) pair that still looks alike. Decided flags stay as
    // the record of who decided what.
    await tx.contributorDuplicateFlag.deleteMany({
      where: {
        status: 'OPEN',
        OR: [
          { contributorAId: dropContributorId },
          { contributorBId: dropContributorId },
        ],
      },
    });

    return {
      keptContributorId: keepContributorId,
      mergedContributorId: dropContributorId,
      movedEnrollments: moved.count + sharedDonations.length,
    };
  }

  private async getFlag(flagId: string) {
    return toFlagView(
      await this.prisma.contributorDuplicateFlag.findUniqueOrThrow({
        where: { id: flagId },
        select: FLAG_SELECT,
      }),
    );
  }

  // Why a conditional claim matched nothing: no such flag (404), or someone
  // already decided it (409, naming how).
  private async explainUnclaimable(
    db: Pick<PrismaService, 'contributorDuplicateFlag'>,
    flagId: string,
  ): Promise<never> {
    const flag = await db.contributorDuplicateFlag.findUnique({
      where: { id: flagId },
      select: { status: true },
    });
    if (!flag) {
      throw new AppException(
        'DUPLICATE_FLAG_NOT_FOUND',
        { flagId },
        HttpStatus.NOT_FOUND,
      );
    }
    throw new AppException(
      'DUPLICATE_FLAG_ALREADY_RESOLVED',
      { status: flag.status },
      HttpStatus.CONFLICT,
    );
  }

  private async loadScanContributors(): Promise<ContributorKey[]> {
    // Soft-delete filtered: retired and merged records are never candidates.
    const contributors = await this.prisma.contributor.findMany({
      orderBy: { id: 'asc' },
      take: CONTRIBUTOR_SCAN_CAP + 1,
      select: { id: true, name: true, accountNumber: true },
    });
    if (contributors.length > CONTRIBUTOR_SCAN_CAP)
      throw new ScanTooLargeError();
    return contributors;
  }

  // The unique (contributorAId, contributorBId) index is the dedupe: a pair
  // raised before — open, merged or dismissed — is skipped, so a dismissed pair
  // never comes back.
  private async insertFlags(flags: DuplicatePair[]): Promise<number> {
    let inserted = 0;
    for (let offset = 0; offset < flags.length; offset += FLAG_INSERT_BATCH) {
      const { count } = await this.prisma.contributorDuplicateFlag.createMany({
        data: flags.slice(offset, offset + FLAG_INSERT_BATCH),
        skipDuplicates: true,
      });
      inserted += count;
    }
    return inserted;
  }
}
