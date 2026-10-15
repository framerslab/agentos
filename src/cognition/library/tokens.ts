/**
 * @file tokens.ts
 * @description The word rule of the library's lexical legs: a text read in NFC and in lower case, and its words, in
 * order, in any script, each a letter or a digit followed by letters, digits and combining marks. A mark stays inside
 * its word, so an accent written as a combining mark or a Devanagari vowel sign does not split one, and a text reads
 * the same words whether it came composed or decomposed. The rule stems nothing: a prefix match stands in for
 * stemming in every language.
 *
 * PostgresVectorStore.lexicalSearch builds its query from runs of letters and digits in lower case. On a text in NFC
 * whose words hold no combining mark, as precomposed Latin, Greek and Cyrillic, Chinese and Japanese are written, it
 * reads the words this rule reads.
 *
 * @module agentos/cognition/library/tokens
 */

/**
 * The word rule as a pattern: a letter or a digit, then any letters, digits and combining marks. A mark with no letter
 * or digit before it starts no word. FuzzyIndex extends the pattern with an apostrophe inside a word, and phraseHeard
 * counts words by it.
 *
 * @internal
 */
export const WORD_PATTERN = '[\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M}]*';

/**
 * The words of a text by {@link WORD_PATTERN}, shared by the calls below: `match` leaves its `lastIndex` at 0 and
 * `matchAll` reads a copy of it, so one call never starts where another stopped.
 */
const WORDS = new RegExp(WORD_PATTERN, 'gu');

/** The words of a text: read in NFC and in lower case, each a letter or a digit and the letters, digits and marks after it, in order. */
export function lexicalTokens(text: string): string[] {
  return text.normalize('NFC').toLowerCase().match(WORDS) ?? [];
}

/** Where a query's words first begin a word of a text, and the text around that place, for a search hit. */
export interface Snippet {
  /** Where in the text the first word that begins with a query word starts, or -1 when none does. */
  at: number;
  /**
   * Whole words around that word, white space collapsed: from just after the last white space (a space, a tab or a
   * line break) at or before `before` characters ahead of it (or from the text's start) to the first white space at or
   * after `after` characters past its start (or to the text's end). A text with no white space, as Chinese and
   * Japanese are written, comes back whole.
   */
  text: string;
}

/**
 * A hit's snippet: the first word of the text that begins with one of the query's words (the lexical legs' prefix
 * rule, on the words of the word rule, each word and query word compared in NFC and in lower case), and whole words
 * around it; with no such word, the text's start. The offset is the text's own, read on the text as given, so a caller
 * places the hit in its turns. `before` is 80 and `after` 120 unless given.
 */
export function snippetAround(text: string, words: readonly string[], options: { before?: number; after?: number } = {}): Snippet {
  const before = options.before ?? 80;
  const after = options.after ?? 120;
  const wanted = words.map((word) => word.normalize('NFC').toLowerCase()).filter((word) => word.length > 0);
  let at = -1;
  for (const match of text.matchAll(WORDS)) {
    const word = match[0].normalize('NFC').toLowerCase();
    if (wanted.some((query) => word.startsWith(query))) {
      at = match.index ?? -1;
      break;
    }
  }
  const anchor = Math.max(0, at);
  const from = anchor <= before ? 0 : lastWhiteSpaceAtOrBefore(text, anchor - before) + 1;
  const stop = firstWhiteSpaceAtOrAfter(text, Math.min(text.length, anchor + after));
  return { at, text: text.slice(from, stop === -1 ? text.length : stop).replace(/\s+/g, ' ').trim() };
}

/**
 * Where the last white space at or before `position` is, or -1.
 *
 * @internal
 */
export function lastWhiteSpaceAtOrBefore(text: string, position: number): number {
  for (let at = Math.min(position, text.length - 1); at >= 0; at -= 1) {
    if (/\s/.test(text[at])) return at;
  }
  return -1;
}

/**
 * Where the first white space at or after `position` is, or -1.
 *
 * @internal
 */
export function firstWhiteSpaceAtOrAfter(text: string, position: number): number {
  for (let at = Math.max(0, position); at < text.length; at += 1) {
    if (/\s/.test(text[at])) return at;
  }
  return -1;
}
