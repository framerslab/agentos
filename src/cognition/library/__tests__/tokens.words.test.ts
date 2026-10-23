import { describe, expect, it, vi } from 'vitest';
import { countWords, foldText } from '../tokens.js';

/**
 * The fold a search matches a word by: decomposed, its combining marks dropped, a curly apostrophe made straight, then
 * lower case on the whole word. `foldText`'s text equals it on every word.
 */
const wordFold = (word: string): string => word.normalize('NFD').replace(/\p{M}+/gu, '').replace(/\u2019/g, "'").toLowerCase();

describe('foldText', () => {
  it.each([
    ['Plan', 'plan'],
    ['\u00e9', 'e'],
    ['e\u0301', 'e'],
    ['R\u00e9sum\u00e9', 'resume'],
    ['किताब', 'कतब'],
    ['한', '\u1112\u1161\u11ab'],
    ['don\u2019t', "don't"],
    ['𝔘nicode', '𝔘nicode'],
    ['ΟΔΟΣ', 'οδος'],
    ['ΚΑ\u0301Σ', 'κας'],
    ['ΣΑ', 'σα'],
  ])('folds %j as the search folds it', (word, expected) => {
    expect(foldText(word).text).toBe(expected);
    expect(foldText(word).text).toBe(wordFold(word));
  });

  it('maps each folded unit to the source character it came from, the units of one character sharing its interval', () => {
    const folded = foldText('한\u00e9');
    // three jamo from the one syllable, then the e of the precomposed e with its acute
    expect(folded.text).toBe('\u1112\u1161\u11abe');
    expect(folded.map).toEqual([[0, 1], [0, 1], [0, 1], [1, 2]]);
  });

  it('widens the interval of the character before a dropped mark over the mark', () => {
    expect(foldText('e\u0301x')).toEqual({ text: 'ex', map: [[0, 2], [2, 3]] });
    expect(foldText('e\u0301\u0302x')).toEqual({ text: 'ex', map: [[0, 3], [3, 4]] });
    // a mark with no character before it widens nothing
    expect(foldText('\u0301e')).toEqual({ text: 'e', map: [[1, 2]] });
  });

  it('maps a character beyond the Basic Multilingual Plane to its two source units, and widens both over a mark after it', () => {
    expect(foldText('a𝔘b').map).toEqual([[0, 1], [1, 3], [1, 3], [3, 4]]);
    expect(foldText('a𝔘\u0301b')).toEqual({ text: 'a𝔘b', map: [[0, 1], [1, 4], [1, 4], [4, 5]] });
  });

  it('gives each unit of the folded text one interval, in order, inside the source', () => {
    for (const source of ['Plan', 'R\u00e9sume\u0301', 'किताब', '한글', 'don\u2019t', 'a𝔘b', 'ΟΔΟΣ ΚΑ\u0301Σ']) {
      const { text, map } = foldText(source);
      expect(map).toHaveLength(text.length);
      let previous = 0;
      for (const [start, end] of map) {
        expect(start).toBeGreaterThanOrEqual(previous);
        expect(end).toBeGreaterThan(start);
        expect(end).toBeLessThanOrEqual(source.length);
        previous = start;
      }
    }
  });

  it('answers an empty text with an empty map', () => {
    expect(foldText('')).toEqual({ text: '', map: [] });
  });
});

describe('countWords', () => {
  it.each([
    ['', 0],
    ['   ', 0],
    ['Beta ships 3 Oct.', 4],
    ["don't stop", 2],
    ['one\ntwo  three', 3],
    ['Q3 revenue was 1.2M, up 18 percent.', 7],
  ])('counts %j as %i', (text, count) => {
    expect(countWords(text)).toBe(count);
  });

  it('counts a Japanese text by the segmenter and prints the figure', () => {
    const count = countWords('明日の会議資料');
    // Japanese is cut by a dictionary, so two runtimes can differ by a word or two: the run's log keeps the figure.
    console.log(`countWords('明日の会議資料') = ${count}`);
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThanOrEqual(6);
  });

  it('counts the runs between white space where the runtime has no Intl.Segmenter', async () => {
    const held = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
    delete (Intl as unknown as { Segmenter?: unknown }).Segmenter;
    try {
      // A fresh copy of the module: its counter is made on its first count, so it finds no segmenter.
      vi.resetModules();
      const fresh = await import('../tokens.js');
      expect(fresh.countWords('Beta ships 3 Oct.')).toBe(4);
      expect(fresh.countWords(' a  b ')).toBe(2);
      // one run each here, where the segmenter cuts the first into its words and finds no word in the second
      expect(fresh.countWords('明日の会議資料')).toBe(1);
      expect(fresh.countWords('!!!')).toBe(1);
    } finally {
      if (held !== undefined) Object.defineProperty(Intl, 'Segmenter', held);
      vi.resetModules();
    }
  });

  it('counts the runs between white space where the runtime has no Intl at all', async () => {
    // A fresh copy of the module, imported first: its counter is made on its first count, which runs with no Intl.
    vi.resetModules();
    const fresh = await import('../tokens.js');
    let counts: number[] = [];
    vi.stubGlobal('Intl', undefined);
    try {
      counts = [fresh.countWords('Beta ships 3 Oct.'), fresh.countWords('!!!')];
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
    expect(counts).toEqual([4, 1]);
  });
});
