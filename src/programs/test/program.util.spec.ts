import { programEntryMode, thisYear, toProgramView } from '../program.util';

describe('program.util', () => {
  // Type alone decides the book: there is no third shape, so an annual
  // subscription never falls back to a ledger and open donations never get a
  // grid.
  it.each([
    ['PERIODIC', 'MONTHLY'], // the fund, مواساة
    ['TEMPORARY', 'DATED'], // a hospital case, this Ramadan's families
  ] as const)('a %s program keeps a %s book', (type, mode) => {
    expect(programEntryMode({ type })).toBe(mode);
  });

  it('spells out the entry mode in the view and carries nothing about cycles', () => {
    const view = toProgramView({
      id: 'camp',
      name: 'حملة رمضان',
      type: 'TEMPORARY',
      isProtected: false,
      sortOrder: 1,
    });
    expect(view).toEqual({
      id: 'camp',
      name: 'حملة رمضان',
      type: 'TEMPORARY',
      isProtected: false,
      sortOrder: 1,
      entryMode: 'DATED',
    });
  });

  it('opens on the UTC year, so New Year in a later zone does not move it early', () => {
    expect(thisYear(new Date('2026-12-31T23:30:00.000Z'))).toBe(2026);
    expect(thisYear(new Date('2027-01-01T00:00:00.000Z'))).toBe(2027);
  });
});
