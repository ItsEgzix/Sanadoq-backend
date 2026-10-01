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
  type PersonKey,
} from './person-duplicate.util';
import { PERSON_DETAIL_SELECT, PERSON_SCAN_CAP } from './person.constant';
import { toPersonDetailView } from './person.util';

const FLAG_PERSON_SELECT = {
  ...PERSON_DETAIL_SELECT,
  // A resolved flag still shows both records; the merged one is retired.
  isDeleted: true,
  mergedIntoId: true,
} satisfies Prisma.PersonSelect;

const FLAG_SELECT = {
  id: true,
  status: true,
  reasons: true,
  createdAt: true,
  resolvedAt: true,
  resolvedBy: { select: { name: true } },
  personA: { select: FLAG_PERSON_SELECT },
  personB: { select: FLAG_PERSON_SELECT },
} satisfies Prisma.PersonDuplicateFlagSelect;

type FlagRow = Prisma.PersonDuplicateFlagGetPayload<{
  select: typeof FLAG_SELECT;
}>;
type FlagPersonRow = FlagRow['personA'];

function toFlagPersonView({
  isDeleted,
  mergedIntoId,
  ...person
}: FlagPersonRow) {
  return { ...toPersonDetailView(person), isDeleted, mergedIntoId };
}

function toFlagView(flag: FlagRow) {
  return {
    ...flag,
    personA: toFlagPersonView(flag.personA),
    personB: toFlagPersonView(flag.personB),
  };
}

// Each statement of a merge runs on the transaction client.
type MergeClient = Pick<
  PrismaService,
  'person' | 'programEnrollment' | 'personDuplicateFlag'
>;

const FLAG_INSERT_BATCH = 500;

class ScanTooLargeError extends AppException {
  constructor() {
    super(
      'PERSON_SCAN_TOO_LARGE',
      { limit: PERSON_SCAN_CAP },
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * The duplicate-person review queue. A scan *proposes* pairs
 * (person-duplicate.util.ts) and stores them as OPEN flags; a person then
 * confirms (merge) or rejects (dismiss) each one. Nothing merges on a match.
 * Migrations and imports create one Person per source row and leave the
 * identity question to this queue.
 *
 * Exported for PersonService, which checks each new or renamed person against
 * everyone else as it is saved.
 */
@Injectable()
export class PersonDuplicateService {
  private readonly logger = new Logger(PersonDuplicateService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Flags `person` against every other live person. Returns how many new flags it raised. */
  async flagPossibleDuplicates(person: PersonKey): Promise<number> {
    let others: PersonKey[];
    try {
      others = await this.loadScanPeople();
    } catch (err) {
      // The person is already saved; failing their save over an advisory
      // check would be worse than skipping it. The full scan still covers them.
      if (!(err instanceof ScanTooLargeError)) throw err;
      this.logger.warn(
        `Skipped duplicate check for person ${person.id}: ${errorMessage(err)}`,
      );
      return 0;
    }
    const flags = others.flatMap((other) => {
      const reasons = duplicateReasons(person, other);
      return reasons.length > 0
        ? [{ ...orderedPair(person.id, other.id), reasons }]
        : [];
    });
    return this.insertFlags(flags);
  }

  /** Compares every live person with every other and raises flags for new candidate pairs. */
  async scanAll() {
    const people = await this.loadScanPeople();
    const pairs = findDuplicatePairs(people);
    const newFlags = await this.insertFlags(pairs);
    return {
      scanned: people.length,
      candidates: pairs.length,
      newFlags,
      successCode: 'PERSON_DUPLICATE_SCAN_SUCCESS',
    };
  }

  async listFlags({ cursor, limit, status }: ListDuplicatesQueryDto) {
    const [found, openCount] = await Promise.all([
      this.prisma.personDuplicateFlag.findMany({
        where: { status },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        // One extra row says whether another page exists without a count().
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: FLAG_SELECT,
      }),
      this.prisma.personDuplicateFlag.count({ where: { status: 'OPEN' } }),
    ]);
    const hasMore = found.length > limit;
    const rows = hasMore ? found.slice(0, limit) : found;
    return {
      items: rows.map(toFlagView),
      nextCursor: hasMore ? rows[rows.length - 1].id : null,
      openCount,
    };
  }

  /** "These are different people." The pair is never raised again. */
  async dismissFlag(userId: string, flagId: string) {
    // The conditional update is the decision: two reviewers racing on one
    // flag both run this and exactly one wins.
    const { count } = await this.prisma.personDuplicateFlag.updateMany({
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
      successCode: 'PERSON_DUPLICATE_DISMISS_SUCCESS',
    };
  }

  /**
   * "These are the same person — keep this one." Moves every enrollment of
   * the other record (and, through the composite FK's ON UPDATE CASCADE,
   * every payment under it) onto the kept record, then retires the other.
   *
   * Refused when both records are enrolled in the same program: their
   * pledges, previous subscriptions and possibly the same months would
   * collide, and which figures are right is a call for a person to make —
   * by removing or correcting one enrollment first.
   */
  async mergeFlag(userId: string, flagId: string, dto: MergeDuplicateDto) {
    // One transaction: claiming the flag, retiring one record and moving its
    // enrollments commit together or not at all — a half-done merge would
    // leave payments under a retired person.
    const merged = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.personDuplicateFlag.updateMany({
        where: { id: flagId, status: 'OPEN' },
        data: {
          status: 'MERGED',
          resolvedById: userId,
          resolvedAt: new Date(),
        },
      });
      if (count === 0) await this.explainUnclaimable(tx, flagId);

      const flag = await tx.personDuplicateFlag.findUniqueOrThrow({
        where: { id: flagId },
        select: { personAId: true, personBId: true },
      });
      if (
        dto.keepPersonId !== flag.personAId &&
        dto.keepPersonId !== flag.personBId
      ) {
        throw new AppException('DUPLICATE_MERGE_KEEP_INVALID', {
          keepPersonId: dto.keepPersonId,
        });
      }
      const dropPersonId =
        dto.keepPersonId === flag.personAId ? flag.personBId : flag.personAId;
      return this.mergePeople(tx, dto.keepPersonId, dropPersonId);
    });
    return {
      ...(await this.getFlag(flagId)),
      ...merged,
      successCode: 'PERSON_DUPLICATE_MERGE_SUCCESS',
    };
  }

  private async mergePeople(
    tx: MergeClient,
    keepPersonId: string,
    dropPersonId: string,
  ) {
    // Retire the merged-away record first, conditionally. The row lock this
    // takes serialises against any other merge touching the same person, and
    // a record another reviewer already merged away fails here rather than
    // being merged twice. updateMany is not soft-delete filtered, hence the
    // explicit isDeleted.
    const retired = await tx.person.updateMany({
      where: { id: dropPersonId, isDeleted: false },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        mergedIntoId: keepPersonId,
      },
    });
    const kept = await tx.person.findFirst({
      where: { id: keepPersonId, isDeleted: false },
      select: { id: true, phone: true, email: true },
    });
    if (retired.count === 0 || !kept) {
      throw new AppException('DUPLICATE_PERSON_GONE', {}, HttpStatus.CONFLICT);
    }

    // Bounded by the number of programs: one enrollment per person per program.
    const keepEnrollments = await tx.programEnrollment.findMany({
      where: { personId: keepPersonId },
      select: { programId: true },
    });
    const dropEnrollments = await tx.programEnrollment.findMany({
      where: { personId: dropPersonId },
      select: { programId: true, program: { select: { name: true } } },
    });
    const keepPrograms = new Set(keepEnrollments.map((e) => e.programId));
    assertNoBlockers(
      'PERSON_MERGE_CONFLICT',
      dropEnrollments
        .filter((e) => keepPrograms.has(e.programId))
        .map((e) => ({
          kind: 'PROGRAM' as const,
          id: e.programId,
          name: e.program.name,
        })),
    );

    // ON UPDATE CASCADE on Payment's (personId, programId) FK re-points every
    // payment of each moved enrollment in this same statement.
    const moved = await tx.programEnrollment.updateMany({
      where: { personId: dropPersonId },
      data: { personId: keepPersonId },
    });

    // The kept record wins every field it has; it only gains contact details
    // it was missing.
    const dropped = await tx.person.findUniqueOrThrow({
      where: { id: dropPersonId },
      select: { phone: true, email: true },
    });
    if ((!kept.phone && dropped.phone) || (!kept.email && dropped.email)) {
      await tx.person.update({
        where: { id: keepPersonId },
        data: {
          phone: kept.phone ?? dropped.phone,
          email: kept.email ?? dropped.email,
        },
      });
    }

    // Other open suggestions about the retired record are moot: a rescan
    // raises any (kept, X) pair that still looks alike. Decided flags stay as
    // the record of who decided what.
    await tx.personDuplicateFlag.deleteMany({
      where: {
        status: 'OPEN',
        OR: [{ personAId: dropPersonId }, { personBId: dropPersonId }],
      },
    });

    return {
      keptPersonId: keepPersonId,
      mergedPersonId: dropPersonId,
      movedEnrollments: moved.count,
    };
  }

  private async getFlag(flagId: string) {
    return toFlagView(
      await this.prisma.personDuplicateFlag.findUniqueOrThrow({
        where: { id: flagId },
        select: FLAG_SELECT,
      }),
    );
  }

  // Why a conditional claim matched nothing: no such flag (404), or someone
  // already decided it (409, naming how).
  private async explainUnclaimable(
    db: Pick<PrismaService, 'personDuplicateFlag'>,
    flagId: string,
  ): Promise<never> {
    const flag = await db.personDuplicateFlag.findUnique({
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

  private async loadScanPeople(): Promise<PersonKey[]> {
    // Soft-delete filtered: retired and merged records are never candidates.
    const people = await this.prisma.person.findMany({
      orderBy: { id: 'asc' },
      take: PERSON_SCAN_CAP + 1,
      select: { id: true, name: true, accountNumber: true },
    });
    if (people.length > PERSON_SCAN_CAP) throw new ScanTooLargeError();
    return people;
  }

  // The unique (personAId, personBId) index is the dedupe: a pair raised
  // before — open, merged or dismissed — is skipped, so a dismissed pair
  // never comes back.
  private async insertFlags(flags: DuplicatePair[]): Promise<number> {
    let inserted = 0;
    for (let offset = 0; offset < flags.length; offset += FLAG_INSERT_BATCH) {
      const { count } = await this.prisma.personDuplicateFlag.createMany({
        data: flags.slice(offset, offset + FLAG_INSERT_BATCH),
        skipDuplicates: true,
      });
      inserted += count;
    }
    return inserted;
  }
}
