-- ═══════════════════════════════════════════════════════════════════════════
-- Temporary programs take gifts, not subscriptions.
--
-- Until now every contributor paying any program had to be enrolled in it
-- first, with a yearly pledge (معدل الاشتراك) and a previous subscription
-- (الاشتراك السابق). Those two figures exist for PERIODIC programs only: how
-- much a subscriber owes each year, and what they paid before this system
-- held their books. A TEMPORARY program — a campaign — has donors who just
-- give. From this change:
--   - nobody is enrolled in a temporary program by hand
--     (ENROLLMENT_PROGRAM_TEMPORARY);
--   - a contributor's first gift adds a pledge-free donor row, which Payment's
--     composite FK still needs, and removing their last gift removes it
--     (EnrollmentService.addDonor / removeDonorIfEmpty).
--
-- Data only; no table, column or constraint changes. The backfill brings
-- existing rows to what the API now writes:
--   1. an enrollment in a temporary program with no payments is deleted — it
--      was made by hand before anyone gave, and a donor row exists only
--      beside a gift;
--   2. the rest keep their payments and lose their pledge, previous
--      subscription and any dormancy — there is no subscription to pause.
-- Without it a campaign goes on listing a "subscriber" who never gave, and a
-- pledge nobody can see or edit any more stays summed into its expected
-- total.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Hand-made enrollments with nothing given. Deleted programs too: restoring
--    one must not bring them back. NOT EXISTS mirrors the composite FK, so the
--    delete can never be refused by it.
DELETE FROM "ProgramEnrollment" e
USING "Program" p
WHERE p."id" = e."programId"
  AND p."type" = 'TEMPORARY'
  AND NOT EXISTS (
    SELECT 1 FROM "Payment" pay
    WHERE pay."programId" = e."programId"
      AND pay."contributorId" = e."contributorId"
  );

-- 2. Donor rows that already have gifts: keep the row, drop the figures.
UPDATE "ProgramEnrollment" e
SET "expectedRate" = 0,
    "previousSubscription" = 0,
    "status" = 'ACTIVE',
    "updatedAt" = now()
FROM "Program" p
WHERE p."id" = e."programId"
  AND p."type" = 'TEMPORARY'
  AND (e."expectedRate" <> 0
       OR e."previousSubscription" <> 0
       OR e."status" <> 'ACTIVE');
