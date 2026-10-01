import type { CycleRow } from './cycle.constant';

export interface CycleRange {
  startYear: number;
  endYear: number;
}

/** Last year of a cycle — inclusive, so a 4-year cycle from 2026 ends in 2029. */
export function cycleEndYear(startYear: number, lengthYears: number): number {
  return startYear + lengthYears - 1;
}

/** Every year of the cycle in order, e.g. [2026, 2027, 2028, 2029]. */
export function cycleYears({ startYear, endYear }: CycleRange): number[] {
  return Array.from(
    { length: endYear - startYear + 1 },
    (_, index) => startYear + index,
  );
}

export function isYearInCycle(cycle: CycleRange, year: number): boolean {
  return year >= cycle.startYear && year <= cycle.endYear;
}

/**
 * The nearest cycle year to `year`. Picks the grid's default tab: a cycle
 * that has not started yet opens on its first year, a finished one on its last.
 */
export function clampYearToCycle(cycle: CycleRange, year: number): number {
  return Math.min(Math.max(year, cycle.startYear), cycle.endYear);
}

/** A cycle as the API returns it, with its years spelled out for the year tabs. */
export function toCycleView(cycle: CycleRow) {
  return { ...cycle, years: cycleYears(cycle) };
}

export type CycleView = ReturnType<typeof toCycleView>;
