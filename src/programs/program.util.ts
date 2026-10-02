import type { ProgramType } from '../../generated/prisma/client';
import { toCycleView } from '../cycles/cycle.util';
import type { ProgramRow } from './program.constant';

/**
 * How a program's payments are written down:
 *   MONTHLY — a grid of (payer, year, month) cells with ★ for "paid under
 *             another month", like the workbook's subscription sheets;
 *   DATED   — a ledger of dated entries, any number per payer.
 *
 * A PERIODIC program keeps the grid: a pledge measured month by month needs a
 * recurring rhythm and the cycle to measure it over. A TEMPORARY program keeps
 * a ledger — a gift has a date, not a month it was owed for.
 */
export type EntryMode = 'MONTHLY' | 'DATED';

/**
 * Whether a program keeps Cycle rows. Not a setting: a periodic program always
 * runs in cycles, and its subscribers carry from one into the next; a
 * temporary one is a single need, collected once, and never has a cycle — the
 * next Ramadan's drive is a new program. The fund confirmed there is no third
 * shape, so this reads type alone.
 */
export function runsInCycles(program: { type: ProgramType }): boolean {
  return program.type === 'PERIODIC';
}

export function programEntryMode(program: { type: ProgramType }): EntryMode {
  return runsInCycles(program) ? 'MONTHLY' : 'DATED';
}

/**
 * A program as the API returns it: whether it runs in cycles, its entry mode
 * and its current cycle spelled out, so no client re-derives them from type.
 */
export function toProgramView({ cycles, ...program }: ProgramRow) {
  const current = cycles[0];
  return {
    ...program,
    hasCycles: runsInCycles(program),
    entryMode: programEntryMode(program),
    currentCycle: current ? toCycleView(current) : null,
  };
}

export type ProgramView = ReturnType<typeof toProgramView>;
