/**
 * @fileoverview Removes tokens that match a configurable stop word list.
 * @module agentos/nlp/filters/StopWordFilter
 */

import type { Token } from '../types';
import type { ITextProcessor } from '../ITextProcessor';
import { getNaturalModule } from '../naturalInterop';
import { ENGLISH_STOP_WORDS } from './stopWordLists';

export { CODE_STOP_WORDS, ENGLISH_STOP_WORDS } from './stopWordLists';

/**
 * Extended stop word list from the `natural` NLP library (170 words).
 * Loaded lazily — falls back to ENGLISH_STOP_WORDS if natural is unavailable.
 */
let _naturalStopWords: ReadonlySet<string> | null = null;
export function getNaturalStopWords(): ReadonlySet<string> {
  if (_naturalStopWords) return _naturalStopWords;
  const natural = getNaturalModule();
  if (natural?.stopwords && Array.isArray(natural.stopwords)) {
    _naturalStopWords = new Set(natural.stopwords as string[]);
    return _naturalStopWords;
  }
  _naturalStopWords = ENGLISH_STOP_WORDS;
  return _naturalStopWords;
}

/**
 * Filters tokens whose `.text` appears in the provided stop word set.
 * Case-sensitive — apply after LowercaseNormalizer for case-insensitive filtering.
 */
export class StopWordFilter implements ITextProcessor {
  readonly name = 'StopWordFilter';
  private stopWords: ReadonlySet<string>;

  /**
   * @param stopWords — stop word set to filter against. Defaults to `natural`'s
   * 170-word list when available, falls back to the built-in 120-word ENGLISH_STOP_WORDS.
   */
  constructor(stopWords?: ReadonlySet<string>) {
    this.stopWords = stopWords ?? getNaturalStopWords();
  }

  process(tokens: Token[]): Token[] {
    return tokens.filter(t => !this.stopWords.has(t.text));
  }
}
