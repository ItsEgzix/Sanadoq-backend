/**
 * How the duplicate scan decides two Person records *might* be one human.
 * These rules only ever propose: a pair they match becomes an OPEN
 * PersonDuplicateFlag for a person to confirm or dismiss. Nothing here, or
 * anywhere else, merges on a match — the workbook has real near-duplicates
 * (same person, different account numbers in different sheets) and real
 * namesakes, and only someone who knows the fund can tell which is which.
 *
 * The rules come from the near-duplicates found in the workbook:
 *   "أم /عُلا علي" 1101079 (مواساة)     ~ "أم /عُلا علي عبدالعزيز" 1009079 (fund)
 *   "عمر محمد ملهي" 2402006 (جامع السعيد) ~ "عمر محمد ملهي علي" 0203006 (fund)
 *   "أحمد عبد العزيز عبدالوهاب" 0808035 ~ "أحمد عبدالعزيز عبدالوهاب علي"
 * — one sheet writes more of the lineage than the other, spacing and
 * diacritics differ, and the account number's join date (YYMM) changes while
 * its three-digit serial often survives.
 */

export type DuplicateReason =
  // Identical once spelling variants are folded.
  | 'SAME_NAME'
  // One name is the other with more of the lineage written out.
  | 'NAME_EXTENDS'
  // Same first two names and the same serial (the account number's last
  // three digits) under a different join date.
  | 'SAME_SERIAL';

export interface PersonKey {
  id: string;
  name: string;
  accountNumber: string;
}

export interface DuplicatePair {
  personAId: string;
  personBId: string;
  reasons: DuplicateReason[];
}

// A shared given name and father's name alone is common ("محمد علي"); with the
// grandfather's name too, a prefix match is worth a human's look.
const MIN_TOKENS_FOR_PREFIX = 3;

// Harakat, tanween, shadda, sukun, dagger alef and Quranic marks.
const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const LETTER_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[أإآٱ]/g, 'ا'],
  [/ى/g, 'ي'],
  // The workbook itself writes both مواساة and مواساه.
  [/ة/g, 'ه'],
  [/ؤ/g, 'و'],
  [/ئ/g, 'ي'],
];
// Written both joined and apart: "عبد العزيز" / "عبدالعزيز", "ابو بكر" / "ابوبكر".
const JOINING_PREFIXES: ReadonlySet<string> = new Set(['عبد', 'ابو']);

/**
 * A name as comparable tokens: Unicode-normalised, diacritics and tatweel
 * removed, letter variants folded, punctuation ("أم /عُلا") dropped, and
 * compound names joined.
 */
export function nameTokens(name: string): string[] {
  let text = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(TATWEEL, '');
  for (const [pattern, replacement] of LETTER_FOLDS) {
    text = text.replace(pattern, replacement);
  }
  const raw = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const tokens: string[] = [];
  for (let index = 0; index < raw.length; index++) {
    const token = raw[index];
    if (JOINING_PREFIXES.has(token) && index + 1 < raw.length) {
      tokens.push(token + raw[++index]);
    } else {
      tokens.push(token);
    }
  }
  return tokens;
}

/** The serial part of a YYMMNNN account number. */
export function accountSerial(accountNumber: string): string {
  return accountNumber.slice(-3);
}

/** Why two records look like one human; empty when they do not. */
export function duplicateReasons(
  a: PersonKey,
  b: PersonKey,
): DuplicateReason[] {
  return reasonsFor(
    { ...a, tokens: nameTokens(a.name) },
    { ...b, tokens: nameTokens(b.name) },
  );
}

/** a and b in the fixed order CHECK "PersonDuplicateFlag_ordered_pair" wants. */
export function orderedPair(
  firstId: string,
  secondId: string,
): { personAId: string; personBId: string } {
  return firstId < secondId
    ? { personAId: firstId, personBId: secondId }
    : { personAId: secondId, personBId: firstId };
}

/**
 * Every candidate pair among `people`. Every rule needs the first two tokens
 * to agree (a shorter name of three or more tokens that prefixes a longer one
 * shares its first two), so people are bucketed on those and compared only
 * within a bucket — near-linear for a fund's few hundred names.
 */
export function findDuplicatePairs(
  people: readonly PersonKey[],
): DuplicatePair[] {
  const buckets = new Map<string, TokenizedPerson[]>();
  for (const person of people) {
    const tokens = nameTokens(person.name);
    if (tokens.length === 0) continue;
    const key = tokens.slice(0, 2).join(' ');
    const bucket = buckets.get(key);
    const entry = { ...person, tokens };
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }

  const pairs: DuplicatePair[] = [];
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const reasons = reasonsFor(bucket[i], bucket[j]);
        if (reasons.length > 0) {
          pairs.push({
            ...orderedPair(bucket[i].id, bucket[j].id),
            reasons,
          });
        }
      }
    }
  }
  return pairs;
}

type TokenizedPerson = PersonKey & { tokens: string[] };

function reasonsFor(a: TokenizedPerson, b: TokenizedPerson): DuplicateReason[] {
  if (a.id === b.id || a.tokens.length === 0 || b.tokens.length === 0) {
    return [];
  }
  const reasons: DuplicateReason[] = [];
  const [shorter, longer] =
    a.tokens.length <= b.tokens.length
      ? [a.tokens, b.tokens]
      : [b.tokens, a.tokens];
  const isPrefix = shorter.every((token, index) => longer[index] === token);

  if (isPrefix && shorter.length === longer.length) {
    reasons.push('SAME_NAME');
  } else if (isPrefix && shorter.length >= MIN_TOKENS_FOR_PREFIX) {
    reasons.push('NAME_EXTENDS');
  }

  const sameStart =
    a.tokens.length >= 2 &&
    b.tokens.length >= 2 &&
    a.tokens[0] === b.tokens[0] &&
    a.tokens[1] === b.tokens[1];
  if (
    sameStart &&
    accountSerial(a.accountNumber) === accountSerial(b.accountNumber)
  ) {
    reasons.push('SAME_SERIAL');
  }
  return reasons;
}
