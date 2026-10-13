-- ═══════════════════════════════════════════════════════════════════════════
-- User.roleKey → Role: the foreign key schema.prisma has always declared.
--
-- The baseline created User.roleKey and its index but never the constraint,
-- so the database accepted a user whose role row does not exist, and a role
-- still assigned to someone could be deleted from under them. CI's drift
-- check (prisma migrate diff against schema.prisma) found the gap on
-- 2026-10-13; without this migration that check fails on every pull request.
--
-- Nothing to backfill: every account holds FUND_MANAGER, the one Role row the
-- baseline seeds. Guarded anyway, so a database where that is not true stops
-- here with a reason instead of a bare foreign-key error.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "User" u
        LEFT JOIN "Role" r ON r."key" = u."roleKey"
        WHERE r."key" IS NULL
    ) THEN
        RAISE EXCEPTION 'Some User rows point at a Role that does not exist; fix their roleKey before adding User_roleKey_fkey.';
    END IF;
END $$;

-- Restrict, as schema.prisma says: a role still assigned to someone cannot
-- disappear. Cascade on update so renaming a role key follows its users.
ALTER TABLE "User" ADD CONSTRAINT "User_roleKey_fkey"
    FOREIGN KEY ("roleKey") REFERENCES "Role"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
