-- ═══════════════════════════════════════════════════════════════════════════
-- Expenses (المصروفات): what a program pays out.
--
-- Until now the app held only revenue, so no program's books balanced, and a
-- payment one program made to another was visible only as the receiver's
-- revenue. The workbook keeps each program's spending as a monthly grid —
-- one row per beneficiary or purpose (a family supported each month, the
-- mosque caretaker's wage, one hospital case), grouped under headings — and
-- this mirrors it:
--   - ExpenseLine is a row: a name and an optional heading (category);
--   - Expense is a cell: one line's payout in one month.
-- A program → program payment stays a single Payment row; the paying
-- program's expense sheet reads that row too instead of booking a copy.
--
-- New tables only; nothing to backfill. Expense carries its program beside
-- its line so totals group on (programId, year) without a join, and a
-- composite foreign key keeps the two from ever disagreeing.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "ExpenseLine" (
    "id"        TEXT         NOT NULL,
    "programId" TEXT         NOT NULL,
    "name"      TEXT         NOT NULL,
    "category"  TEXT,
    "sortOrder" INTEGER      NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExpenseLine_name_not_blank" CHECK (length(btrim("name")) > 0),
    -- No heading is NULL, never an empty string, so grouping sees one
    -- "ungrouped" bucket instead of two.
    CONSTRAINT "ExpenseLine_category_not_blank" CHECK ("category" IS NULL OR length(btrim("category")) > 0)
);

-- The target of Expense's composite FK below.
CREATE UNIQUE INDEX "ExpenseLine_id_programId_key" ON "ExpenseLine"("id", "programId");
CREATE INDEX "ExpenseLine_programId_sortOrder_idx" ON "ExpenseLine"("programId", "sortOrder");

ALTER TABLE "ExpenseLine" ADD CONSTRAINT "ExpenseLine_programId_fkey"
    FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Expense" (
    "id"           TEXT           NOT NULL,
    "programId"    TEXT           NOT NULL,
    "lineId"       TEXT           NOT NULL,
    "year"         INTEGER        NOT NULL,
    "month"        INTEGER        NOT NULL,
    "amount"       DECIMAL(14, 2) NOT NULL,
    "recordedById" TEXT,
    "createdAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3)   NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id"),
    -- The same range as a payment, so both sides of the books cover the same
    -- years.
    CONSTRAINT "Expense_year_range" CHECK ("year" BETWEEN 2000 AND 2100),
    CONSTRAINT "Expense_month_range" CHECK ("month" BETWEEN 1 AND 12),
    -- An empty cell is the zero; a stored 0 would read as "paid out".
    CONSTRAINT "Expense_amount_positive" CHECK ("amount" > 0)
);

-- One cell per line per month: saving it twice rewrites it.
CREATE UNIQUE INDEX "Expense_lineId_year_month_key" ON "Expense"("lineId", "year", "month");
CREATE INDEX "Expense_programId_year_idx" ON "Expense"("programId", "year");
CREATE INDEX "Expense_recordedById_idx" ON "Expense"("recordedById");

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_programId_fkey"
    FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A cell's program is its line's program. Without it a cell could be filed
-- under one program's totals while its line sits on another's sheet.
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_lineId_programId_fkey"
    FOREIGN KEY ("lineId", "programId") REFERENCES "ExpenseLine"("id", "programId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_recordedById_fkey"
    FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
