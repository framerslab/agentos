/**
 * @file tokens.ts
 * @description The word rule of the library's lexical legs: a text read in NFC and in lower case, and its words, in
 * order, in any script, each a letter or a digit followed by letters, digits and combining marks. It also holds the
 * rules tags match words by: a word's stem, whether a word's script is written without spaces, and the words of a text
 * as the tag rules read them, each with its place and what separates it from the word before (`tagSegments`); the
 * one-edit rule is FuzzyIndex's. A mark stays inside its word, so an accent written as a combining mark or a Devanagari vowel sign
 * does not split one, and a text reads the same words whether it came composed or decomposed. The rule stems nothing:
 * a prefix match stands in for stemming in every language.
 *
 * PostgresVectorStore.lexicalSearch builds its query from runs of letters and digits in lower case. On a text in NFC
 * that holds no combining mark once in lower case, as precomposed Latin, Greek and Cyrillic, Chinese and Japanese are
 * written, it reads the words this rule reads. A capital I with a dot (U+0130) is the exception there: lower case turns
 * it into an i and a combining dot, which this rule keeps in its word and the store's runs split at.
 *
 * @module agentos/cognition/library/tokens
 */

import { graphemeClusters } from './graphemes.js';

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

/**
 * A word without its ending: "-ing" past five letters, "-ed" and "-es" past four, "-s" past three unless it ends in
 * "-ss"; letters are code points. It joins "plans" with "plan" and "roadmaps" with "roadmap", and leaves "university"
 * and "universe" apart, which the Porter algorithm stems alike.
 */
export function stemWord(word: string): string {
  const size = Array.from(word).length;
  if (size > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (size > 4 && (word.endsWith('ed') || word.endsWith('es'))) return word.slice(0, -2);
  if (size > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * A character of a script written without spaces between words, each script read by its Unicode script property so
 * that no block of it is left out: Thai (its digits among them, since a number in Thai digits sits inside a Thai run),
 * the kana (the half-width forms among them), the CJK ideographs (the compatibility and the supplementary blocks among
 * them) and Hangul (the syllables and the jamo).
 */
const UNSPACED = /[\p{Script=Thai}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Hangul}]/u;

/**
 * Whether a word holds a character of a script written without spaces between words (Thai, Japanese kana, the
 * ideographs Chinese and Japanese share, Korean, whose long runs are common in data), where whole words cannot be
 * compared and one edit says nothing. A half-width kana letter, a compatibility or a supplementary ideograph and a
 * Thai digit all count, since each script is read by its Unicode script property.
 */
export function isUnspacedScript(word: string): boolean {
  return UNSPACED.test(word);
}

/** A word of a text as the tag rules read it. */
export interface TagSegment {
  /** The word as written in the text's NFC form, its combining marks kept with their letters. */
  text: string;
  /** Where it starts in the NFC form, in UTF-16 units. */
  start: number;
  /** One past where it ends. */
  end: number;
  /** True for a word of a script written without spaces (`isUnspacedScript`). */
  unspaced: boolean;
  /** A word of a spaced script; a word the word segmenter gave; or, with no segmenter, one grapheme cluster. */
  unit: 'spaced' | 'word' | 'grapheme';
  /** What lies between it and the word before: nothing, white space alone, or anything else (the text's start included). */
  gap: 'none' | 'space' | 'other';
}

/** Cuts a run of a script written without spaces into words, every character kept, in order. */
export type WordSegmenter = (run: string) => string[];

/** The runtime's word segmenter, made once on the first ask, or null where the runtime has no `Intl.Segmenter`. */
let runtimeWordSegmenter: WordSegmenter | null | undefined;

/** `Intl.Segmenter`'s word boundaries where the runtime has it, else null. The segmenter is made once and shared. */
export function defaultWordSegmenter(): WordSegmenter | null {
  if (runtimeWordSegmenter !== undefined) return runtimeWordSegmenter;
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'word' }) => { segment(text: string): Iterable<{ segment: string }> } }).Segmenter;
  let found: WordSegmenter | null = null;
  if (typeof Segmenter === 'function') {
    const segmenter = new Segmenter(undefined, { granularity: 'word' });
    found = (run: string): string[] => Array.from(segmenter.segment(run), (part) => part.segment);
  }
  runtimeWordSegmenter = found;
  return found;
}

/** A run of letters or decimal digits, each followed by its combining marks. */
const WORD_RUN = /(?:[\p{L}\p{Nd}]\p{M}*)+/gu;

/** A letter or a decimal digit. */
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;

/** A combining mark. */
const MARK = /^\p{M}$/u;

/** A decimal digit, which belongs to the script around it. */
const DIGIT = /^\p{Nd}$/u;

/**
 * A run cut where it changes between a spaced and an unspaced script; a mark stays with the character it follows, and a
 * digit with the part around it (a digit is neither script: `3月` and `明日3時` are one unspaced part each, `q3` and
 * `2026budget` one spaced part each, and digits alone a spaced part), so an unspaced tag that holds a digit matches as a
 * substring, punctuation alone cutting a run.
 */
function scriptParts(run: string): Array<{ text: string; offset: number; unspaced: boolean }> {
  const parts: Array<{ text: string; offset: number; unspaced: boolean | null }> = [];
  let offset = 0;
  for (const char of run) {
    const kind: boolean | null = MARK.test(char) || DIGIT.test(char) ? null : UNSPACED.test(char);
    const last = parts[parts.length - 1];
    if (last === undefined) {
      parts.push({ text: char, offset, unspaced: kind });
    } else if (kind === null || last.unspaced === null || last.unspaced === kind) {
      last.text += char;
      last.unspaced ??= kind;
    } else {
      parts.push({ text: char, offset, unspaced: kind });
    }
    offset += char.length;
  }
  return parts.map((part) => ({ text: part.text, offset: part.offset, unspaced: part.unspaced ?? false }));
}

/**
 * The words of a text for the tag rules, in order: in the text's NFC form, each run of letters or decimal digits with
 * the combining marks after each (`(?:[\p{L}\p{Nd}]\p{M}*)+`), so `किताब` and `كِتَاب` are one word each and a mark with
 * no letter before it starts none; a run cut where it changes between a spaced and an unspaced script; an unspaced part
 * cut by the word segmenter (`Intl.Segmenter` by default, none with `null`) or, with none, into grapheme clusters. A
 * piece that holds no letter or digit is left out. Each word says what separates it from the one before.
 */
export function tagSegments(text: string, options: { wordSegmenter?: WordSegmenter | null } = {}): TagSegment[] {
  const normalized = text.normalize('NFC');
  const segmenter = options.wordSegmenter === undefined ? defaultWordSegmenter() : options.wordSegmenter;
  const segments: TagSegment[] = [];
  let previousEnd: number | null = null;
  const push = (piece: string, start: number, unspaced: boolean, unit: TagSegment['unit']): void => {
    const between = previousEnd === null ? null : normalized.slice(previousEnd, start);
    const gap: TagSegment['gap'] = between === null ? 'other' : between === '' ? 'none' : /^\s+$/u.test(between) ? 'space' : 'other';
    segments.push({ text: piece, start, end: start + piece.length, unspaced, unit, gap });
    previousEnd = start + piece.length;
  };
  for (const match of normalized.matchAll(WORD_RUN)) {
    const at = match.index ?? 0;
    for (const part of scriptParts(match[0])) {
      const start = at + part.offset;
      if (!part.unspaced) {
        push(part.text, start, false, 'spaced');
        continue;
      }
      let offset = start;
      for (const piece of segmenter === null ? graphemeClusters(part.text) : segmenter(part.text)) {
        if (LETTER_OR_DIGIT.test(piece)) push(piece, offset, true, segmenter === null ? 'grapheme' : 'word');
        offset += piece.length;
      }
    }
  }
  return segments;
}
