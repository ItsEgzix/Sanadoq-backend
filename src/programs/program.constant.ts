import type { Prisma } from 'generated/prisma/client';
import { CYCLE_SELECT } from 'src/cycles/cycle.constant';

// The fund, its standing programs and every campaign it has run. The cap
// keeps the sidebar list a plain array and bounds per-program fan-out.
export const PROGRAM_CAP = 100;

// The program's own columns. Hot reads load the current cycle beside these
// in a second, parallel query (ProgramService.withCurrentCycles) instead of
// nesting it: Prisma runs a nested select as a second query *after* the
// first, which costs a full round trip to a remote database.
export const PROGRAM_FIELDS_SELECT = {
  id: true,
  name: true,
  type: true,
  hasCycles: true,
  isProtected: true,
  sortOrder: true,
} satisfies Prisma.ProgramSelect;

export const PROGRAM_SELECT = {
  ...PROGRAM_FIELDS_SELECT,
  // The current cycle rides along on every program read: whether one exists
  // decides whether the program's books can open at all.
  cycles: { where: { isCurrent: true }, take: 1, select: CYCLE_SELECT },
} satisfies Prisma.ProgramSelect;

export type ProgramRow = Prisma.ProgramGetPayload<{
  select: typeof PROGRAM_SELECT;
}>;

// The fund's membership program first — it is the reason the app exists —
// then the treasurer's chosen order. `id` last so ties never reorder.
export const PROGRAM_ORDER_BY = [
  { isProtected: 'desc' },
  { sortOrder: 'asc' },
  { name: 'asc' },
  { id: 'asc' },
] satisfies Prisma.ProgramOrderByWithRelationInput[];
