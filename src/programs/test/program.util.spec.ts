import { programEntryMode, toProgramView } from '../program.util';

describe('program.util', () => {
  it.each([
    ['PERIODIC', true, 'MONTHLY'], // the fund, مواساة
    ['PERIODIC', false, 'DATED'], // continuous flow, no cycle boundary
    ['TEMPORARY', true, 'DATED'], // a campaign with its own window
    ['TEMPORARY', false, 'DATED'], // a one-off campaign
  ] as const)(
    'a %s program with hasCycles=%s keeps a %s book',
    (type, hasCycles, mode) => {
      expect(programEntryMode({ type, hasCycles })).toBe(mode);
    },
  );

  it('spells out the current cycle with its years, or null when there is none', () => {
    const base = {
      id: 'p',
      name: 'x',
      type: 'PERIODIC' as const,
      hasCycles: true,
      isProtected: false,
      sortOrder: 0,
    };
    expect(toProgramView({ ...base, cycles: [] }).currentCycle).toBeNull();
    expect(
      toProgramView({
        ...base,
        cycles: [
          {
            id: 'c',
            programId: 'p',
            startYear: 2026,
            lengthYears: 4,
            endYear: 2029,
            isCurrent: true,
          },
        ],
      }).currentCycle?.years,
    ).toEqual([2026, 2027, 2028, 2029]);
  });
});
