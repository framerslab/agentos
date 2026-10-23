import { describe, expect, it } from 'vitest';
import { countWords, foldText } from '../tokens.js';

/** The fold a search matches a word by, in the browser that runs the test (as tokens.words.test.ts has it). */
const wordFold = (word: string): string => word.normalize('NFD').replace(/\p{M}+/gu, '').replace(/\u2019/g, "'").toLowerCase();

describe('the word count and the fold in a browser', () => {
  it("counts words with the browser's word segmenter", () => {
    expect(countWords('Beta ships 3 Oct.')).toBe(4);
    expect(countWords("don't stop")).toBe(2);
    expect(countWords('Q3 revenue was 1.2M, up 18 percent.')).toBe(7);
  });

  it("folds a word as the browser's lower case of the whole word does, a capital sigma by its neighbours", () => {
    for (const word of ['R\u00e9sum\u00e9', 'e\u0301', 'किताब', '한', 'don\u2019t', '𝔘nicode', 'ΟΔΟΣ', 'ΚΑ\u0301Σ']) {
      expect(foldText(word).text).toBe(wordFold(word));
    }
    expect(foldText('ΟΔΟΣ').text).toBe('οδος');
    expect(foldText('ΚΑ\u0301Σ').text).toBe('κας');
  });
});
