import { programEntryMode, runsInCycles, toProgramView } from '../program.util';

describe('program.util', () => {
  // Type alone decides both: there is no third shape, so a periodic program
  // never falls back to a ledger and a temporary one never gets a cycle.
  it.each([
    ['PERIODIC', true, 'MONTHLY'], // the fund, مواساة
    ['TEMPORARY', false, 'DATED'], // a hospital case, this Ramadan's families
  ] as const)(
    'a %s program runs in cycles: %s, and keeps a %s book',
    (type, cycles, mode) => {
      expect(runsInCycles({ type })).toBe(cycles);
      expect(programEntryMode({ type })).toBe(mode);
    },
  );

  it('derives hasCycles in the view from type, so clients never send or store it', () => {
    const view = toProgramView({
      id: 'camp',
      name: 'حملة رمضان',
      type: 'TEMPORARY',
      isProtected: false,
      sortOrder: 1,
      cycles: [],
    });
    expect(view).toMatchObject({ hasCycles: false, entryMode: 'DATED' });
  });

  it('spells out the current cycle with its years, or null when there is none', () => {
    const base = {
      id: 'p',
      name: 'x',
      type: 'PERIODIC' as const,
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
