/**
 * @fileoverview Whether a given sentence was said in a transcript's first lines: the share of the sentence's words
 * found in order (the longest common subsequence of words), and the lines that held them. Words are lower-case runs
 * of letters and digits; nothing is stemmed, since a transcriber writes the words it heard. Pure and DOM-free.
 * @module agentos/voice-pipeline/phraseHeard
 */

import { lexicalTokens } from '../../cognition/library/tokens.js';

/** A transcript line: its id and its text. */
export interface HeardLine {
  /** The line's id, such as the transcript item's id. */
  itemId: string;
  /** The line's text. */
  text: string;
}

/** The answer. */
export interface PhraseHeardResult {
  /** True when `ratio` reached the threshold. */
  heard: boolean;
  /** The share of the phrase's words found in order, 0 to 1. */
  ratio: number;
  /** The lines that held a matched word, in order, each once. */
  itemIds: string[];
}

/** How to read. */
export interface PhraseHeardOptions {
  /** The share needed, a number from 0 to 1. @default 0.8 */
  threshold?: number;
  /** How many of the lines' words are read, from the first: a whole number, 0 or more. @default 400 */
  maxWords?: number;
}

/**
 * Whether `phrase` was said in `lines`: the lines' words, joined in order and read up to `maxWords`, hold at least
 * `threshold` of the phrase's words in order, other words between them allowed.
 *
 * @throws {Error} When the phrase has no words.
 * @throws {RangeError} When `threshold` is not a number from 0 to 1, or `maxWords` is not a whole number, 0 or more.
 */
export function phraseHeard(phrase: string, lines: readonly HeardLine[], options: PhraseHeardOptions = {}): PhraseHeardResult {
  const want = lexicalTokens(phrase);
  if (want.length === 0) throw new Error('phraseHeard: the phrase has no words.');
  const threshold = options.threshold ?? 0.8;
  const maxWords = options.maxWords ?? 400;
  if (!(threshold >= 0 && threshold <= 1)) throw new RangeError('phraseHeard: threshold must be a number from 0 to 1.');
  if (!Number.isSafeInteger(maxWords) || maxWords < 0) {
    throw new RangeError('phraseHeard: maxWords must be a whole number, 0 or more.');
  }
  const words: string[] = [];
  const owners: string[] = [];
  for (const line of lines) {
    for (const word of lexicalTokens(line.text)) {
      if (words.length >= maxWords) break;
      words.push(word);
      owners.push(line.itemId);
    }
    if (words.length >= maxWords) break;
  }
  const n = want.length;
  const m = words.length;
  // table[i][j]: the longest common subsequence of want[i..] and words[j..].
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = want[i] === words[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const itemIds: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (want[i] === words[j]) {
      if (itemIds[itemIds.length - 1] !== owners[j]) itemIds.push(owners[j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  const ratio = table[0][0] / n;
  return { heard: ratio >= threshold, ratio, itemIds: [...new Set(itemIds)] };
}
