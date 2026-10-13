import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ar from '../ar/events.json';
import en from '../en/events.json';

/**
 * Every code the API can answer with has a message in every language the
 * fund reads. The filter and interceptor fall back to English, then to the
 * bare code, so a missing key never crashes — it shows a manager the wrong
 * language or a SCREAMING_SNAKE string instead, which no other test notices.
 */

const LOCALES: Record<string, Record<string, string>> = { en, ar };
const SRC = join(__dirname, '..', '..');

const placeholders = (message: string) =>
  [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'test' || name === 'scripts' ? [] : sourceFiles(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

// Literal codes only: the three ways a code leaves a service. A code built at
// runtime cannot be checked here and should not exist.
const CODE_SITES = [
  /new AppException\(\s*'([A-Z][A-Z0-9_]+)'/g,
  /successCode:\s*'([A-Z][A-Z0-9_]+)'/g,
  /assertNoBlockers\(\s*'([A-Z][A-Z0-9_]+)'/g,
];

describe('events.json', () => {
  it('has the same keys in every locale', () => {
    const keys = Object.keys(en).sort();
    for (const [locale, messages] of Object.entries(LOCALES)) {
      expect({ locale, keys: Object.keys(messages).sort() }).toEqual({
        locale,
        keys,
      });
    }
  });

  it('uses the same {placeholders} for a code in every locale', () => {
    for (const [code, message] of Object.entries(en)) {
      for (const [locale, messages] of Object.entries(LOCALES)) {
        expect({
          code,
          locale,
          placeholders: placeholders(messages[code]),
        }).toEqual({
          code,
          locale,
          placeholders: placeholders(message),
        });
      }
    }
  });

  it('has a message for every code the source throws or returns', () => {
    const used = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of CODE_SITES) {
        for (const match of text.matchAll(pattern)) used.add(match[1]);
      }
    }
    // Guards the scan itself: an empty set would pass the check below vacuously.
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter((code) => !(code in en)).sort()).toEqual([]);
  });
});
