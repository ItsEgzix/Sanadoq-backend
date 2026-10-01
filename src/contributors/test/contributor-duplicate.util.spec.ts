import {
  accountSerial,
  duplicateReasons,
  findDuplicatePairs,
  nameTokens,
  orderedPair,
} from '../contributor-duplicate.util';

const contributor = (id: string, name: string, accountNumber: string) => ({
  id,
  name,
  accountNumber,
});

describe('contributor-duplicate.util', () => {
  describe('nameTokens', () => {
    it('drops diacritics and punctuation, and folds alef variants', () => {
      expect(nameTokens('أم /عُلا علي')).toEqual(['ام', 'علا', 'علي']);
    });

    it('joins compound names written with or without the space', () => {
      expect(nameTokens('أحمد عبد العزيز')).toEqual(
        nameTokens('أحمد عبدالعزيز'),
      );
    });

    it('folds taa marbuta, so the two spellings the workbook uses agree', () => {
      expect(nameTokens('مواساة')).toEqual(nameTokens('مواساه'));
    });

    it('ignores tatweel and surrounding whitespace', () => {
      expect(nameTokens('  محمـــد  علي ')).toEqual(['محمد', 'علي']);
    });
  });

  describe('duplicateReasons — the workbook near-duplicates', () => {
    it('flags a shorter lineage that prefixes a longer one, with the surviving serial', () => {
      expect(
        duplicateReasons(
          contributor('a', 'أم /عُلا علي', '1101079'),
          contributor('b', 'أم /عُلا علي عبدالعزيز', '1009079'),
        ),
      ).toEqual(['NAME_EXTENDS', 'SAME_SERIAL']);
    });

    it('flags the same man across the fund and جامع السعيد sheets', () => {
      expect(
        duplicateReasons(
          contributor('a', 'عمر محمد ملهي', '2402006'),
          contributor('b', 'عمر محمد ملهي علي', '0203006'),
        ),
      ).toEqual(['NAME_EXTENDS', 'SAME_SERIAL']);
    });

    it('flags a spacing difference plus an extra ancestor even with unrelated serials', () => {
      expect(
        duplicateReasons(
          contributor('a', 'أحمد عبد العزيز عبدالوهاب', '0808035'),
          contributor('b', 'أحمد عبدالعزيز عبدالوهاب علي', '0209019'),
        ),
      ).toEqual(['NAME_EXTENDS']);
    });

    it('flags identical names with different account numbers', () => {
      expect(
        duplicateReasons(
          contributor('a', 'متعهد قيم جامع السعيد', '1304154'),
          contributor('b', 'متعهد قيم جامع السعيد', '2405154'),
        ),
      ).toEqual(['SAME_NAME', 'SAME_SERIAL']);
    });
  });

  describe('duplicateReasons — namesakes it must leave alone', () => {
    it('does not flag a two-name prefix: "محمد علي" is too common to mean anything', () => {
      expect(
        duplicateReasons(
          contributor('a', 'محمد علي', '0101001'),
          contributor('b', 'محمد علي أحمد', '0202002'),
        ),
      ).toEqual([]);
    });

    it('does not flag a mother and son who share most of a name', () => {
      expect(
        duplicateReasons(
          contributor('a', 'أم أحمد خالد عبدالعزيز', '1601100'),
          contributor('b', 'أحمد خالد عبدالعزيز عبدالوهاب', '1702119'),
        ),
      ).toEqual([]);
    });

    it('does not flag a shared serial when the names diverge', () => {
      expect(
        duplicateReasons(
          contributor('a', 'سمير محمد جازم', '0203004'),
          contributor('b', 'سلمى عبدالله', '1904004'),
        ),
      ).toEqual([]);
    });

    it('never pairs a record with itself', () => {
      const same = contributor('a', 'عمر محمد ملهي', '2402006');
      expect(duplicateReasons(same, same)).toEqual([]);
    });
  });

  describe('findDuplicatePairs', () => {
    it('finds every candidate pair, ordered, and nothing else', () => {
      const pairs = findDuplicatePairs([
        contributor('p3', 'عمر محمد ملهي علي', '0203006'),
        contributor('p1', 'عمر محمد ملهي', '2402006'),
        contributor('p2', 'سمير محمد جازم محمد', '0203004'),
        contributor('p4', 'محمد علي', '0101001'),
        contributor('p5', 'محمد علي أحمد', '0202002'),
      ]);
      expect(pairs).toEqual([
        {
          contributorAId: 'p1',
          contributorBId: 'p3',
          reasons: ['NAME_EXTENDS', 'SAME_SERIAL'],
        },
      ]);
    });

    it('skips names with no letters rather than pairing every blank', () => {
      expect(
        findDuplicatePairs([
          contributor('a', '//', '0101001'),
          contributor('b', '--', '0101002'),
        ]),
      ).toEqual([]);
    });
  });

  it('orders a pair by id so (a, b) and (b, a) are one flag', () => {
    expect(orderedPair('z', 'a')).toEqual({
      contributorAId: 'a',
      contributorBId: 'z',
    });
    expect(orderedPair('a', 'z')).toEqual({
      contributorAId: 'a',
      contributorBId: 'z',
    });
  });

  it('reads the serial from the last three digits of YYMMNNN', () => {
    expect(accountSerial('0203006')).toBe('006');
  });
});
