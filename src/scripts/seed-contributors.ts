/**
 * Seeds the Contributor directory from the fund's workbook: every person on
 * the fund's revenue sheet (الايرادات) and on مواساة's (ايرادات مواساة), once
 * each. Contributors only — enrollments, pledges and payments are not
 * imported here.
 *
 *   npm run seed:contributors -- --file "../CHARITY FUND 2026-2029 (1).xlsx"           dry run
 *   npm run seed:contributors -- --file "../CHARITY FUND 2026-2029 (1).xlsx" --apply   writes
 *
 * The workbook is read where it lies and never copied into the repo: it holds
 * real names, and this repository is pushed to GitHub.
 *
 * One human, one record. People who pay into both programs appear on both
 * sheets under two account numbers: the same three-digit serial, a later join
 * date (YYMM) on مواساة, and usually a shorter name — "أحمد عبد الصمد ملهي"
 * 0808047 there, "أحمد عبدالصمد ملهي علي" 0504047 on the fund's sheet. Unlike
 * migrate:legacy-eradat, this import folds those pairs itself instead of
 * queueing them for review, because folding them was asked for explicitly.
 * It folds only on the strongest evidence the workbook offers: one row from
 * each sheet with the same first two names and the same serial (SAME_SERIAL
 * in src/contributors/contributor-duplicate.util.ts). A sheet never lists one
 * person twice, so look-alikes on the same sheet are never folded. The folded
 * record keeps the oldest account number — the earliest join date, the
 * person's first account with the fund — and the fuller of the two names.
 * Every fold is printed. Weaker look-alikes stay separate and are raised as
 * OPEN duplicate flags, as the app's scan would raise them.
 *
 * Re-runnable: a contributor already stored under the same account number and
 * name is left alone, so a second run adds nothing.
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import {
  matchContributorsByAccount,
  openDatabase,
  raiseDuplicateFlags,
} from './script.util';
import {
  FUND_SHEET,
  MWA_SHEET,
  planContributors,
  readPeople,
} from './workbook.util';

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  if (!values.file) {
    throw new Error('Usage: --file <path to the workbook .xlsx> [--apply]');
  }
  const apply = values.apply;

  console.log(`Reading ${values.file}`);
  const fundRows = await readPeople(values.file, FUND_SHEET);
  const mwaRows = await readPeople(values.file, MWA_SHEET);
  const { contributors, folds } = planContributors(fundRows, mwaRows);

  console.log(
    `People: ${fundRows.length} on ${FUND_SHEET}, ${mwaRows.length} on ${MWA_SHEET}, ${folds.length} on both`,
  );
  for (const { fund, mwa, kept } of folds) {
    console.log(
      `  ${kept.accountNumber} ${kept.name}  ←  ${FUND_SHEET} row ${fund.row} (${fund.accountNumber} ${fund.name}) + ${MWA_SHEET} row ${mwa.row} (${mwa.accountNumber} ${mwa.name})`,
    );
  }
  console.log(`Contributors: ${contributors.length} planned`);

  const { prisma, description } = openDatabase(
    process.env.DATABASE_URL,
    process.env.DATABASE_SCHEMA,
  );
  console.log(`${apply ? 'APPLYING to' : 'Dry run against'} ${description}`);
  try {
    const before = await matchContributorsByAccount(prisma, contributors);
    console.log(
      `  ${before.ids.size} already present, ${before.missing.length} to insert`,
    );
    if (apply && before.missing.length > 0) {
      const { count } = await prisma.contributor.createMany({
        data: before.missing.map(({ name, accountNumber }) => ({
          name,
          accountNumber,
        })),
        skipDuplicates: true,
      });
      console.log(`  inserted ${count}`);
    }
    // A number someone else already holds is reported, never linked: only a
    // reviewer may decide two records are one person.
    for (const { planned, existingName } of before.conflicts) {
      console.log(
        `  CONFLICT ${planned.accountNumber} is "${existingName}", not "${planned.name}" — skipped`,
      );
    }

    await raiseDuplicateFlags(prisma, { apply, planned: before.missing });
    if (!apply) console.log('Nothing written. Re-run with --apply to write.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
