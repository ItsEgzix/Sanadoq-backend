-- ═══════════════════════════════════════════════════════════════════════════
-- Person → Contributor.
--
-- "Person" named the record after nothing it does. A record here is anyone
-- who puts money into a program: a member of the fund, a donor to a campaign
-- who is no member at all, or both at once. Member and donor are roles, read
-- off a contributor's enrollments, so the record is named for what every one
-- of them has in common.
--
-- Renames only — every row, value, CHECK and foreign key survives as it is.
-- Postgres rewrites the column names inside CHECK expressions and index
-- definitions itself; no function or trigger body names these columns, so
-- nothing else needs touching. Each index and constraint gets the name
-- Prisma would generate for the renamed model, so a later
-- `prisma migrate diff` against schema.prisma stays empty.
--
-- Without this, the renamed Prisma client queries tables and columns that do
-- not exist and every contributor, enrollment and payment read fails.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Contributor (was Person) ───────────────────────────────────────────────

ALTER TABLE "Person" RENAME TO "Contributor";

ALTER TABLE "Contributor" RENAME CONSTRAINT "Person_pkey" TO "Contributor_pkey";
ALTER TABLE "Contributor" RENAME CONSTRAINT "Person_name_not_blank" TO "Contributor_name_not_blank";
ALTER TABLE "Contributor" RENAME CONSTRAINT "Person_account_number_digits" TO "Contributor_account_number_digits";
ALTER TABLE "Contributor" RENAME CONSTRAINT "Person_merged_is_deleted" TO "Contributor_merged_is_deleted";
ALTER TABLE "Contributor" RENAME CONSTRAINT "Person_not_merged_into_self" TO "Contributor_not_merged_into_self";
ALTER TABLE "Contributor" RENAME CONSTRAINT "Person_mergedIntoId_fkey" TO "Contributor_mergedIntoId_fkey";

ALTER INDEX "Person_accountNumber_key" RENAME TO "Contributor_accountNumber_key";
ALTER INDEX "Person_mergedIntoId_idx" RENAME TO "Contributor_mergedIntoId_idx";

-- ── ContributorDuplicateFlag (was PersonDuplicateFlag) ─────────────────────

ALTER TABLE "PersonDuplicateFlag" RENAME TO "ContributorDuplicateFlag";

ALTER TABLE "ContributorDuplicateFlag" RENAME COLUMN "personAId" TO "contributorAId";
ALTER TABLE "ContributorDuplicateFlag" RENAME COLUMN "personBId" TO "contributorBId";

ALTER TABLE "ContributorDuplicateFlag" RENAME CONSTRAINT "PersonDuplicateFlag_pkey" TO "ContributorDuplicateFlag_pkey";
ALTER TABLE "ContributorDuplicateFlag" RENAME CONSTRAINT "PersonDuplicateFlag_ordered_pair" TO "ContributorDuplicateFlag_ordered_pair";
ALTER TABLE "ContributorDuplicateFlag" RENAME CONSTRAINT "PersonDuplicateFlag_resolution_matches_status" TO "ContributorDuplicateFlag_resolution_matches_status";
ALTER TABLE "ContributorDuplicateFlag" RENAME CONSTRAINT "PersonDuplicateFlag_personAId_fkey" TO "ContributorDuplicateFlag_contributorAId_fkey";
ALTER TABLE "ContributorDuplicateFlag" RENAME CONSTRAINT "PersonDuplicateFlag_personBId_fkey" TO "ContributorDuplicateFlag_contributorBId_fkey";
ALTER TABLE "ContributorDuplicateFlag" RENAME CONSTRAINT "PersonDuplicateFlag_resolvedById_fkey" TO "ContributorDuplicateFlag_resolvedById_fkey";

ALTER INDEX "PersonDuplicateFlag_personAId_personBId_key" RENAME TO "ContributorDuplicateFlag_contributorAId_contributorBId_key";
ALTER INDEX "PersonDuplicateFlag_personBId_idx" RENAME TO "ContributorDuplicateFlag_contributorBId_idx";
ALTER INDEX "PersonDuplicateFlag_status_createdAt_idx" RENAME TO "ContributorDuplicateFlag_status_createdAt_idx";

-- ── ProgramEnrollment ──────────────────────────────────────────────────────

ALTER TABLE "ProgramEnrollment" RENAME COLUMN "personId" TO "contributorId";

ALTER TABLE "ProgramEnrollment" RENAME CONSTRAINT "ProgramEnrollment_personId_fkey" TO "ProgramEnrollment_contributorId_fkey";

-- Still the target of Payment's composite FK; renaming keeps that link.
ALTER INDEX "ProgramEnrollment_personId_programId_key" RENAME TO "ProgramEnrollment_contributorId_programId_key";

-- ── Payment ────────────────────────────────────────────────────────────────

-- "Payment_exactly_one_payer" names this column in its expression; Postgres
-- follows the rename, so the one-payer rule holds throughout.
ALTER TABLE "Payment" RENAME COLUMN "personId" TO "contributorId";

ALTER TABLE "Payment" RENAME CONSTRAINT "Payment_personId_fkey" TO "Payment_contributorId_fkey";
ALTER TABLE "Payment" RENAME CONSTRAINT "Payment_personId_programId_fkey" TO "Payment_contributorId_programId_fkey";

ALTER INDEX "Payment_programId_personId_year_month_key" RENAME TO "Payment_programId_contributorId_year_month_key";
ALTER INDEX "Payment_personId_idx" RENAME TO "Payment_contributorId_idx";

-- ── NOT NULL constraints ───────────────────────────────────────────────────

-- Postgres 18 also stores every NOT NULL as a named constraint, named after
-- the table and column when the table was created — so these still say
-- Person (Neon runs 18). Before 18 they are not constraints at all and this
-- loop finds nothing, so the file runs on either.
DO $$
DECLARE
    c record;
BEGIN
    FOR c IN
        SELECT con.conrelid::regclass AS tbl, con.conname
          FROM pg_constraint con
          JOIN pg_namespace n ON n.oid = con.connamespace
         WHERE con.contype = 'n'
           AND n.nspname = current_schema()
           AND (con.conname LIKE 'Person%' OR con.conname LIKE 'ProgramEnrollment\_person%')
    LOOP
        EXECUTE format(
            'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
            c.tbl,
            c.conname,
            replace(replace(c.conname, 'Person', 'Contributor'), 'person', 'contributor')
        );
    END LOOP;
END $$;
