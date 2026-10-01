import type { Prisma } from 'generated/prisma/client';

// Mirrors CHECK "Cycle_length_range" in the baseline migration; the DTO
// rejects early with a readable message, the CHECK is the backstop.
export const CYCLE_MAX_LENGTH_YEARS = 10;

export const CYCLE_MIN_START_YEAR = 2000;
export const CYCLE_MAX_START_YEAR = 2100;

// Cycles are multi-year, so this cap is centuries of one program's history;
// the list endpoint returns a plain array rather than a cursor page.
export const CYCLE_LIST_CAP = 50;

export const CYCLE_SELECT = {
  id: true,
  programId: true,
  startYear: true,
  lengthYears: true,
  endYear: true,
  isCurrent: true,
} satisfies Prisma.CycleSelect;

export type CycleRow = Prisma.CycleGetPayload<{ select: typeof CYCLE_SELECT }>;
