import { isoDateSchema, toIsoDate } from '../date.schema';

describe('isoDateSchema', () => {
  it('parses a calendar date to midnight UTC, whatever the server’s zone', () => {
    const date = isoDateSchema.parse('2026-03-01');
    expect(date.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(toIsoDate(date)).toBe('2026-03-01');
  });

  it('rejects a day the month does not have instead of rolling into the next month', () => {
    expect(isoDateSchema.safeParse('2026-02-30').success).toBe(false); // would be 2 March
    expect(isoDateSchema.safeParse('2026-13-01').success).toBe(false);
  });

  it('accepts 29 February only in a leap year', () => {
    expect(isoDateSchema.safeParse('2028-02-29').success).toBe(true);
    expect(isoDateSchema.safeParse('2026-02-29').success).toBe(false);
  });

  it('rejects anything but YYYY-MM-DD', () => {
    expect(isoDateSchema.safeParse('01/03/2026').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-03-01T10:00').success).toBe(false);
  });
});
