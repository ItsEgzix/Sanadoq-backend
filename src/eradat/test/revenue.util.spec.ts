import { Prisma } from '../../../generated/prisma/client';
import type { PaymentCellRow } from '../../payments/payment.constant';
import {
  arrears,
  buildGridLine,
  buildLedgerLine,
  collectionRatio,
  monthRow,
  monthsDue,
  runningTotal,
  yearlyTotal,
} from '../revenue.util';

const d = (value: string | number) => new Prisma.Decimal(value);

const amount = (
  year: number,
  month: number,
  value: string,
): PaymentCellRow => ({
  year,
  month,
  isStarred: false,
  amount: d(value),
});
const star = (year: number, month: number): PaymentCellRow => ({
  year,
  month,
  isStarred: true,
  amount: null,
});

describe('revenue.util', () => {
  describe('yearlyTotal', () => {
    it('sums only the given year and lets stars contribute nothing', () => {
      const cells = [
        amount(2026, 1, '100.25'),
        star(2026, 2),
        amount(2026, 3, '300'),
        amount(2025, 12, '999'),
      ];
      expect(yearlyTotal(cells, 2026).toFixed(2)).toBe('400.25');
    });

    it('ignores a star that somehow carries an amount, so a dropped DB CHECK cannot double-count a lump', () => {
      const corrupted: PaymentCellRow = { ...star(2026, 4), amount: d(500) };
      expect(
        yearlyTotal([amount(2026, 3, '1500'), corrupted], 2026).toFixed(2),
      ).toBe('1500.00');
    });

    it('keeps cents exact where JS numbers would drift', () => {
      const cells = Array.from({ length: 10 }, (_, i) =>
        amount(2026, i + 1, '0.10'),
      );
      expect(yearlyTotal(cells, 2026).toFixed(2)).toBe('1.00'); // 0.1 × 10 is 0.9999… as floats
    });
  });

  describe('runningTotal', () => {
    it('adds the typed-in previous subscription to every window year', () => {
      expect(
        runningTotal(d(1000), [d(0), d(100), d('300.50'), d(0)]).toFixed(2),
      ).toBe('1400.50');
    });
  });

  describe('collectionRatio', () => {
    it('divides expected by pledge-backed actual, as the spec defines it', () => {
      expect(collectionRatio(d(1200), d(300))?.toFixed(4)).toBe('4.0000');
    });

    it('returns null when nothing pledged was collected, instead of dividing by zero', () => {
      expect(collectionRatio(d(1200), d(0))).toBeNull();
    });
  });

  describe('monthRow', () => {
    it('places each cell in its month slot and leaves the rest empty', () => {
      const row = monthRow(
        [amount(2026, 3, '1'), star(2026, 12), amount(2025, 3, '9')],
        2026,
      );
      expect(row).toHaveLength(12);
      expect(row[2]?.month).toBe(3);
      expect(row[11]?.isStarred).toBe(true);
      expect(row.filter(Boolean)).toHaveLength(2);
    });
  });

  describe('buildGridLine', () => {
    it('returns the year, per-year and running totals as fixed-scale strings, with stars null-valued', () => {
      const line = buildGridLine(
        [star(2026, 1), amount(2026, 3, '300.5'), amount(2027, 12, '100')],
        [2026, 2027, 2028, 2029],
        2026,
        d(1000),
      );
      expect(line.yearTotal).toBe('300.50');
      expect(line.runningTotal).toBe('1400.50');
      expect(line.yearTotals).toEqual([
        { year: 2026, total: '300.50' },
        { year: 2027, total: '100.00' },
        { year: 2028, total: '0.00' },
        { year: 2029, total: '0.00' },
      ]);
      expect(line.months[0]).toEqual({
        year: 2026,
        month: 1,
        isStarred: true,
        amount: null,
      });
      expect(line.months[1]).toBeNull();
    });
  });

  describe('buildLedgerLine', () => {
    it('totals per-year SQL sums with no month cells, zero for a year with nothing', () => {
      const line = buildLedgerLine(
        new Map([[2025, d(250)]]),
        [2025, 2026],
        2026,
        d(100),
      );
      expect(line).toEqual({
        months: null,
        yearTotal: '0.00',
        yearTotals: [
          { year: 2025, total: '250.00' },
          { year: 2026, total: '0.00' },
        ],
        runningTotal: '350.00',
      });
    });

    it('treats a contributor with no payments at all as zero', () => {
      expect(buildLedgerLine(undefined, [2026], 2026, d(0)).runningTotal).toBe(
        '0.00',
      );
    });
  });

  describe('monthsDue', () => {
    const oct2 = new Date('2026-10-02T09:00:00.000Z');

    it.each([
      [2025, 12], // a past year is owed in full
      [2026, 9], // the current year through the last month that ended
      [2027, 0], // nothing of a future year is owed
    ])('on 2 October 2026, %i has %i months due', (year, due) => {
      expect(monthsDue(year, oct2)).toBe(due);
    });

    it('owes nothing of the current year in January — no month has ended yet', () => {
      expect(monthsDue(2026, new Date('2026-01-31T23:59:59.000Z'))).toBe(0);
    });

    it('counts a month once it is over, from the first moment of the next', () => {
      expect(monthsDue(2026, new Date('2026-03-01T00:00:00.000Z'))).toBe(2);
      expect(monthsDue(2026, new Date('2026-02-28T23:59:59.000Z'))).toBe(1);
    });
  });

  describe('arrears', () => {
    it('is the pledge share for the months due, less what was paid in the year', () => {
      // 12,000 a year, 9 months due → 9,000 owed; 6,000 paid.
      expect(arrears(d(12000), 9, d(6000)).toFixed(2)).toBe('3000.00');
    });

    it('is zero when paid up, and never negative when paid ahead', () => {
      expect(arrears(d(12000), 9, d(9000)).toFixed(2)).toBe('0.00');
      expect(arrears(d(12000), 9, d(12000)).toFixed(2)).toBe('0.00');
    });

    it('rounds the share to the money scale before comparing', () => {
      // 1,000 × 1 ÷ 12 = 83.333… → 83.33 owed.
      expect(arrears(d(1000), 1, d(0)).toFixed(2)).toBe('83.33');
      expect(arrears(d(1000), 1, d('83.33')).toFixed(2)).toBe('0.00');
    });

    it('owes nothing while no month is due, however little was paid', () => {
      expect(arrears(d(12000), 0, d(0)).toFixed(2)).toBe('0.00');
    });
  });
});
