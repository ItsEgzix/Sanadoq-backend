import type { ProgramType } from '../../generated/prisma/client';
import type { ProgramRow } from './program.constant';

/**
 * How a program's payments are written down:
 *   MONTHLY — a grid of (payer, year, month) cells with ★ for "paid under
 *             another month", like the workbook's subscription sheets;
 *   DATED   — a ledger of dated entries, any number per payer.
 *
 * A PERIODIC program — an annual subscription its members renew — keeps the
 * grid: a yearly pledge is measured month by month. A TEMPORARY program —
 * open donations, from anyone — keeps a ledger: a gift has a date, not a
 * month it was owed for. The fund confirmed there is no third shape, so this
 * reads type alone.
 */
export type EntryMode = 'MONTHLY' | 'DATED';

export function programEntryMode(program: { type: ProgramType }): EntryMode {
  return program.type === 'PERIODIC' ? 'MONTHLY' : 'DATED';
}

/** A program as the API returns it, its entry mode spelled out for clients. */
export function toProgramView(program: ProgramRow) {
  return { ...program, entryMode: programEntryMode(program) };
}

export type ProgramView = ReturnType<typeof toProgramView>;

/** The calendar year a book opens on when none is asked for. */
export function thisYear(now = new Date()): number {
  // UTC: the fund keeps no time zone, and the difference is a few hours on
  // New Year's Eve.
  return now.getUTCFullYear();
}
