-- ═══════════════════════════════════════════════════════════════════════════
-- Program baseline.
--
-- Replaces the Member-centric baseline (20261001120000_eradat_baseline),
-- which was never applied to any shared environment and is deleted rather
-- than migrated forward. Its demo rows were synthetic (src/scripts/
-- seed-demo.ts); a local database that still holds them is converted, if at
-- all, by src/scripts/migrate-legacy-eradat.ts — on purpose not by this
-- file, which must never merge or invent people on its own.
--
-- The new shape: one Person per human, any number of Programs (the fund's
-- membership is just the protected one), a ProgramEnrollment per person per
-- program carrying that program's pledge, and Payments that a Person, a
-- free-text donor or another Program made to a Program.
--
-- Beyond what schema.prisma can say, this adds the constraints that keep the
-- books honest:
--   - a payment has exactly one payer, and a person payer is enrolled in the
--     receiving program (composite FK);
--   - a starred payment carries no amount, so SUM(amount) can never count it;
--   - a payment is a monthly cell or a dated entry, never both or neither;
--   - a program's cycles never overlap, and at most one is current;
--   - exactly one program is protected, and it can never lose that status,
--     change its type or cycle mode, or be deleted — even from a SQL console.
-- Seeds: the FUND_MANAGER role and the protected fund membership program.
-- ═══════════════════════════════════════════════════════════════════════════

-- The per-program cycle exclusion compares text ids with "=" inside a GiST
-- index, which needs btree_gist's operator classes. Pinned to public so a
-- deploy into another schema (an isolated test schema) reuses the one install.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- ── Enums ──────────────────────────────────────────────────────────────────

CREATE TYPE "DuplicateFlagStatus" AS ENUM ('OPEN', 'MERGED', 'DISMISSED');

CREATE TYPE "ProgramType" AS ENUM ('PERIODIC', 'TEMPORARY');

CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'DORMANT');

-- ── Role / User ────────────────────────────────────────────────────────────

CREATE TABLE "Role" (
    "key"         TEXT         NOT NULL,
    "name"        TEXT         NOT NULL,
    "permissions" TEXT[],
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "User" (
    "id"           TEXT         NOT NULL,
    "email"        TEXT         NOT NULL,
    "name"         TEXT         NOT NULL,
    "passwordHash" TEXT         NOT NULL,
    "roleKey"      TEXT         NOT NULL DEFAULT 'FUND_MANAGER',
    "isActive"     BOOLEAN      NOT NULL DEFAULT true,
    "tokenVersion" INTEGER      NOT NULL DEFAULT 0,
    "lastLoginAt"  TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id"),
    -- Login lowercases before looking up; a mixed-case row would be a second
    -- account nobody can sign in to.
    CONSTRAINT "User_email_lowercase" CHECK ("email" = lower("email"))
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_roleKey_idx" ON "User"("roleKey");

-- ── Person ─────────────────────────────────────────────────────────────────

CREATE TABLE "Person" (
    "id"            TEXT         NOT NULL,
    "name"          TEXT         NOT NULL,
    "accountNumber" TEXT         NOT NULL,
    "phone"         TEXT,
    "email"         TEXT,
    "mergedIntoId"  TEXT,
    "isDeleted"     BOOLEAN      NOT NULL DEFAULT false,
    "deletedAt"     TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Person_name_not_blank" CHECK (length(btrim("name")) > 0),
    -- The workbook's YYMMNNN form. Mirrors PERSON_ACCOUNT_NUMBER_PATTERN in
    -- src/people/person.constant.ts, which rejects earlier with a readable
    -- message; this is the backstop.
    CONSTRAINT "Person_account_number_digits" CHECK ("accountNumber" ~ '^[0-9]{7}$'),
    -- A merged record is retired: it must not reappear in any live list.
    CONSTRAINT "Person_merged_is_deleted" CHECK ("mergedIntoId" IS NULL OR "isDeleted"),
    CONSTRAINT "Person_not_merged_into_self" CHECK ("mergedIntoId" IS NULL OR "mergedIntoId" <> "id")
);

-- Spans deleted and merged rows on purpose: a retired number is never reissued.
CREATE UNIQUE INDEX "Person_accountNumber_key" ON "Person"("accountNumber");
CREATE INDEX "Person_mergedIntoId_idx" ON "Person"("mergedIntoId");

ALTER TABLE "Person" ADD CONSTRAINT "Person_mergedIntoId_fkey"
    FOREIGN KEY ("mergedIntoId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── PersonDuplicateFlag ────────────────────────────────────────────────────

CREATE TABLE "PersonDuplicateFlag" (
    "id"           TEXT                  NOT NULL,
    "personAId"    TEXT                  NOT NULL,
    "personBId"    TEXT                  NOT NULL,
    "reasons"      TEXT[],
    "status"       "DuplicateFlagStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt"   TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3)          NOT NULL,

    CONSTRAINT "PersonDuplicateFlag_pkey" PRIMARY KEY ("id"),
    -- A fixed order makes (a, b) and (b, a) one row under the unique index, so
    -- a rescan can never raise the same pair twice — or re-raise a dismissed one.
    CONSTRAINT "PersonDuplicateFlag_ordered_pair" CHECK ("personAId" < "personBId"),
    -- Resolved exactly when it is no longer open. resolvedById is not part of
    -- this: it is nulled if the reviewer's account is ever removed.
    CONSTRAINT "PersonDuplicateFlag_resolution_matches_status" CHECK (("status" = 'OPEN') = ("resolvedAt" IS NULL))
);

CREATE UNIQUE INDEX "PersonDuplicateFlag_personAId_personBId_key" ON "PersonDuplicateFlag"("personAId", "personBId");
CREATE INDEX "PersonDuplicateFlag_personBId_idx" ON "PersonDuplicateFlag"("personBId");
CREATE INDEX "PersonDuplicateFlag_status_createdAt_idx" ON "PersonDuplicateFlag"("status", "createdAt");

ALTER TABLE "PersonDuplicateFlag" ADD CONSTRAINT "PersonDuplicateFlag_personAId_fkey"
    FOREIGN KEY ("personAId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonDuplicateFlag" ADD CONSTRAINT "PersonDuplicateFlag_personBId_fkey"
    FOREIGN KEY ("personBId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonDuplicateFlag" ADD CONSTRAINT "PersonDuplicateFlag_resolvedById_fkey"
    FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Program ────────────────────────────────────────────────────────────────

CREATE TABLE "Program" (
    "id"          TEXT          NOT NULL,
    "name"        TEXT          NOT NULL,
    "type"        "ProgramType" NOT NULL,
    "hasCycles"   BOOLEAN       NOT NULL,
    "isProtected" BOOLEAN       NOT NULL DEFAULT false,
    "sortOrder"   INTEGER       NOT NULL DEFAULT 0,
    "isDeleted"   BOOLEAN       NOT NULL DEFAULT false,
    "deletedAt"   TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "Program_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Program_name_not_blank" CHECK (length(btrim("name")) > 0),
    -- Soft delete is still delete: the protected program can never be hidden.
    CONSTRAINT "Program_protected_is_live" CHECK (NOT ("isProtected" AND "isDeleted"))
);

CREATE INDEX "Program_sortOrder_idx" ON "Program"("sortOrder");

-- Two live programs both called "مواساة" would make every picker ambiguous.
-- Deleted programs free their name.
CREATE UNIQUE INDEX "Program_live_name_key" ON "Program"(lower(btrim("name"))) WHERE NOT "isDeleted";

-- Protection belongs to the fund's membership program alone.
CREATE UNIQUE INDEX "Program_single_protected" ON "Program"("isProtected") WHERE "isProtected";

-- The backstop for ProgramService's protection rules, for writes that never
-- pass through it (a SQL console, a future script). A protected program
-- keeps its protection, type and cycle mode, and cannot be deleted; and
-- protection is only ever granted at creation, never by an UPDATE.
CREATE FUNCTION "Program_guard_protected"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."isProtected" THEN
            RAISE EXCEPTION 'Program % is protected and cannot be deleted.', OLD."id"
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD."isProtected" AND (
        NOT NEW."isProtected"
        OR NEW."type" IS DISTINCT FROM OLD."type"
        OR NEW."hasCycles" IS DISTINCT FROM OLD."hasCycles"
    ) THEN
        RAISE EXCEPTION 'Program % is protected: its protection, type and cycle mode cannot change.', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW."isProtected" AND NOT OLD."isProtected" THEN
        RAISE EXCEPTION 'Program % cannot become protected after creation.', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "Program_guard_protected"
    BEFORE UPDATE OR DELETE ON "Program"
    FOR EACH ROW EXECUTE FUNCTION "Program_guard_protected"();

-- ── Cycle ──────────────────────────────────────────────────────────────────

CREATE TABLE "Cycle" (
    "id"          TEXT         NOT NULL,
    "programId"   TEXT         NOT NULL,
    "startYear"   INTEGER      NOT NULL,
    "lengthYears" INTEGER      NOT NULL,
    "endYear"     INTEGER      NOT NULL,
    "isCurrent"   BOOLEAN      NOT NULL DEFAULT false,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cycle_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Cycle_start_year_range" CHECK ("startYear" BETWEEN 2000 AND 2100),
    CONSTRAINT "Cycle_length_range" CHECK ("lengthYears" BETWEEN 1 AND 10),
    -- endYear is stored for SQL range filters; this keeps it from drifting
    -- when lengthYears is edited.
    CONSTRAINT "Cycle_end_matches_length" CHECK ("endYear" = "startYear" + "lengthYears" - 1)
);

CREATE UNIQUE INDEX "Cycle_programId_startYear_key" ON "Cycle"("programId", "startYear");

-- Partial unique: any number of past cycles per program, at most one current.
CREATE UNIQUE INDEX "Cycle_single_current_per_program" ON "Cycle"("programId") WHERE "isCurrent";

-- Two cycles of one program claiming the same year would give "which cycle
-- is 2027 in" two answers. Different programs may overlap freely.
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_no_overlap_per_program"
    EXCLUDE USING gist ("programId" WITH =, int4range("startYear", "endYear", '[]') WITH &&);

ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_programId_fkey"
    FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── ProgramEnrollment ──────────────────────────────────────────────────────

CREATE TABLE "ProgramEnrollment" (
    "id"                   TEXT               NOT NULL,
    "personId"             TEXT               NOT NULL,
    "programId"            TEXT               NOT NULL,
    "expectedRate"         DECIMAL(14, 2)     NOT NULL,
    "previousSubscription" DECIMAL(14, 2)     NOT NULL DEFAULT 0,
    "status"               "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt"            TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3)       NOT NULL,

    CONSTRAINT "ProgramEnrollment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProgramEnrollment_expected_rate_non_negative" CHECK ("expectedRate" >= 0),
    CONSTRAINT "ProgramEnrollment_previous_subscription_non_negative" CHECK ("previousSubscription" >= 0)
);

-- Also the target of Payment's composite FK below.
CREATE UNIQUE INDEX "ProgramEnrollment_personId_programId_key" ON "ProgramEnrollment"("personId", "programId");
CREATE INDEX "ProgramEnrollment_programId_status_idx" ON "ProgramEnrollment"("programId", "status");

ALTER TABLE "ProgramEnrollment" ADD CONSTRAINT "ProgramEnrollment_personId_fkey"
    FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProgramEnrollment" ADD CONSTRAINT "ProgramEnrollment_programId_fkey"
    FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Payment ────────────────────────────────────────────────────────────────

CREATE TABLE "Payment" (
    "id"                TEXT           NOT NULL,
    "programId"         TEXT           NOT NULL,
    "personId"          TEXT,
    "payerNameFreetext" TEXT,
    "payerProgramId"    TEXT,
    "amount"            DECIMAL(14, 2),
    "isStarred"         BOOLEAN        NOT NULL DEFAULT false,
    "year"              INTEGER        NOT NULL,
    "month"             INTEGER,
    "paymentDate"       DATE,
    "idempotencyKey"    TEXT,
    "recordedById"      TEXT,
    "createdAt"         TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3)   NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id"),

    -- Who paid: exactly one of a registered person, a stranger's name, or
    -- another program. Never zero (money from nowhere), never two (which one
    -- would the books credit?).
    CONSTRAINT "Payment_exactly_one_payer" CHECK (num_nonnulls("personId", "payerNameFreetext", "payerProgramId") = 1),
    CONSTRAINT "Payment_freetext_not_blank" CHECK ("payerNameFreetext" IS NULL OR length(btrim("payerNameFreetext")) > 0),
    -- A program paying itself would book its own money as new revenue.
    CONSTRAINT "Payment_not_self_transfer" CHECK ("payerProgramId" IS NULL OR "payerProgramId" <> "programId"),

    -- The rule every total depends on: a star is "paid elsewhere", never
    -- money. With amount forced NULL on starred rows, SUM(amount) skips stars
    -- by itself. A zero amount is refused too — an empty cell is the zero.
    CONSTRAINT "Payment_amount_matches_star" CHECK (
        ("isStarred" AND "amount" IS NULL)
        OR (NOT "isStarred" AND "amount" IS NOT NULL AND "amount" > 0)
    ),

    -- When: a monthly cell or a dated entry, never both and never neither.
    CONSTRAINT "Payment_month_or_date" CHECK (("month" IS NULL) <> ("paymentDate" IS NULL)),
    CONSTRAINT "Payment_month_range" CHECK ("month" IS NULL OR "month" BETWEEN 1 AND 12),
    CONSTRAINT "Payment_year_range" CHECK ("year" BETWEEN 2000 AND 2100),
    -- year is what every total groups on; for a dated entry it must be the
    -- date's year or the entry would be counted in the wrong year.
    CONSTRAINT "Payment_year_matches_date" CHECK ("paymentDate" IS NULL OR "year" = EXTRACT(YEAR FROM "paymentDate")::INTEGER),
    -- "Recorded under a different month" only means something on a monthly grid.
    CONSTRAINT "Payment_star_is_monthly" CHECK (NOT "isStarred" OR "month" IS NOT NULL),
    -- A stranger has no row in a monthly grid; their gift is a dated entry.
    CONSTRAINT "Payment_freetext_is_dated" CHECK ("payerNameFreetext" IS NULL OR "month" IS NULL)
);

CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- One monthly cell per payer per program per month. NULLs are distinct in a
-- Postgres unique index, so dated entries (month NULL) and rows of the other
-- payer kind never collide here.
CREATE UNIQUE INDEX "Payment_programId_personId_year_month_key" ON "Payment"("programId", "personId", "year", "month");
CREATE UNIQUE INDEX "Payment_programId_payerProgramId_year_month_key" ON "Payment"("programId", "payerProgramId", "year", "month");

CREATE INDEX "Payment_programId_year_idx" ON "Payment"("programId", "year");
CREATE INDEX "Payment_personId_idx" ON "Payment"("personId");
CREATE INDEX "Payment_payerProgramId_year_idx" ON "Payment"("payerProgramId", "year");
CREATE INDEX "Payment_recordedById_idx" ON "Payment"("recordedById");

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_programId_fkey"
    FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_personId_fkey"
    FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_payerProgramId_fkey"
    FOREIGN KEY ("payerProgramId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A person payer must be enrolled in the receiving program. MATCH SIMPLE (the
-- default) skips the check when personId is NULL, i.e. for the other payer
-- kinds. ON UPDATE CASCADE lets a duplicate merge re-point an enrollment to
-- the surviving person and move its payments in the same statement.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_personId_programId_fkey"
    FOREIGN KEY ("personId", "programId") REFERENCES "ProgramEnrollment"("personId", "programId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_recordedById_fkey"
    FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Seeds ──────────────────────────────────────────────────────────────────

-- The only role today. Keep "FUND_MANAGER" in step with DEFAULT_ROLE_KEY in
-- src/auth/auth.constant.ts and the User.roleKey default above.
INSERT INTO "Role" ("key", "name", "permissions", "updatedAt")
VALUES ('FUND_MANAGER', 'Fund manager', ARRAY['MANAGE_FUND'], CURRENT_TIMESTAMP);

-- The fund's membership program, protected from birth. Its name is editable
-- in the app; its type, cycle mode and existence are not. It starts with no
-- cycle: the treasurer configures the current one (2026–2029 in the
-- workbook) like any other program's.
INSERT INTO "Program" ("id", "name", "type", "hasCycles", "isProtected", "sortOrder", "updatedAt")
VALUES (gen_random_uuid()::TEXT, 'اشتراكات الصندوق', 'PERIODIC', true, true, 0, CURRENT_TIMESTAMP);
