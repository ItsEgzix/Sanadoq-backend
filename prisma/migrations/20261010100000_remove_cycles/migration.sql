-- ═══════════════════════════════════════════════════════════════════════════
-- No more cycles.
--
-- Until now a program's books opened on a Cycle (2026–2029, say): its years
-- were the only ones a payment could be written into and the only ones a
-- running total covered, and Program.hasCycles chose whether a program had
-- cycles at all. The fund has dropped the idea (2026-10-10): every year
-- stands on its own, any year can be written — the fund opens the next year
-- when it comes and goes back to fix old ones — and reports pick a year, or a
-- range of them. Two kinds of program remain, told apart by type alone:
--   - PERIODIC — an annual subscription its members renew (the fund's
--     membership, مواساة): a monthly grid with a yearly pledge per member;
--   - TEMPORARY — open donations from anyone, inside the fund or not (a
--     hospital case, this Ramadan's families): a dated ledger of gifts.
--
-- Replaces 20261002150000_cycles_follow_program_type, which made every
-- periodic program run in cycles. It was never applied to a shared database
-- and was deleted rather than migrated forward.
--
-- Nothing is backfilled and no money moves: payments and enrollments were
-- never tied to a cycle — a payment is filed by year — so dropping the Cycle
-- rows loses only the year ranges themselves. Without this, the API would
-- still refuse writes outside a cycle and a new periodic program would have
-- no books until someone made one.
--
-- btree_gist, installed by the baseline only for the cycle overlap
-- exclusion, stays installed: it is shared by every schema of the database
-- (see the baseline), and an unused extension costs nothing.
-- ═══════════════════════════════════════════════════════════════════════════

-- A live periodic program keeps a monthly grid, which never shows a dated
-- entry. Before this change a periodic program without cycles kept a dated
-- ledger; one still holding such entries would lose them from sight. Deleted
-- programs are left alone: nothing reads a deleted program's books, and
-- converting their entries here would rewrite history.
DO $$
DECLARE
    periodic_with_dated text;
BEGIN
    SELECT string_agg(DISTINCT p."name", ', ') INTO periodic_with_dated
    FROM "Program" p
    JOIN "Payment" pay ON pay."programId" = p."id"
    WHERE p."type" = 'PERIODIC'
      AND NOT p."isDeleted"
      AND pay."month" IS NULL;

    IF periodic_with_dated IS NOT NULL THEN
        RAISE EXCEPTION 'Periodic programs with dated payments: %. Move them into the monthly grid first.', periodic_with_dated;
    END IF;
END;
$$;

-- The protection trigger compared hasCycles; it must stop naming the column
-- before the column goes, or every UPDATE of a program would fail inside it.
CREATE OR REPLACE FUNCTION "Program_guard_protected"() RETURNS trigger
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
    ) THEN
        RAISE EXCEPTION 'Program % is protected: its protection and type cannot change.', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW."isProtected" AND NOT OLD."isProtected" THEN
        RAISE EXCEPTION 'Program % cannot become protected after creation.', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

-- Its indexes, the overlap exclusion and the foreign key go with it.
DROP TABLE "Cycle";

ALTER TABLE "Program" DROP COLUMN "hasCycles";
