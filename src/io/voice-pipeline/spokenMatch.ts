/**
 * @module voice-pipeline/spokenMatch
 *
 * Whether a voice said the text it was asked to say: both texts cut into words the same way and compared as sequences.
 * A host checks a realtime voice's transcript with it before it plays a clip, and writes two texts the same way before
 * it asks `phraseHeard` whether one was heard in the other.
 *
 * Numbers fold first, by the rule in `spokenNumbers.ts`: "3" and "three" are one word, so a transcript that writes a
 * number in words matches a text that writes it in digits, and the reverse. Pure and DOM-free.
 */
import { foldNumbers } from './spokenNumbers.js';

/** A verdict on a spoken reply: whether its words equal the text's, and the share of the longer sequence the two hold in common, in order. */
export interface SpokenMatch {
  /** True only when the two word sequences are equal, numbers folded. */
  match: boolean;
  /** The longest run of words the two hold in common, in order, over the longer sequence's length: 0 to 1. */
  ratio: number;
}

/** The part of `Intl.Segmenter` the word rule uses. It is ES2022; the package compiles against ES2021's library. */
interface WordSegmenter {
  segment(text: string): Iterable<{ segment: string; isWordLike?: boolean }>;
}

type WordSegmenterConstructor = new (locale: string, options: { granularity: 'word' }) => WordSegmenter;

const Segmenter = (Intl as unknown as { Segmenter?: WordSegmenterConstructor }).Segmenter;

/** One segmenter a locale, made on first use. */
const segmenters = new Map<string, WordSegmenter>();
const MAX_SEGMENTERS = 64;

/** Characters that change nothing a voice says: the soft hyphens CLDR writes inside German and Italian numbers, joiners. */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * The words of a runtime with no `Intl.Segmenter`: runs of letters, marks and digits, an apostrophe or a mid-word
 * point between two of them kept inside the word as the segmenter keeps it ("don't", "l'homme").
 */
const WORD = /[\p{L}\p{M}\p{Nd}]+(?:['\u2019.:\u00B7][\p{L}\p{M}\p{Nd}]+)*/gu;

/** What a word loses inside it: everything but letters, marks and digits, so "don't" is "dont" on every runtime. */
const INNER = /[^\p{L}\p{M}\p{Nd}]+/gu;

/** A separator between digits: a point, a comma, a colon, a slash or a dash. */
const SEPARATOR = '[.,:/\\u002D\\u2010-\\u2015\\u2212]';
/** A percent or currency sign after digits. */
const AFTER = '(?:[%\\u2030]|\\p{Sc})';

/**
 * Digits written with a separator between them ("3:15", "1/2", "1,000"), with a sign or a currency before them ("-5",
 * "$5"), or with a percent or currency after them ("5%"): one word, compared as written, so a time, a date, a fraction,
 * a signed number and an amount never fold to bare numbers. A dash after a letter or a digit is no sign ("covid-19").
 * The two forms that begin with a digit begin at a digit run's first digit: a match from inside a run is also one from
 * its start, and a scan that tried each digit of a long bare run again took time that grew with the run's square.
 */
const NUMERIC_SPAN = new RegExp(
  [
    `(?:(?<![\\p{L}\\p{M}\\p{Nd}])[+\\u002D\\u2212]|\\p{Sc})\\p{Nd}+(?:${SEPARATOR}\\p{Nd}+)*${AFTER}?`,
    `(?<!\\p{Nd})\\p{Nd}+(?:${SEPARATOR}\\p{Nd}+)+${AFTER}?`,
    `(?<!\\p{Nd})\\p{Nd}+${AFTER}`,
  ].join('|'),
  'gu'
);

/** Past this many pairs of words between their shared start and end, two texts' common share counts those alone. */
const MAX_PAIRS = 1_000_000;

/** A BCP-47 tag in canonical form; `'und'`, the undetermined language, for a tag the platform refuses. */
function localeOf(language: string): string {
  try {
    return Intl.getCanonicalLocales(language)[0] ?? 'und';
  } catch {
    return 'und';
  }
}

function segmenterFor(locale: string, make: WordSegmenterConstructor): WordSegmenter {
  let segmenter = segmenters.get(locale);
  if (!segmenter) {
    if (segmenters.size >= MAX_SEGMENTERS) segmenters.clear();
    segmenter = new make(locale, { granularity: 'word' });
    segmenters.set(locale, segmenter);
  }
  return segmenter;
}

/** Adds a stretch of text's words: the segmenter's word-like segments, or `WORD`'s runs, each without its inner punctuation. */
function addWords(text: string, locale: string, words: string[]): void {
  if (!text) return;
  const parts = Segmenter
    ? [...segmenterFor(locale, Segmenter).segment(text)].filter((part) => part.isWordLike).map((part) => part.segment)
    : (text.match(WORD) ?? []);
  for (const part of parts) {
    const word = part.replace(INNER, '');
    if (word) words.push(word);
  }
}

/**
 * A text's words as the comparison reads them: width and compatibility forms folded (NFKC), default-ignorable
 * characters such as the soft hyphen dropped, lower case in the language's own rule, punctuation and symbols dropped
 * (inside a word too: "don't" is "dont"), and a script written without spaces cut into words by the platform's
 * segmenter. A number written with a separator, a sign, a currency or a percent ("3:15", "1/2", "-5", "$5", "5%") is
 * one word as written.
 *
 * @param text - The text.
 * @param language - The text's language, a BCP-47 tag; a tag the platform refuses reads as `'und'`.
 * @returns The words, in order.
 */
export function spokenWords(text: string, language: string): string[] {
  const locale = localeOf(language);
  const folded = text.normalize('NFKC').replace(IGNORABLE, '').toLocaleLowerCase(locale);
  const words: string[] = [];
  let from = 0;
  for (const span of folded.matchAll(NUMERIC_SPAN)) {
    const at = span.index ?? from;
    addWords(folded.slice(from, at), locale, words);
    words.push(span[0]);
    from = at + span[0].length;
  }
  addWords(folded.slice(from), locale, words);
  return words;
}

/**
 * The words two sequences hold in common, in order: their shared start and end, and the longest common subsequence
 * between them while the words left between them make at most `MAX_PAIRS` pairs.
 */
function common(a: readonly string[], b: readonly string[]): number {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  const restA = a.slice(start, a.length - end);
  const restB = b.slice(start, b.length - end);
  if (restA.length * restB.length > MAX_PAIRS) return start + end;
  return start + end + inOrder(restA, restB);
}

/** The longest run of words two sequences hold in common, in order. */
function inOrder(a: readonly string[], b: readonly string[]): number {
  let row = new Array<number>(b.length + 1).fill(0);
  for (const word of a) {
    const next = [0];
    for (let j = 1; j <= b.length; j += 1) next.push(word === b[j - 1] ? (row[j - 1] ?? 0) + 1 : Math.max(row[j] ?? 0, next[j - 1] ?? 0));
    row = next;
  }
  return row[b.length] ?? 0;
}

/**
 * Compares what was asked with what was said, in one language. A reply with no transcript does not match. Two long
 * texts that differ past their shared start and end, with more than a million pairs of words left between them, get the
 * share of that start and end alone as their ratio, so the work stays bounded; `match` is exact at any length.
 *
 * @param asked - The text the voice was asked to say.
 * @param said - What the voice said, such as its own transcript of the audio.
 * @param language - The language of both, a BCP-47 tag.
 * @returns Whether the two word sequences are equal, and the share they hold in common.
 */
export function spokenMatch(asked: string, said: string, language: string): SpokenMatch {
  const a = foldNumbers(spokenWords(asked, language), language);
  const b = foldNumbers(spokenWords(said, language), language);
  if (a.length === 0 || b.length === 0) return { match: false, ratio: 0 };
  const match = a.length === b.length && a.every((word, at) => word === b[at]);
  return { match, ratio: match ? 1 : common(a, b) / Math.max(a.length, b.length) };
}
