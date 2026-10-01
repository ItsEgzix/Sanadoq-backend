import {
  clampYearToCycle,
  cycleEndYear,
  cycleYears,
  isYearInCycle,
} from '../cycle.util';

describe('cycle.util', () => {
  it('computes an inclusive end year for any configured length', () => {
    expect(cycleEndYear(2026, 4)).toBe(2029);
    expect(cycleEndYear(2019, 5)).toBe(2023);
    expect(cycleEndYear(2030, 3)).toBe(2032);
    expect(cycleEndYear(2028, 1)).toBe(2028); // a 1-year cycle starts and ends in the same year
  });

  it('lists every year of the cycle in order', () => {
    expect(cycleYears({ startYear: 2026, endYear: 2029 })).toEqual([
      2026, 2027, 2028, 2029,
    ]);
  });

  it('treats both ends as inside the cycle', () => {
    const cycle = { startYear: 2026, endYear: 2029 };
    expect(isYearInCycle(cycle, 2026)).toBe(true);
    expect(isYearInCycle(cycle, 2029)).toBe(true);
    expect(isYearInCycle(cycle, 2030)).toBe(false);
    expect(isYearInCycle(cycle, 2025)).toBe(false);
  });

  it('clamps a default year into the cycle', () => {
    const cycle = { startYear: 2026, endYear: 2029 };
    expect(clampYearToCycle(cycle, 2027)).toBe(2027);
    expect(clampYearToCycle(cycle, 2031)).toBe(2029);
    expect(clampYearToCycle(cycle, 2020)).toBe(2026);
  });
});
