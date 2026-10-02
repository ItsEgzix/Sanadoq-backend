-- ═══════════════════════════════════════════════════════════════════════════
-- Whether a program runs in cycles follows from its type.
--
-- Until now Program.hasCycles was a second switch beside type, giving four
-- shapes. The fund confirmed there are two:
--   - PERIODIC — a standing subscription (the fund's membership, مواساة). It
--     always runs in cycles: subscribers carry from one cycle into the next,
--     and the cycle is the window a yearly pledge is measured over, month by
--     month, in the grid.
--   - TEMPORARY — one need, collected once: someone in hospital, families to
--     help this Ramadan. It never has cycles; the next Ramadan is a new
--     program.
-- A periodic program without cycles looked like a campaign (a dated ledger
-- with pledges), and a temporary program with cycles only fenced its year
-- picker. Both are gone. From this change programEntryMode() and
-- runsInCycles() in src/programs/program.util.ts read type alone.
--
-- No backfill: a periodic program that ran without cycles keeps its rows and
-- simply asks for its first cycle, like any new periodic program. The guard
-- below refuses the two cases that would strand data instead. Without it, a
-- live periodic program's dated entries would sit under a grid that never
-- shows them, and a temporary program's cycles would fence writes nobody can
-- see or remove.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
    temporary_with_cycles text;
    periodic_with_dated text;
BEGIN
    -- Deleted programs too: a cycle on one would still block its restore.
    SELECT string_agg(DISTINCT p."name", ', ') INTO temporary_with_cycles
    FROM "Program" p
    JOIN "Cycle" c ON c."programId" = p."id"
    WHERE p."type" = 'TEMPORARY';

    -- Live programs only. A deleted periodic program that ran without cycles
    -- keeps its dated entries untouched; nothing reads a deleted program's
    -- books, and deleting the entries here would destroy history.
    SELECT string_agg(DISTINCT p."name", ', ') INTO periodic_with_dated
    FROM "Program" p
    JOIN "Payment" pay ON pay."programId" = p."id"
    WHERE p."type" = 'PERIODIC'
      AND NOT p."isDeleted"
      AND pay."month" IS NULL;

    IF temporary_with_cycles IS NOT NULL THEN
        RAISE EXCEPTION 'Temporary programs with cycles: %. Remove their cycles first.', temporary_with_cycles;
    END IF;
    IF periodic_with_dated IS NOT NULL THEN
        RAISE EXCEPTION 'Periodic programs with dated payments: %. Move them before cycles become mandatory.', periodic_with_dated;
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

ALTER TABLE "Program" DROP COLUMN "hasCycles";
