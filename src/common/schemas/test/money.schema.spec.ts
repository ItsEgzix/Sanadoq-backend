import { moneySchema, positiveMoneySchema } from '../money.schema';

describe('moneySchema', () => {
  it('accepts numeric strings and JSON numbers, always yielding a string', () => {
    expect(moneySchema.parse('1200.10')).toBe('1200.10');
    expect(moneySchema.parse(150)).toBe('150');
    expect(moneySchema.parse(99.5)).toBe('99.5');
  });

  it('accepts the largest value Decimal(14, 2) holds', () => {
    expect(moneySchema.parse('999999999999.99')).toBe('999999999999.99'); // 12 integer digits
  });

  it('rejects values the column would round or overflow', () => {
    expect(moneySchema.safeParse('1.234').success).toBe(false); // 3 decimals
    expect(moneySchema.safeParse('1000000000000').success).toBe(false); // 13 integer digits
    expect(moneySchema.safeParse(1e21).success).toBe(false); // stringifies as 1e+21
  });

  it('rejects negatives and non-numbers', () => {
    expect(moneySchema.safeParse(-1).success).toBe(false);
    expect(moneySchema.safeParse('-1').success).toBe(false);
    expect(moneySchema.safeParse('abc').success).toBe(false);
  });
});

describe('positiveMoneySchema', () => {
  it('rejects zero — an empty cell is the zero, not a stored 0.00', () => {
    expect(positiveMoneySchema.safeParse('0').success).toBe(false);
    expect(positiveMoneySchema.safeParse('0.00').success).toBe(false);
    expect(positiveMoneySchema.parse('0.01')).toBe('0.01');
  });
});
