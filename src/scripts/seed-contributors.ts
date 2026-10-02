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
import { readSheet } from 'read-excel-file/node';
import {
  duplicateReasons,
  nameTokens,
} from 'src/contributors/contributor-duplicate.util';
import { CONTRIBUTOR_ACCOUNT_NUMBER_PATTERN } from 'src/contributors/contributor.constant';
import {
  matchContributorsByAccount,
  openDatabase,
  raiseDuplicateFlags,
  type PlannedContributor,
} from './script.util';

const FUND_SHEET = 'الايرادات';
const MWA_SHEET = 'ايرادات مواساة';
// Columns B and C on both sheets. The header check in readPeople() stops a
// reshaped sheet from being read with names in the wrong column.
const NAME_COLUMN = 1;
const ACCOUNT_COLUMN = 2;
const ACCOUNT_HEADER = 'رقم الحساب';
const NAME_HEADER = 'الإسم';
const TATWEEL = /ـ/g;

// Rows on the fund's sheet that are revenue streams, not people. They hold a
// number in the account column, but in this system they are programs: مواساة
// already is one, and the campaigns will be.
const NOT_CONTRIBUTORS: ReadonlyMap<string, string> = new Map([
  ['0080865', 'مشروع مواساة'],
  ['0101281', 'حملات تبرعات و صدقات سر'],
]);

interface SheetRow {
  sheet: string;
  // The sheet's own row number, so every printed line can be found in Excel.
  row: number;
  name: string;
  accountNumber: string;
}

interface Fold {
  fund: SheetRow;
  mwa: SheetRow;
  kept: PlannedContributor;
}

function cellText(value: unknown): string {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ');
  if (typeof value === 'number') return String(value);
  return '';
}

// Some account cells are numbers, not text, and a number cell drops the
// leading zero: 0203002 would read as 203002.
function accountText(value: unknown): string {
  if (typeof value === 'number')
    return String(Math.trunc(value)).padStart(7, '0');
  return cellText(value);
}

async function readPeople(file: string, sheet: string): Promise<SheetRow[]> {
  const data = await readSheet(file, sheet);
  const headerIndex = data.findIndex((cells) =>
    cellText(cells[ACCOUNT_COLUMN]).startsWith(ACCOUNT_HEADER),
  );
  const nameHeader =
    headerIndex < 0
      ? ''
      : cellText(data[headerIndex][NAME_COLUMN]).replace(TATWEEL, '');
  if (nameHeader !== NAME_HEADER) {
    throw new Error(
      `${sheet}: expected "${NAME_HEADER}" in column B and "${ACCOUNT_HEADER}" in column C of one header row — has the sheet been reshaped?`,
    );
  }

  const people: SheetRow[] = [];
  for (let index = headerIndex + 1; index < data.length; index++) {
    const row = index + 1;
    const name = cellText(data[index][NAME_COLUMN]);
    if (!name) continue;
    const accountNumber = accountText(data[index][ACCOUNT_COLUMN]);
    if (!accountNumber) {
      console.log(
        `  ${sheet} row ${row} "${name}": no account number, skipped`,
      );
      continue;
    }
    if (NOT_CONTRIBUTORS.has(accountNumber)) {
      console.log(
        `  ${sheet} row ${row} "${name}": a program, not a person, skipped`,
      );
      continue;
    }
    // A malformed number stops the run rather than being skipped: it is a
    // person the fund expects to find, and the CHECK would reject it anyway.
    if (!CONTRIBUTOR_ACCOUNT_NUMBER_PATTERN.test(accountNumber)) {
      throw new Error(
        `${sheet} row ${row} "${name}": account number "${accountNumber}" is not YYMMNNN.`,
      );
    }
    people.push({ sheet, row, name, accountNumber });
  }
  return people;
}

// YYMM compares correctly as text because every join date is 20YY — the
// oldest in the workbook is 0203, March 2002.
function joinDate(row: SheetRow): string {
  return row.accountNumber.slice(0, 4);
}

function toPlanned({ name, accountNumber }: SheetRow): PlannedContributor {
  return { key: accountNumber, name, accountNumber };
}

function foldPair(fund: SheetRow, mwa: SheetRow): PlannedContributor {
  const [older, newer] =
    joinDate(fund) <= joinDate(mwa) ? [fund, mwa] : [mwa, fund];
  // The fuller name, since it says more about who this is. On a tie the older
  // account's spelling wins.
  const name =
    nameTokens(newer.name).length > nameTokens(older.name).length
      ? newer.name
      : older.name;
  return { key: older.accountNumber, name, accountNumber: older.accountNumber };
}

function planContributors(
  fundRows: readonly SheetRow[],
  mwaRows: readonly SheetRow[],
): { contributors: PlannedContributor[]; folds: Fold[] } {
  const asKey = (r: SheetRow) => ({
    id: `${r.sheet}:${r.row}`,
    name: r.name,
    accountNumber: r.accountNumber,
  });
  const twinOf = new Map<SheetRow, SheetRow>();
  const mwaOnly: SheetRow[] = [];
  for (const mwa of mwaRows) {
    const twins = fundRows.filter((fund) =>
      duplicateReasons(asKey(fund), asKey(mwa)).includes('SAME_SERIAL'),
    );
    // Serials are unique within each sheet, so a second twin means the
    // workbook changed shape; folding by guess would merge two people.
    if (twins.length > 1 || (twins.length === 1 && twinOf.has(twins[0]))) {
      throw new Error(
        `${MWA_SHEET} row ${mwa.row} "${mwa.name}" matches more than one person — fold by hand.`,
      );
    }
    if (twins.length === 1) twinOf.set(twins[0], mwa);
    else mwaOnly.push(mwa);
  }

  const folds: Fold[] = [];
  const contributors = fundRows.map((fund) => {
    const mwa = twinOf.get(fund);
    if (!mwa) return toPlanned(fund);
    const kept = foldPair(fund, mwa);
    folds.push({ fund, mwa, kept });
    return kept;
  });
  contributors.push(...mwaOnly.map(toPlanned));

  // createMany's skipDuplicates would silently drop the second holder of a
  // number, so two people sharing one is an error here, not a skipped row.
  const seen = new Map<string, string>();
  for (const { accountNumber, name } of contributors) {
    const other = seen.get(accountNumber);
    if (other !== undefined) {
      throw new Error(
        `Account number ${accountNumber} belongs to both "${other}" and "${name}" — fix the workbook first.`,
      );
    }
    seen.set(accountNumber, name);
  }
  contributors.sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
  return { contributors, folds };
}

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
