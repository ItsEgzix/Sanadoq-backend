/**
 * Seeds a demo fund in the Contributor / Program shape, so every screen has
 * something to show:
 *   - the protected fund program (made by the migration) with a 4-year cycle,
 *     2026–2029, and two dozen members with mixed habits — monthly, quarterly
 *     and annual lumps with ★ months, gaps, two dormant;
 *   - مواساة, its own monthly grid and cycle, with some of the same
 *     contributors at different rates, plus the fund's monthly contribution as
 *     a transfer row;
 *   - جامع السعيد, a smaller standing program in the same cycle, paid
 *     monthly with gaps;
 *   - a Ramadan campaign with one-off donors who are in no directory, and a
 *     donation from the fund;
 *   - two invented look-alike pairs, raised as duplicate flags for review —
 *     never merged.
 *
 *   npm run seed:demo            dry run — prints what it would write
 *   npm run seed:demo -- --apply writes it
 *
 * Re-runnable: every write dedupes on a unique key (account number,
 * enrollment, cell, a deterministic idempotency key, the flag pair) or an
 * existence check, so a second run adds nothing. The data comes from a
 * seeded PRNG, so every run plans the same rows. Payment history stops at
 * September 2026 — the demo's "today" is 1 October 2026. Every name is
 * invented.
 */
import 'dotenv/config';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { findDuplicatePairs } from '../contributors/contributor-duplicate.util';
import { matchContributorsByAccount, openDatabase } from './script.util';

const APPLY = process.argv.includes('--apply');
const BATCH = 500;
const LAST_PAID = { year: 2026, month: 9 };
const CYCLE = { startYear: 2026, lengthYears: 4, endYear: 2029 };

type Habit = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'IRREGULAR';

interface DemoContributor {
  name: string;
  accountNumber: string; // YYMMNNN
  fundRate?: number;
  habit?: Habit;
  dormant?: boolean;
  mwaRate?: number;
  jamea?: number; // monthly amount to جامع السعيد
}

const CONTRIBUTORS: DemoContributor[] = [
  {
    name: 'عبدالله حسن الطيب',
    accountNumber: '0903001',
    fundRate: 2400,
    habit: 'MONTHLY',
    mwaRate: 1200,
  },
  {
    name: 'محمد عثمان صالح',
    accountNumber: '0903002',
    fundRate: 1800,
    habit: 'ANNUAL',
  },
  {
    name: 'أحمد إبراهيم موسى',
    accountNumber: '1001003',
    fundRate: 1200,
    habit: 'MONTHLY',
    jamea: 500,
  },
  {
    name: 'فاطمة الطيب عوض',
    accountNumber: '1106004',
    fundRate: 1200,
    habit: 'QUARTERLY',
    mwaRate: 600,
  },
  {
    name: 'خالد عبدالرحمن نور',
    accountNumber: '1209005',
    fundRate: 3600,
    habit: 'MONTHLY',
    mwaRate: 2400,
  },
  {
    name: 'عمر الأمين بشير',
    accountNumber: '1302006',
    fundRate: 900,
    habit: 'IRREGULAR',
  },
  {
    name: 'سارة محمود حامد',
    accountNumber: '1411007',
    fundRate: 1500,
    habit: 'QUARTERLY',
  },
  {
    name: 'يوسف بشير الفاضل',
    accountNumber: '1504008',
    fundRate: 1200,
    habit: 'MONTHLY',
    dormant: true,
  },
  {
    name: 'مريم الصادق يعقوب',
    accountNumber: '1601009',
    fundRate: 2400,
    habit: 'ANNUAL',
    mwaRate: 1200,
  },
  {
    name: 'حسن علي مختار',
    accountNumber: '1608010',
    fundRate: 600,
    habit: 'MONTHLY',
  },
  {
    name: 'إبراهيم موسى الحاج',
    accountNumber: '1705011',
    fundRate: 1800,
    habit: 'MONTHLY',
    jamea: 300,
  },
  {
    name: 'عائشة حامد بابكر',
    accountNumber: '1803012',
    fundRate: 1200,
    habit: 'IRREGULAR',
  },
  {
    name: 'طارق الفاضل عبدالقادر',
    accountNumber: '1810013',
    fundRate: 3000,
    habit: 'QUARTERLY',
    mwaRate: 1800,
  },
  {
    name: 'نور الهدى عوض الكريم',
    accountNumber: '1907014',
    fundRate: 900,
    habit: 'MONTHLY',
  },
  {
    name: 'مصطفى بابكر صالح',
    accountNumber: '2002015',
    fundRate: 1500,
    habit: 'MONTHLY',
    dormant: true,
  },
  {
    name: 'هالة عبدالقادر يس',
    accountNumber: '2012016',
    fundRate: 1200,
    habit: 'ANNUAL',
  },
  {
    name: 'ياسر النور حمد',
    accountNumber: '2104017',
    fundRate: 2400,
    habit: 'MONTHLY',
    mwaRate: 1200,
  },
  {
    name: 'سلمى عبدالله الأمين',
    accountNumber: '2201018',
    fundRate: 600,
    habit: 'IRREGULAR',
  },
  {
    name: 'معاذ حسين جبريل',
    accountNumber: '2209019',
    fundRate: 1800,
    habit: 'QUARTERLY',
  },
  {
    name: 'آمنة الطاهر سعيد',
    accountNumber: '2305020',
    fundRate: 1200,
    habit: 'MONTHLY',
    mwaRate: 600,
  },
  {
    name: 'بكري صالح دفع الله',
    accountNumber: '2402021',
    fundRate: 1500,
    habit: 'MONTHLY',
  },
  {
    name: 'رشا مختار علي',
    accountNumber: '2408022',
    fundRate: 900,
    habit: 'QUARTERLY',
  },
  // An invented look-alike pair, modelled on the workbook's real ones: the
  // same man in two sheets, one writing more of his lineage, different join
  // dates (YYMM) but the same serial. Flagged NAME_EXTENDS + SAME_SERIAL.
  {
    name: 'عمر يوسف الحاج علي',
    accountNumber: '0905031',
    fundRate: 2400,
    habit: 'MONTHLY',
  },
  { name: 'عمر يوسف الحاج', accountNumber: '2402031', jamea: 700 },
  // Invented namesakes: identical names, unrelated numbers. Flagged
  // SAME_NAME — a reviewer would dismiss this pair.
  {
    name: 'زينب يعقوب آدم',
    accountNumber: '2601024',
    fundRate: 1200,
    habit: 'ANNUAL',
  },
  { name: 'زينب يعقوب آدم', accountNumber: '1207088', mwaRate: 600 },
];

const MWA = 'مواساة';
const JAMEA = 'جامع السعيد';
const CAMPAIGN = 'حملة رمضان ١٤٤٧';

// Invented one-off donors to the campaign — in no directory, by design.
const ONE_OFF_DONORS = [
  'فاعل خير',
  'آل عبدالمحمود',
  'متبرع من جدة',
  'أسرة الفكي',
  'صدقة سر',
  'جمعية الحي',
];

// ── Deterministic randomness ───────────────────────────────────────────────

// mulberry32: tiny, seedable, and good enough to make demo data look human.
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Planning ───────────────────────────────────────────────────────────────

interface PlannedCell {
  year: number;
  month: number;
  isStarred: boolean;
  amount: string | null;
}

const money = (value: number) => value.toFixed(2);

function paidMonths(): Array<{ year: number; month: number }> {
  const months: Array<{ year: number; month: number }> = [];
  for (let month = 1; month <= LAST_PAID.month; month++) {
    months.push({ year: LAST_PAID.year, month });
  }
  return months;
}

function planFundCells(
  contributor: DemoContributor,
  random: () => number,
): PlannedCell[] {
  const rate = contributor.fundRate ?? 0;
  const monthly = Math.round(rate / 12);
  // Dormant members stopped paying in June.
  const months = paidMonths().filter(
    (m) => !contributor.dormant || m.month < 6,
  );
  const cells: PlannedCell[] = [];
  for (const { year, month } of months) {
    switch (contributor.habit) {
      case 'MONTHLY':
        if (random() > 0.08) {
          cells.push({ year, month, isStarred: false, amount: money(monthly) });
        }
        break;
      case 'QUARTERLY':
        // A lump on the first month of each quarter; the other two months
        // are ★ — paid, but recorded under the lump's month.
        if ((month - 1) % 3 === 0) {
          if (random() > 0.1) {
            cells.push({
              year,
              month,
              isStarred: false,
              amount: money(monthly * 3),
            });
          }
        } else if (
          cells.some(
            (c) => !c.isStarred && c.month === month - ((month - 1) % 3),
          )
        ) {
          cells.push({ year, month, isStarred: true, amount: null });
        }
        break;
      case 'ANNUAL':
        // The whole year in March, every other month of it ★.
        cells.push(
          month === 3
            ? { year, month, isStarred: false, amount: money(rate) }
            : { year, month, isStarred: true, amount: null },
        );
        break;
      case 'IRREGULAR':
        if (random() < 0.45) {
          const covered = 1 + Math.floor(random() * 3);
          cells.push({
            year,
            month,
            isStarred: false,
            amount: money(monthly * covered),
          });
        }
        break;
    }
  }
  return cells;
}

function planMwaCells(rate: number, random: () => number): PlannedCell[] {
  const monthly = Math.round(rate / 12);
  return paidMonths()
    .filter(() => random() > 0.12)
    .map(({ year, month }) => ({
      year,
      month,
      isStarred: false,
      amount: money(monthly),
    }));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { prisma, description } = openDatabase(
    process.env.DATABASE_URL,
    process.env.DATABASE_SCHEMA,
  );
  console.log(`${APPLY ? 'APPLYING to' : 'Dry run against'} ${description}`);
  const random = createRandom(20261001);

  try {
    const fund = await prisma.program.findFirst({
      where: { isProtected: true },
      select: { id: true, name: true },
    });
    if (!fund)
      throw new Error('No protected fund program — run the migrations first.');

    // Programs — by live name, since the unique index is on lower(name).
    const programs = new Map<string, string>([['fund', fund.id]]);
    const wanted = [
      { key: MWA, type: 'PERIODIC' as const, sortOrder: 1 },
      { key: JAMEA, type: 'PERIODIC' as const, sortOrder: 2 },
      { key: CAMPAIGN, type: 'TEMPORARY' as const, sortOrder: 3 },
    ];
    for (const program of wanted) {
      const found = await prisma.program.findFirst({
        where: { name: program.key, isDeleted: false },
        select: { id: true },
      });
      console.log(`Program ${program.key}: ${found ? 'exists' : 'create'}`);
      if (found) programs.set(program.key, found.id);
      else if (APPLY) {
        const created = await prisma.program.create({
          data: {
            name: program.key,
            type: program.type,
            sortOrder: program.sortOrder,
          },
        });
        programs.set(program.key, created.id);
      } else {
        // A dry run plans this program's rows too, so its counts match --apply.
        programs.set(program.key, `planned:${program.key}`);
      }
    }

    // Cycles — every periodic program runs in one; current only when the
    // program has none.
    for (const key of ['fund', MWA, JAMEA]) {
      const programId = programs.get(key);
      const current = programId
        ? await prisma.cycle.findFirst({
            where: { programId, isCurrent: true },
          })
        : null;
      console.log(
        `Cycle ${CYCLE.startYear}–${CYCLE.endYear} for ${key === 'fund' ? fund.name : key}: ${current ? 'a current cycle exists' : 'create'}`,
      );
      if (APPLY && programId && !current) {
        await prisma.cycle.createMany({
          data: [{ programId, ...CYCLE, isCurrent: true }],
          skipDuplicates: true,
        });
      }
    }

    // Contributors — matched to this script's own earlier rows by account
    // number and name. A number someone else already holds is skipped, never
    // linked: the demo must not attach invented payments to a real contributor.
    console.log(`Contributors: ${CONTRIBUTORS.length} planned`);
    const planned = CONTRIBUTORS.map(({ name, accountNumber }) => ({
      key: accountNumber,
      name,
      accountNumber,
    }));
    const before = await matchContributorsByAccount(prisma, planned);
    if (APPLY && before.missing.length > 0) {
      const { count } = await prisma.contributor.createMany({
        data: before.missing.map(({ name, accountNumber }) => ({
          name,
          accountNumber,
        })),
        skipDuplicates: true,
      });
      console.log(`  inserted ${count}`);
    }
    const { ids: contributorIds, conflicts } = APPLY
      ? await matchContributorsByAccount(prisma, planned)
      : before;
    for (const { planned: contributor, existingName } of conflicts) {
      console.log(
        `  CONFLICT ${contributor.accountNumber} is "${existingName}", not "${contributor.name}" — skipped`,
      );
    }
    const skipped = new Set(conflicts.map((c) => c.planned.key));
    // In a dry run nothing exists yet; a placeholder keeps the counts honest.
    const idOf = (contributor: DemoContributor) =>
      contributorIds.get(contributor.accountNumber) ??
      (APPLY || skipped.has(contributor.accountNumber)
        ? undefined
        : `planned:${contributor.accountNumber}`);

    // Enrollments — the (contributor, program) unique key dedupes.
    const enrollments: Prisma.ProgramEnrollmentCreateManyInput[] = [];
    for (const contributor of CONTRIBUTORS) {
      const contributorId = idOf(contributor);
      if (!contributorId) continue;
      if (contributor.fundRate !== undefined) {
        enrollments.push({
          contributorId,
          programId: fund.id,
          expectedRate: money(contributor.fundRate),
          // The typed-in figure for the years before this cycle.
          previousSubscription: money(
            Math.round((contributor.fundRate * (2 + random() * 8)) / 50) * 50,
          ),
          status: contributor.dormant ? 'DORMANT' : 'ACTIVE',
        });
      }
      const mwa = programs.get(MWA);
      if (contributor.mwaRate !== undefined && mwa) {
        enrollments.push({
          contributorId,
          programId: mwa,
          expectedRate: money(contributor.mwaRate),
        });
      }
      const jamea = programs.get(JAMEA);
      if (contributor.jamea !== undefined && jamea) {
        enrollments.push({
          contributorId,
          programId: jamea,
          expectedRate: money(contributor.jamea * 12),
        });
      }
    }
    // Two campaign donors who are also members: enrolled with no pledge.
    const campaign = programs.get(CAMPAIGN);
    for (const contributor of [CONTRIBUTORS[0], CONTRIBUTORS[4]]) {
      const contributorId = idOf(contributor);
      if (campaign && contributorId) {
        enrollments.push({
          contributorId,
          programId: campaign,
          expectedRate: '0.00',
        });
      }
    }
    console.log(`Enrollments: ${enrollments.length} planned`);
    if (APPLY) {
      const { count } = await prisma.programEnrollment.createMany({
        data: enrollments,
        skipDuplicates: true,
      });
      console.log(
        `  inserted ${count}, ${enrollments.length - count} already present`,
      );
    }

    // Payments — cell keys and deterministic idempotency keys dedupe.
    const payments: Prisma.PaymentCreateManyInput[] = [];
    for (const contributor of CONTRIBUTORS) {
      const contributorId = idOf(contributor);
      if (!contributorId) continue;
      if (contributor.fundRate !== undefined) {
        payments.push(
          ...planFundCells(contributor, random).map((cell) => ({
            ...cell,
            programId: fund.id,
            contributorId,
          })),
        );
      }
      const mwa = programs.get(MWA);
      if (contributor.mwaRate !== undefined && mwa) {
        payments.push(
          ...planMwaCells(contributor.mwaRate, random).map((cell) => ({
            ...cell,
            programId: mwa,
            contributorId,
          })),
        );
      }
      const jamea = programs.get(JAMEA);
      if (contributor.jamea !== undefined && jamea) {
        for (const { year, month } of paidMonths()) {
          if (random() < 0.15) continue;
          payments.push({
            programId: jamea,
            contributorId,
            year,
            month,
            isStarred: false,
            amount: money(contributor.jamea),
          });
        }
      }
    }
    // The fund's monthly contribution to مواساة — a transfer row in its grid.
    const mwa = programs.get(MWA);
    if (mwa) {
      for (const { year, month } of paidMonths()) {
        payments.push({
          programId: mwa,
          payerProgramId: fund.id,
          year,
          month,
          isStarred: false,
          amount: money(month <= 6 ? 9000 : 5000),
        });
      }
    }
    if (campaign) {
      for (const [index, name] of ONE_OFF_DONORS.entries()) {
        const date = `2026-03-${String(1 + index * 4).padStart(2, '0')}`;
        payments.push({
          programId: campaign,
          payerNameFreetext: name,
          amount: money(500 + Math.round(random() * 40) * 250),
          year: 2026,
          paymentDate: new Date(`${date}T00:00:00.000Z`),
          idempotencyKey: `seed-demo:${CAMPAIGN}:oneoff:${index}`,
        });
      }
      payments.push({
        programId: campaign,
        payerProgramId: fund.id,
        amount: money(50000),
        year: 2026,
        paymentDate: new Date('2026-03-15T00:00:00.000Z'),
        idempotencyKey: `seed-demo:${CAMPAIGN}:fund`,
      });
      for (const contributor of [CONTRIBUTORS[0], CONTRIBUTORS[4]]) {
        const contributorId = idOf(contributor);
        if (!contributorId) continue;
        payments.push({
          programId: campaign,
          contributorId,
          amount: money(2000),
          year: 2026,
          paymentDate: new Date('2026-03-20T00:00:00.000Z'),
          idempotencyKey: `seed-demo:${CAMPAIGN}:${contributor.accountNumber}`,
        });
      }
    }
    const starred = payments.filter((p) => p.isStarred).length;
    console.log(`Payments: ${payments.length} planned (${starred} ★)`);
    if (APPLY) {
      let inserted = 0;
      for (let offset = 0; offset < payments.length; offset += BATCH) {
        const { count } = await prisma.payment.createMany({
          data: payments.slice(offset, offset + BATCH),
          skipDuplicates: true,
        });
        inserted += count;
      }
      console.log(
        `  inserted ${inserted}, ${payments.length - inserted} already present`,
      );
    }

    await flagDuplicates(prisma);
    if (!APPLY) console.log('Nothing written. Re-run with --apply to write.');
  } finally {
    await prisma.$disconnect();
  }
}

// The same rules the app's scan uses. Raises flags for a reviewer; merges nothing.
async function flagDuplicates(prisma: PrismaClient) {
  const contributors = APPLY
    ? await prisma.contributor.findMany({
        where: { isDeleted: false },
        select: { id: true, name: true, accountNumber: true },
      })
    : CONTRIBUTORS.map((p) => ({
        id: p.accountNumber,
        name: p.name,
        accountNumber: p.accountNumber,
      }));
  const pairs = findDuplicatePairs(contributors);
  console.log(
    `Possible duplicates: ${pairs.length} pairs (flagged for review, never merged)`,
  );
  for (const pair of pairs) {
    const a = contributors.find((p) => p.id === pair.contributorAId);
    const b = contributors.find((p) => p.id === pair.contributorBId);
    console.log(
      `  ${a?.accountNumber} ${a?.name}  ~  ${b?.accountNumber} ${b?.name}  [${pair.reasons.join(', ')}]`,
    );
  }
  if (APPLY && pairs.length > 0) {
    const { count } = await prisma.contributorDuplicateFlag.createMany({
      data: pairs,
      skipDuplicates: true,
    });
    console.log(`  raised ${count} new flags`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
