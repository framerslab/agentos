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

/** The words of a runtime with no `Intl.Segmenter`: runs of letters, marks and digits. */
const WORD = /[\p{L}\p{M}\p{Nd}]+/gu;

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

/**
 * A text's words as the comparison reads them: width and compatibility forms folded (NFKC), default-ignorable
 * characters such as the soft hyphen dropped, lower case in the language's own rule, punctuation and symbols dropped,
 * and a script written without spaces cut into words by the platform's segmenter.
 *
 * @param text - The text.
 * @param language - The text's language, a BCP-47 tag; a tag the platform refuses reads as `'und'`.
 * @returns The words, in order.
 */
export function spokenWords(text: string, language: string): string[] {
  const locale = localeOf(language);
  const folded = text.normalize('NFKC').replace(IGNORABLE, '').toLocaleLowerCase(locale);
  if (!Segmenter) return folded.match(WORD) ?? [];
  const words: string[] = [];
  for (const part of segmenterFor(locale, Segmenter).segment(folded)) {
    if (part.isWordLike) words.push(part.segment);
  }
  return words;
}

/** The longest run of words two sequences hold in common, in order. */
function common(a: readonly string[], b: readonly string[]): number {
  let row = new Array<number>(b.length + 1).fill(0);
  for (const word of a) {
    const next = [0];
    for (let j = 1; j <= b.length; j += 1) next.push(word === b[j - 1] ? (row[j - 1] ?? 0) + 1 : Math.max(row[j] ?? 0, next[j - 1] ?? 0));
    row = next;
  }
  return row[b.length] ?? 0;
}

/**
 * Compares what was asked with what was said, in one language. A reply with no transcript does not match.
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
