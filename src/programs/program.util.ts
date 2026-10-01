import type { ProgramType } from 'generated/prisma/client';
import { toCycleView } from 'src/cycles/cycle.util';
import type { ProgramRow } from './program.constant';

/**
 * How a program's payments are written down:
 *   MONTHLY — a grid of (payer, year, month) cells with ★ for "paid under
 *             another month", like the workbook's subscription sheets;
 *   DATED   — a ledger of dated entries, any number per payer.
 *
 * Only a PERIODIC program with cycles keeps the grid: a pledge measured month
 * by month needs both a recurring rhythm and a window to measure it over.
 * Campaigns, and standing programs that flow without cycles, keep a ledger.
 */
export type EntryMode = 'MONTHLY' | 'DATED';

export function programEntryMode(program: {
  type: ProgramType;
  hasCycles: boolean;
}): EntryMode {
  return program.type === 'PERIODIC' && program.hasCycles ? 'MONTHLY' : 'DATED';
}

/** A program as the API returns it: its entry mode and current cycle spelled out. */
export function toProgramView({ cycles, ...program }: ProgramRow) {
  const current = cycles[0];
  return {
    ...program,
    entryMode: programEntryMode(program),
    currentCycle: current ? toCycleView(current) : null,
  };
}

export type ProgramView = ReturnType<typeof toProgramView>;
