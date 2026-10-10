-- ═══════════════════════════════════════════════════════════════════════════
-- A dated history for every subscription: EnrollmentTerm.
--
-- Until now a periodic enrollment held one status and one yearly pledge with
-- no dates, so the app could not say "joined in June", "frozen from May" or
-- "pledge raised from July", and once marked dormant a subscriber could never
-- come back. The fund's rules (2026-10-02) need all four:
--   - a member who joins mid-year owes from the month they joined;
--   - dormancy is usually set from the start of the year, but can start in
--     any month, and the months after it drop out of العجز;
--   - a dormant member can be reactivated, counting either the whole year
--     (returnees usually settle it) or only from the month they returned;
--   - a pledge can change mid-year once the year so far is paid at the old
--     rate.
-- Each change is a term: from (fromYear, fromMonth) on, this status at this
-- pledge. ProgramEnrollment keeps status and expectedRate as the mirror of the
-- latest term, which the API never lets start after the current month, so
-- lists, filters and counts keep reading one row.
--
-- Backfill: every enrollment in a periodic program gets the terms that give
-- exactly today's figures. Temporary programs' donor rows get none — they
-- carry no pledge and owe nothing.
--   1. An ACTIVE term at the pledge it has now, from the month the
--      contributor joined: the YYMM of their account number (رقم الحساب,
--      YYMMNNN), the only record of a start month there is. A month outside
--      1..12 falls back to January; a date after this month is pulled back to
--      it, since no term may start later.
--   2. A dormant enrollment also gets a DORMANT term from January 2026, the
--      first year these books hold — or, if it joined after that, is DORMANT
--      from the start.
-- Every imported account number predates February 2026, so no month of 2026
-- drops out of anyone's العجز and no figure on screen moves. Without the
-- backfill, every existing subscriber would read as never having joined and
-- would owe nothing.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "EnrollmentTerm" (
    "id"           TEXT               NOT NULL,
    "enrollmentId" TEXT               NOT NULL,
    "fromYear"     INTEGER            NOT NULL,
    "fromMonth"    INTEGER            NOT NULL,
    "status"       "EnrollmentStatus" NOT NULL,
    "expectedRate" DECIMAL(14, 2)     NOT NULL,
    "recordedById" TEXT,
    "createdAt"    TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3)       NOT NULL,

    CONSTRAINT "EnrollmentTerm_pkey" PRIMARY KEY ("id"),
    -- The same range as a payment's year, so every month that can hold money
    -- can also start a term.
    CONSTRAINT "EnrollmentTerm_from_year_range" CHECK ("fromYear" BETWEEN 2000 AND 2100),
    CONSTRAINT "EnrollmentTerm_from_month_range" CHECK ("fromMonth" BETWEEN 1 AND 12),
    CONSTRAINT "EnrollmentTerm_expected_rate_non_negative" CHECK ("expectedRate" >= 0)
);

-- One term per month, and enrollmentId's FK index.
CREATE UNIQUE INDEX "EnrollmentTerm_enrollmentId_fromYear_fromMonth_key"
    ON "EnrollmentTerm"("enrollmentId", "fromYear", "fromMonth");
CREATE INDEX "EnrollmentTerm_recordedById_idx" ON "EnrollmentTerm"("recordedById");

ALTER TABLE "EnrollmentTerm" ADD CONSTRAINT "EnrollmentTerm_enrollmentId_fkey"
    FOREIGN KEY ("enrollmentId") REFERENCES "ProgramEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EnrollmentTerm" ADD CONSTRAINT "EnrollmentTerm_recordedById_fkey"
    FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Backfill ───────────────────────────────────────────────────────────────

-- Months are counted as year * 12 + (month - 1), so "earlier" is a plain
-- comparison. Deleted programs too, so restoring one brings its history back.
WITH joined AS (
    SELECT
        e."id",
        e."status",
        e."expectedRate",
        GREATEST(
            2000 * 12,
            LEAST(
                (2000 + substr(c."accountNumber", 1, 2)::INTEGER) * 12
                    + CASE WHEN substr(c."accountNumber", 3, 2)::INTEGER BETWEEN 1 AND 12
                           THEN substr(c."accountNumber", 3, 2)::INTEGER - 1
                           ELSE 0 END,
                (EXTRACT(YEAR FROM now())::INTEGER) * 12 + EXTRACT(MONTH FROM now())::INTEGER - 1
            )
        ) AS "joinedAt"
    FROM "ProgramEnrollment" e
    JOIN "Program" p ON p."id" = e."programId"
    JOIN "Contributor" c ON c."id" = e."contributorId"
    WHERE p."type" = 'PERIODIC'
),
-- 2026 * 12 is January 2026 as a month count.
terms AS (
    -- 1. The joining term. A dormant enrollment that joined in or after
    --    January 2026 is dormant from its first month.
    SELECT "id", "joinedAt" AS "fromAt",
           CASE WHEN "status" = 'DORMANT' AND "joinedAt" >= 2026 * 12
                THEN 'DORMANT'::"EnrollmentStatus"
                ELSE 'ACTIVE'::"EnrollmentStatus" END AS "status",
           "expectedRate"
    FROM joined
    UNION ALL
    -- 2. Dormant from January 2026, after an active stretch before it.
    SELECT "id", 2026 * 12, 'DORMANT'::"EnrollmentStatus", "expectedRate"
    FROM joined
    WHERE "status" = 'DORMANT' AND "joinedAt" < 2026 * 12
)
INSERT INTO "EnrollmentTerm" ("id", "enrollmentId", "fromYear", "fromMonth", "status", "expectedRate", "updatedAt")
SELECT gen_random_uuid()::TEXT, "id", "fromAt" / 12, "fromAt" % 12 + 1, "status", "expectedRate", now()
FROM terms;
