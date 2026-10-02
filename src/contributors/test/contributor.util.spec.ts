import { Prisma } from 'generated/prisma/client';
import { toYearActivity } from '../contributor.util';

const paid = (month: number | null, amount: number, count = 1) => ({
  month,
  isStarred: false,
  amount: new Prisma.Decimal(amount),
  count,
});
const starred = (month: number) => ({
  month,
  isStarred: true,
  amount: null,
  count: 1,
});

describe('toYearActivity', () => {
  it('shows an empty grid year as twelve empty months, not as no months', () => {
    expect(toYearActivity([], 'MONTHLY')).toEqual({
      paid: '0.00',
      payments: 0,
      months: Array(12).fill(null),
    });
  });

  // A ★ marks money recorded under another month: counting it would show
  // the same payment twice.
  it('marks a ★ month without adding it to the amount or the payment count', () => {
    const activity = toYearActivity(
      [paid(1, 100), starred(2), paid(12, 50.5)],
      'MONTHLY',
    );

    expect(activity.paid).toBe('150.50');
    expect(activity.payments).toBe(2);
    expect(activity.months?.[0]).toBe('PAID');
    expect(activity.months?.[1]).toBe('STARRED');
    expect(activity.months?.[11]).toBe('PAID'); // December
  });

  it('counts every dated entry on a ledger, which has no month cells', () => {
    expect(toYearActivity([paid(null, 450, 3)], 'DATED')).toEqual({
      paid: '450.00',
      payments: 3,
      months: null,
    });
  });
});
