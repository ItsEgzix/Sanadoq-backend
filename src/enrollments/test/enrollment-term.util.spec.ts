import { Prisma } from '../../../generated/prisma/client';
import {
  joinedFromAccountNumber,
  owedFor,
  placeChange,
  sameTerms,
  termsByMonth,
  termsOrFallback,
  type TermRow,
} from '../enrollment-term.util';

const d = (value: string | number) => new Prisma.Decimal(value);

const term = (
  fromYear: number,
  fromMonth: number,
  status: TermRow['status'],
  rate: number,
): TermRow => ({ fromYear, fromMonth, status, expectedRate: d(rate) });

describe('enrollment-term.util', () => {
  describe('termsByMonth', () => {
    it('carries a term from an earlier year into every month of this one', () => {
      const months = termsByMonth([term(2008, 3, 'ACTIVE', 6000)], 2026);
      expect(months.every((m) => m?.expectedRate.equals(6000))).toBe(true);
    });

    it('leaves the months before the first term empty — not yet joined', () => {
      const months = termsByMonth([term(2026, 6, 'ACTIVE', 12000)], 2026);
      expect(months.slice(0, 5)).toEqual([null, null, null, null, null]);
      expect(months[5]?.status).toBe('ACTIVE'); // June
    });

    it('switches at the month each later term starts', () => {
      const months = termsByMonth(
        [term(2020, 1, 'ACTIVE', 6000), term(2026, 5, 'DORMANT', 6000)],
        2026,
      );
      expect(months[3]?.status).toBe('ACTIVE'); // April
      expect(months[4]?.status).toBe('DORMANT'); // May
    });
  });

  describe('owedFor', () => {
    it('is the pledge ÷ 12 for each month due — 9,000 of 12,000 through September', () => {
      expect(
        owedFor([term(2020, 1, 'ACTIVE', 12000)], 2026, 9).toFixed(2),
      ).toBe('9000.00');
    });

    it("owes a mid-year joiner from the month they joined (the fund's rule)", () => {
      // Joined in June: June to September is 4 months of 12,000.
      expect(
        owedFor([term(2026, 6, 'ACTIVE', 12000)], 2026, 9).toFixed(2),
      ).toBe('4000.00');
    });

    it('stops counting from the month a dormancy starts, and keeps the months before it owed', () => {
      const terms = [
        term(2020, 1, 'ACTIVE', 12000),
        term(2026, 5, 'DORMANT', 12000),
      ];
      expect(owedFor(terms, 2026, 9).toFixed(2)).toBe('4000.00'); // January–April
    });

    it('owes nothing for a year a member was dormant from its start', () => {
      const terms = [
        term(2002, 3, 'ACTIVE', 6000),
        term(2026, 1, 'DORMANT', 6000),
      ];
      expect(owedFor(terms, 2026, 12).toFixed(2)).toBe('0.00');
    });

    it('counts each month at the pledge in effect then — 6,000 to 12,000 from July', () => {
      const terms = [
        term(2020, 1, 'ACTIVE', 6000),
        term(2026, 7, 'ACTIVE', 12000),
      ];
      // 6 months at 500 and 6 at 1,000.
      expect(owedFor(terms, 2026, 12).toFixed(2)).toBe('9000.00');
    });

    it('owes the whole year again once reactivated from January', () => {
      const terms = [
        term(2020, 1, 'ACTIVE', 6000),
        term(2024, 1, 'DORMANT', 6000),
        term(2026, 1, 'ACTIVE', 6000),
      ];
      expect(owedFor(terms, 2026, 12).toFixed(2)).toBe('6000.00');
      expect(owedFor(terms, 2025, 12).toFixed(2)).toBe('0.00');
    });

    it('rounds once, at the end, to the money scale', () => {
      // 1,000 ÷ 12 = 83.333…
      expect(owedFor([term(2020, 1, 'ACTIVE', 1000)], 2026, 1).toFixed(2)).toBe(
        '83.33',
      );
    });

    it('owes nothing while no month is due, and never more than twelve', () => {
      const terms = [term(2020, 1, 'ACTIVE', 12000)];
      expect(owedFor(terms, 2026, 0).toFixed(2)).toBe('0.00');
      expect(owedFor(terms, 2026, 13).toFixed(2)).toBe('12000.00');
    });
  });

  describe('placeChange', () => {
    const oct10 = new Date('2026-10-10T12:00:00.000Z');
    const latest = term(2026, 3, 'ACTIVE', 6000);

    it('appends a change after the latest term', () => {
      expect(placeChange(latest, { year: 2026, month: 5 }, oct10)).toBe(
        'APPEND',
      );
    });

    it('replaces the latest term when the change starts in its month', () => {
      expect(placeChange(latest, { year: 2026, month: 3 }, oct10)).toBe(
        'REPLACE',
      );
    });

    it('refuses a change earlier than the latest term, which keeps the latest one in effect today', () => {
      expect(placeChange(latest, { year: 2026, month: 2 }, oct10)).toBe(
        'BEFORE',
      );
    });

    it('refuses a change after this month — next January is made in January', () => {
      expect(placeChange(latest, { year: 2026, month: 11 }, oct10)).toBe(
        'FUTURE',
      );
      expect(placeChange(null, { year: 2027, month: 1 }, oct10)).toBe('FUTURE');
      expect(placeChange(latest, { year: 2026, month: 10 }, oct10)).toBe(
        'APPEND',
      );
    });
  });

  describe('joinedFromAccountNumber', () => {
    const oct10 = new Date('2026-10-10T12:00:00.000Z');

    it('reads YYMM off the account number', () => {
      expect(joinedFromAccountNumber('0203010', oct10)).toEqual({
        year: 2002,
        month: 3,
      });
      expect(joinedFromAccountNumber('2601186', oct10)).toEqual({
        year: 2026,
        month: 1,
      });
    });

    it('falls back to January for a month outside 1..12', () => {
      expect(joinedFromAccountNumber('0813001', oct10)).toEqual({
        year: 2008,
        month: 1,
      });
    });

    it('pulls a date after this month back to it, since no term may start later', () => {
      expect(joinedFromAccountNumber('2612001', oct10)).toEqual({
        year: 2026,
        month: 10,
      });
    });
  });

  describe('termsOrFallback', () => {
    it('reads an enrollment without terms as always at what it holds now', () => {
      const [only] = termsOrFallback(
        { status: 'ACTIVE', expectedRate: d(6000) },
        [],
      );
      expect(only).toMatchObject({
        fromYear: 2000,
        fromMonth: 1,
        status: 'ACTIVE',
      });
      expect(owedFor([only], 2026, 12).toFixed(2)).toBe('6000.00');
    });

    it('keeps the terms an enrollment has', () => {
      const terms = [term(2026, 6, 'ACTIVE', 12000)];
      expect(
        termsOrFallback({ status: 'ACTIVE', expectedRate: d(1) }, terms),
      ).toBe(terms);
    });
  });

  it('sameTerms compares status and pledge, not dates', () => {
    expect(
      sameTerms(term(2020, 1, 'ACTIVE', 6000), term(2026, 3, 'ACTIVE', 6000)),
    ).toBe(true);
    expect(
      sameTerms(term(2020, 1, 'ACTIVE', 6000), term(2026, 3, 'DORMANT', 6000)),
    ).toBe(false);
  });
});
