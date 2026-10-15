import { describe, expect, it } from 'vitest';

import { FuzzyIndex, withinOneEdit, type FuzzyDocument } from '../FuzzyIndex.js';

/** A seeded source of numbers from 0 up to 1 (mulberry32), so a failing case runs again the same way. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** The library's word rule with an apostrophe inside a word kept, as the guide states it. */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;

/** A word as the guide says a search compares it: in lower case, the accents of U+0300 to U+036F dropped, a curly apostrophe made straight. */
const folded = (word: string): string =>
  word.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC').replace(/’/g, "'").toLowerCase();

/** How many letters a word has: its code points. */
const lettersOf = (word: string): number => Array.from(word).length;

/** What a stored word counts for a query word, by the guide's table: the same 1, a word it begins 0.75, one edit away 0.5. */
function counts(stored: string, wanted: string, editMinLength: number): number {
  if (stored === wanted) return 1;
  if (stored.startsWith(wanted)) return 0.75;
  if (lettersOf(stored) >= editMinLength && lettersOf(wanted) >= editMinLength && withinOneEdit(wanted, stored)) return 0.5;
  return 0;
}

/**
 * The guide's ranking read the long way, every word of every document against every query word: each query word's
 * best count times the weight of its field, summed, highest first, a tie in the order the documents were added.
 */
function ranked(
  documents: ReadonlyMap<string, FuzzyDocument>,
  weights: Record<string, number>,
  query: string,
  match: 'all' | 'any',
  editMinLength: number,
): Array<{ id: string; score: number }> {
  const wanted = [...new Set(Array.from(query.normalize('NFC').matchAll(WORD), (found) => folded(found[0])))];
  if (wanted.length === 0) return [];
  const found: Array<{ id: string; score: number }> = [];
  for (const [id, document] of documents) {
    const best = wanted.map((word) => {
      let top = 0;
      for (const [name, weight] of Object.entries(weights)) {
        const value = document.fields[name];
        if (value === undefined) continue;
        for (const text of typeof value === 'string' ? [value] : value) {
          for (const each of text.normalize('NFC').matchAll(WORD)) top = Math.max(top, weight * counts(folded(each[0]), word, editMinLength));
        }
      }
      return top;
    });
    const kept = match === 'all' ? best.every((value) => value > 0) : best.some((value) => value > 0);
    if (kept) found.push({ id, score: best.reduce((sum, value) => sum + value, 0) });
  }
  return found.sort((a, b) => b.score - a.score);
}

/** Each word one edit from `word`, letter by letter: a letter added, dropped or changed at every place, and every two side by side swapped. */
function oneEditFrom(word: string, letter: string): string[] {
  const letters = Array.from(word);
  const joined = (parts: string[]): string => parts.join('');
  const edits: string[] = [];
  for (let at = 0; at <= letters.length; at += 1) edits.push(joined([...letters.slice(0, at), letter, ...letters.slice(at)]));
  for (let at = 0; at < letters.length; at += 1) {
    edits.push(joined([...letters.slice(0, at), ...letters.slice(at + 1)]));
    edits.push(joined([...letters.slice(0, at), letter, ...letters.slice(at + 1)]));
  }
  for (let at = 0; at + 1 < letters.length; at += 1) edits.push(joined([...letters.slice(0, at), letters[at + 1], letters[at], ...letters.slice(at + 2)]));
  return edits;
}

describe("FuzzyIndex's word lookup", () => {
  it('finds a word one edit away wherever the edit falls, two letters swapped across its middle included', () => {
    // Words of four to eight letters, one with a letter outside the Basic Multilingual Plane in its middle.
    for (const stored of ['abcd', 'abcde', 'abcdef', 'abcdefg', 'abcdefgh', 'ab\u{1D49C}cd']) {
      const index = new FuzzyIndex({ fields: { body: 1 } });
      index.addDocument({ id: 'd', fields: { body: stored } });
      const missed = oneEditFrom(stored, 'x').filter((edit) => lettersOf(edit) >= 4 && index.search(edit).length === 0);
      expect(missed, stored).toEqual([]);
    }
  });

  it('ranks as reading every word would, over random words with typos, accents, marks and letters outside the Basic Multilingual Plane, as documents come and go', () => {
    const weights = { title: 100, tags: 10, body: 1 };
    // Few letters, so words often begin one another or lie one edit apart; three of them fold to an e.
    const units = ['a', 'b', 'c', 'd', 'E', 'é', 'é', '\u{1D49C}', 'कि', '1'];
    const inserted = ['a', 'b', 'x', 'é', '\u{1D49C}', 'क'];
    const mismatches: unknown[] = [];

    for (const editMinLength of [1, 2, 3, 4]) {
      const next = seeded(4_000 + editMinLength);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
      const word = (): string => {
        let out = pick(units);
        const length = 1 + Math.floor(next() * 6);
        for (let at = 1; at < length; at += 1) out += `${next() < 0.08 ? pick(["'", '’']) : ''}${pick(units)}`;
        return out;
      };
      const words = (count: number): string => Array.from({ length: count }, word).join(' ');
      const document = (id: string): FuzzyDocument => {
        const tags = Array.from({ length: Math.floor(next() * 3) }, () => word());
        const sentences = Array.from({ length: 1 + Math.floor(next() * 3) }, () => words(2 + Math.floor(next() * 5)));
        return { id, fields: { title: words(1 + Math.floor(next() * 2)), tags, body: `${sentences.join('. ')}.` } };
      };
      const queryWord = (held: readonly string[]): string => {
        const roll = next();
        const stored = pick(held);
        if (roll < 0.3) return stored;
        const letters = Array.from(folded(stored));
        if (roll < 0.5) return letters.slice(0, 1 + Math.floor(next() * letters.length)).join('');
        if (roll < 0.85) return pick(oneEditFrom(letters.join(''), pick(inserted)));
        return word();
      };

      const index = new FuzzyIndex({ fields: weights, editMinLength });
      const live = new Map<string, FuzzyDocument>();
      const put = (added: FuzzyDocument): void => {
        index.addDocument(added);
        live.delete(added.id);
        live.set(added.id, added);
      };
      let made = 0;
      for (; made < 60; made += 1) put(document(`d${made}`));

      for (let step = 0; step < 120; step += 1) {
        const roll = next();
        if (roll < 0.15 && live.size > 0) {
          const id = pick([...live.keys()]);
          expect(index.removeDocument(id)).toBe(true);
          live.delete(id);
        } else if (roll < 0.25) {
          put(document(`d${made}`));
          made += 1;
        } else if (roll < 0.35 && live.size > 0) {
          // The same id again, with new words: it then counts as added last.
          put(document(pick([...live.keys()])));
        }
        const held = [...live.values()].flatMap((each) => Object.values(each.fields).flatMap((value) => (typeof value === 'string' ? [value] : value)).flatMap((text) => text.split(/[\s.]+/)).filter((text) => text !== ''));
        if (held.length === 0) continue;
        const query = Array.from({ length: 1 + Math.floor(next() * 3) }, () => queryWord(held)).join(' ');
        const match = step % 2 === 0 ? 'all' : 'any';
        const got = index.search(query, { topK: Number.POSITIVE_INFINITY, match }).map(({ id, score }) => ({ id, score }));
        const want = ranked(live, weights, query, match, editMinLength);
        if (JSON.stringify(got) !== JSON.stringify(want) && mismatches.length < 5) mismatches.push({ editMinLength, step, query, match, got, want });
      }

      // A restored index ranks as the index it was saved from.
      const restored = FuzzyIndex.fromJSON(JSON.parse(JSON.stringify(index.toJSON())));
      const titles = [...live.values()].map((each) => each.fields.title as string);
      for (const title of titles.slice(0, 20)) {
        const got = restored.search(title, { topK: Number.POSITIVE_INFINITY, match: 'any' }).map(({ id, score }) => ({ id, score }));
        const want = ranked(live, weights, title, 'any', editMinLength);
        if (JSON.stringify(got) !== JSON.stringify(want) && mismatches.length < 5) mismatches.push({ editMinLength, restored: true, query: title, got, want });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('answers 2,000 searches of five words over 200,000 distinct words in 10,000 documents within 15 seconds', () => {
    // Reading every word the index holds for each query word takes about a minute or more here on CI's runners;
    // looking a query word up among the words near it takes well under a second. 15 seconds is far from both.
    const next = seeded(60);
    const word = (): string => {
      let out = '';
      const length = 6 + Math.floor(next() * 5);
      for (let at = 0; at < length; at += 1) out += String.fromCharCode(97 + Math.floor(next() * 26));
      return out;
    };
    const documents = Array.from({ length: 10_000 }, (_, at) => ({ id: `d${at}`, title: [word(), word()], body: Array.from({ length: 18 }, word) }));
    const index = new FuzzyIndex({ fields: { title: 10, body: 1 } });
    for (const document of documents) index.addDocument({ id: document.id, fields: { title: document.title.join(' '), body: `${document.body.join(' ')}.` } });

    const changed = (text: string, at: number): string => `${text.slice(0, at)}${text[at] === 'q' ? 'z' : 'q'}${text.slice(at + 1)}`;
    const swapped = (text: string, at: number): string => `${text.slice(0, at)}${text[at + 1]}${text[at]}${text.slice(at + 2)}`;
    const added = (text: string, at: number): string => `${text.slice(0, at)}q${text.slice(at)}`;

    const missed: string[] = [];
    let answered = 0;
    const started = performance.now();
    for (let at = 0; at < 2_000; at += 1) {
      const document = documents[(at * 7_919) % documents.length];
      const [a, b, c, d] = document.body;
      const place = at % 5;
      // A title word as stored, then a body word with a letter changed, two swapped, only begun, and a letter added.
      const query = [document.title[0], changed(a, place), swapped(b, place), c.slice(0, 4), added(d, place)].join(' ');
      const [hit] = index.search(query, { topK: 1 });
      if (hit?.id !== document.id) missed.push(query);
      answered += 1;
      if (performance.now() - started > 15_000) break;
    }
    expect(missed).toEqual([]);
    expect(answered, 'searches answered within 15 seconds').toBe(2_000);
  });
});
