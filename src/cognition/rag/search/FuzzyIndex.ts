/**
 * @fileoverview A ranked search over a caller's documents and fields for a search box: a query word finds a word that
 * is the same, that it begins, or that is one edit away, a match counts the weight of the field it is in, and each hit
 * comes back with its matched words marked and the passages that hold them. Pure and synchronous, with no import but
 * the library's word rule, so a page can hold it.
 *
 * @module agentos/rag/search/FuzzyIndex
 */

import { WORD_PATTERN, firstWhiteSpaceAtOrAfter, lastWhiteSpaceAtOrBefore } from '../../library/tokens.js';

/** A text with the stretches of it a query matched. */
export interface Marked {
  /** The text as the index holds it, in NFC. */
  text: string;
  /** Each matched stretch, from `start` up to `end` in UTF-16 units: whole words, in order, never overlapping. */
  marks: Array<{ start: number; end: number }>;
}

/** A document: its id and its fields, each a text or a list of short texts, as keywords are. */
export interface FuzzyDocument {
  /** The document's id, one per document in the index. */
  id: string;
  /** The document's fields by name. A field the index was not made with is neither searched nor kept. */
  fields: Record<string, string | string[]>;
}

/** A word of a text and where it stands in it. */
export interface FuzzyToken {
  /** The word as it is compared, before the index folds its case and accents. */
  word: string;
  /** Where the word starts in the text, in UTF-16 units. */
  start: number;
  /** Where the word ends, one past its last unit. */
  end: number;
}

/** The words of a text, each with where it stands. The index hands it every text and query in NFC. */
export type FuzzyTokenizer = (text: string) => Iterable<FuzzyToken>;

/** What a {@link FuzzyIndex} is made with. */
export interface FuzzyIndexConfig {
  /** Each field's name and its weight, a finite number above 0. */
  fields: Record<string, number>;
  /** The fields whose sentences and lines make a hit's passages, in this order. @default the fields of the lowest weight */
  passageFields?: readonly string[];
  /** The words of a text. @default the library's word rule with an apostrophe inside a word kept */
  tokenize?: FuzzyTokenizer;
  /** The fewest letters a query word and a stored word each need to match one edit apart. @default 4 */
  editMinLength?: number;
  /** The most passages a hit shows: a whole number, 0 or more. @default 3 */
  passages?: number;
  /** About how many characters a passage keeps around its first match: a whole number, 1 or more. @default 160 */
  passageWidth?: number;
}

/** How a search matches, and how many hits it answers. */
export interface FuzzySearchOptions {
  /** The most hits answered: a whole number, 0 or more, or `Infinity` for every hit. @default 10 */
  topK?: number;
  /** `'all'` keeps the documents in which every query word matches; `'any'` those in which at least one does. @default 'all' */
  match?: 'all' | 'any';
}

/** A document a search found. */
export interface FuzzyHit {
  /** The document's id. */
  id: string;
  /** For each query word, its best match's kind times the weight of the field it is in, summed. */
  score: number;
  /** Each field the document holds, a text or a list of texts, with the words the query matched marked. */
  fields: Record<string, Marked | Marked[]>;
  /**
   * Up to `passages` sentences or lines of the passage fields that hold a match, in the order of the text, each
   * clipped around its first match; or, when only another field matched, the opening of the text, unmarked.
   */
  passages: Marked[];
}

/** A saved index: version 1. */
export interface FuzzyIndexJSON {
  /** The format's version. */
  v: 1;
  /** Each field's name and weight. */
  fields: Record<string, number>;
  /** The fields passages are taken from, in order. */
  passageFields: string[];
  /** The fewest letters for a match one edit away. */
  editMinLength: number;
  /** The most passages a hit shows. */
  passages: number;
  /** About how many characters a passage keeps. */
  passageWidth: number;
  /** Each document as its id and its fields, in the order they were added. */
  documents: Array<[id: string, fields: Record<string, string | string[]>]>;
}

/** What a stored word that is the same as a query word counts, before the weight of its field. */
const SAME = 1;
/** What a stored word that a query word begins counts. */
const BEGUN = 0.75;
/** What a stored word one edit away from a query word counts. */
const EDITED = 0.5;

/**
 * A word of the default tokenizer: the library's word rule with an apostrophe, straight or curly (U+2019), kept inside
 * a word between two of its letters, so "Professor's" and "don't" are one word each.
 */
const WORD = new RegExp(`${WORD_PATTERN}(?:['\u2019]${WORD_PATTERN})*`, 'gu');

/** The default tokenizer: every word of a text by {@link WORD}, with where it stands. */
function wordsOfText(text: string): FuzzyToken[] {
  return Array.from(text.matchAll(WORD), (found) => {
    const start = found.index ?? 0;
    return { word: found[0], start, end: start + found[0].length };
  });
}

/**
 * A word as the index compares it: the accents of the Combining Diacritical Marks block (U+0300 to U+036F,
 * https://www.unicode.org/Public/UCD/latest/ucd/Blocks.txt), the marks Latin, Greek and Cyrillic letters decompose
 * into, dropped; a curly apostrophe made straight; in lower case. The marks of other scripts, such as Devanagari's
 * vowel signs, are part of their letters and stay.
 */
function fold(word: string): string {
  return word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').replace(/\u2019/g, "'").toLowerCase();
}

/** How many letters a word has: its code points. */
function lettersIn(word: string): number {
  let count = 0;
  for (let at = 0; at < word.length; at += 1) {
    const unit = word.charCodeAt(at);
    // The second half of a surrogate pair belongs to the code point its first half began.
    if (unit < 0xdc00 || unit > 0xdfff || at === 0 || word.charCodeAt(at - 1) < 0xd800 || word.charCodeAt(at - 1) > 0xdbff) count += 1;
  }
  return count;
}

/** A unit of a surrogate pair, which makes a word one to compare by code points. */
const SURROGATE = /[\ud800-\udfff]/;

/**
 * True when two words are at most one edit apart, letter by letter (a letter is a code point): the same, or one letter
 * added, dropped or changed, or two letters side by side swapped. That is a Damerau-Levenshtein distance of 1 or less
 * (https://en.wikipedia.org/wiki/Damerau%E2%80%93Levenshtein_distance), read in one pass instead of a table. The words
 * are compared as they are given: fold both first for a comparison that ignores case.
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const byCodePoint = SURROGATE.test(a) || SURROGATE.test(b);
  const x: ArrayLike<string> = byCodePoint ? Array.from(a) : a;
  const y: ArrayLike<string> = byCodePoint ? Array.from(b) : b;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.length - short.length > 1) return false;
  let at = 0;
  while (at < short.length && short[at] === long[at]) at += 1;
  if (short.length === long.length) {
    // The letter at `at` changed, or the letters at `at` and `at + 1` swapped; the rest is the same either way.
    return sameFrom(short, long, at + 1, 0) || (short[at] === long[at + 1] && short[at + 1] === long[at] && sameFrom(short, long, at + 2, 0));
  }
  // A letter added to the shorter word at `at`.
  return sameFrom(short, long, at, 1);
}

/** True when `short` from `from` on is `long` from `from + shift` on. */
function sameFrom(short: ArrayLike<string>, long: ArrayLike<string>, from: number, shift: number): boolean {
  for (let at = from; at < short.length; at += 1) {
    if (short[at] !== long[at + shift]) return false;
  }
  return true;
}

/** What a stored word counts for a query word, both folded, with their letters counted: SAME, BEGUN, EDITED or 0. */
function kindOf(stored: string, storedLetters: number, wanted: string, wantedLetters: number, editMinLength: number): number {
  if (stored === wanted) return SAME;
  if (stored.startsWith(wanted)) return BEGUN;
  if (
    wantedLetters >= editMinLength &&
    storedLetters >= editMinLength &&
    Math.abs(storedLetters - wantedLetters) <= 1 &&
    withinOneEdit(wanted, stored)
  ) {
    return EDITED;
  }
  return 0;
}

/** A stretch of a text, from `start` up to `end`. */
interface Span {
  start: number;
  end: number;
}

/** Some stretches in order, those that overlap joined into one, so none overlaps another. */
function joined(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && span.start < last.end) last.end = Math.max(last.end, span.end);
    else out.push({ start: span.start, end: span.end });
  }
  return out;
}

/**
 * Where a sentence ends: a run of full stops, question marks or exclamation marks, or of the Devanagari danda and
 * double danda, the Arabic question mark or the Urdu full stop, followed by white space or the line's end, so "1.2M"
 * and "2.1" hold no end; or a run of the ideographic full stop and the full-width exclamation and question marks,
 * which Chinese and Japanese follow with no space.
 */
const SENTENCE_END = /[.!?\u0964\u0965\u061f\u06d4]+(?=\s|$)|[\u3002\uff01\uff1f]+/g;

/** White space, the end of a word for a passage's cut. */
const WHITE_SPACE = /\s/;

/** The sentences of a text, line by line, each without the white space around it: a line with no sentence's end is one. */
function sentencesOf(text: string): Span[] {
  const found: Span[] = [];
  const keep = (from: number, to: number): void => {
    let start = from;
    let end = to;
    while (start < end && WHITE_SPACE.test(text[start])) start += 1;
    while (end > start && WHITE_SPACE.test(text[end - 1])) end -= 1;
    if (start < end) found.push({ start, end });
  };
  for (const line of text.matchAll(/[^\n\r\u2028\u2029]+/g)) {
    const lineStart = line.index ?? 0;
    let at = 0;
    for (const stop of line[0].matchAll(SENTENCE_END)) {
      const end = (stop.index ?? 0) + stop[0].length;
      keep(lineStart + at, lineStart + end);
      at = end;
    }
    keep(lineStart + at, lineStart + line[0].length);
  }
  return found;
}

/** A combining mark at the start of a text. */
const MARK_FIRST = /^\p{M}/u;

/** True when the unit at `at` continues a character begun before it: the second half of a surrogate pair, or a combining mark. */
function continuesCharacter(text: string, at: number): boolean {
  const unit = text.charCodeAt(at);
  return (unit >= 0xdc00 && unit <= 0xdfff) || MARK_FIRST.test(text.slice(at, at + 2));
}

/**
 * A passage clipped to about `width` characters around its first mark, with an ellipsis where text was left out and
 * the marks moved to match. The window opens about a third of the width ahead of the mark, and each cut that falls
 * inside a word moves to white space so no word is split: the start to just after the first white space past it,
 * while that is ahead of the mark, and the end back to the last white space before it, while that is past the mark.
 * Where there is no such white space, as in Chinese or Japanese, the cut stays where the width puts it, moved off a
 * combining mark or the second half of a surrogate pair. The first mark is kept whole, however wide it is. A passage of
 * `width` characters or fewer comes back whole.
 */
function clip(text: string, marks: Span[], width: number): Marked {
  if (text.length <= width) return { text, marks };
  const first = marks[0];
  const anchor = first?.start ?? 0;
  const anchorEnd = first?.end ?? 0;
  let start = Math.max(0, anchor - Math.floor(width / 3));
  let end = Math.min(text.length, start + width);
  start = Math.max(0, end - width);
  end = Math.max(end, anchorEnd);
  if (start > 0 && !WHITE_SPACE.test(text[start - 1])) {
    const space = firstWhiteSpaceAtOrAfter(text, start);
    if (space !== -1 && space < anchor) start = space + 1;
    else while (start < anchor && continuesCharacter(text, start)) start += 1;
  }
  if (end < text.length && !WHITE_SPACE.test(text[end])) {
    const space = lastWhiteSpaceAtOrBefore(text, end);
    if (space > start && space >= anchorEnd) end = space;
    else while (end < text.length && continuesCharacter(text, end)) end += 1;
  }
  while (start < anchor && WHITE_SPACE.test(text[start])) start += 1;
  while (end > Math.max(start, anchorEnd) && WHITE_SPACE.test(text[end - 1])) end -= 1;
  const head = start > 0 ? '\u2026' : '';
  const tail = end < text.length ? '\u2026' : '';
  const shift = start - head.length;
  return {
    text: `${head}${text.slice(start, end)}${tail}`,
    marks: marks.filter((mark) => mark.start >= start && mark.end <= end).map((mark) => ({ start: mark.start - shift, end: mark.end - shift })),
  };
}

/** A word of a text in a hit, with the places in the query of the query words it matches. */
interface ReadWord extends Span {
  which: number[];
}

/** A text of a hit with its words read against the query. */
interface ReadText {
  text: string;
  words: ReadWord[];
}

/** A document as the index holds it. */
interface StoredDocument {
  id: string;
  /** Its place in the order documents were added, for ties. */
  seq: number;
  /** The fields the index names, in NFC, in the order of the index's fields. */
  fields: Record<string, string | string[]>;
  /** Each folded word of the document with the weight of the heaviest field that holds it. */
  terms: Map<string, number>;
}

/** A folded word of the index: its letters, and each document that holds it with the weight of its heaviest field there. */
interface Term {
  letters: number;
  postings: Map<string, number>;
}

/** The settings of an index, as given or as saved, before they are checked. */
interface Settings {
  fields: unknown;
  passageFields: unknown;
  editMinLength: unknown;
  passages: unknown;
  passageWidth: unknown;
}

/** True when `value` is a whole number of `least` or more. */
function isWhole(value: unknown, least: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= least;
}

/** True when `value` is a text or a list of texts. */
function isTextOrTexts(value: unknown): value is string | string[] {
  return typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

/** True when `record` holds `key` as its own. */
function holds(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** What keeps a set of fields and weights from being one an index can be made with, or undefined. */
function fieldsProblem(fields: unknown): string | undefined {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return 'fields are not an object of field weights';
  const entries = Object.entries(fields);
  if (entries.length === 0) return 'fields name no field';
  for (const [name, weight] of entries) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) return `field ${name} has a weight that is not a finite number above 0`;
  }
  return undefined;
}

/** What keeps settings from being ones an index can be made with, or undefined. */
function settingsProblem(settings: Settings): string | undefined {
  const problem = fieldsProblem(settings.fields);
  if (problem !== undefined) return problem;
  const fields = settings.fields as Record<string, number>;
  if (!Array.isArray(settings.passageFields)) return 'passageFields are not a list of field names';
  const named = new Set<string>();
  for (const name of settings.passageFields as unknown[]) {
    if (typeof name !== 'string' || !holds(fields, name)) return `passageFields names ${String(name)}, which is not a field`;
    if (named.has(name)) return `passageFields names ${name} twice`;
    named.add(name);
  }
  if (!isWhole(settings.editMinLength, 1)) return 'editMinLength is not a whole number of 1 or more';
  if (!isWhole(settings.passages, 0)) return 'passages is not a whole number of 0 or more';
  if (!isWhole(settings.passageWidth, 1)) return 'passageWidth is not a whole number of 1 or more';
  return undefined;
}

/** What keeps a saved index's documents from being ones {@link FuzzyIndex.toJSON} could have written, or undefined. */
function documentsProblem(json: FuzzyIndexJSON): string | undefined {
  const documents: unknown = json.documents;
  if (!Array.isArray(documents)) return 'documents are not an array';
  const ids = new Set<string>();
  for (let at = 0; at < documents.length; at += 1) {
    const entry: unknown = documents[at];
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      entry[0] === '' ||
      typeof entry[1] !== 'object' ||
      entry[1] === null ||
      Array.isArray(entry[1])
    ) {
      return `documents[${at}] is not [id, fields]`;
    }
    if (ids.has(entry[0])) return `documents[${at}] repeats the id of an earlier document`;
    ids.add(entry[0]);
    for (const [name, value] of Object.entries(entry[1] as Record<string, unknown>)) {
      if (!holds(json.fields, name)) return `documents[${at}] holds ${name}, which is not a field`;
      if (!isTextOrTexts(value)) return `documents[${at}] holds ${name}, which is not a text or a list of texts`;
    }
  }
  return undefined;
}

/**
 * A ranked search over a caller's documents. Each document is a set of named fields, a text or a list of short texts
 * each, and each field has the weight the index was made with. A query is read in NFC and cut into words by the
 * tokenizer, and each word, folded to lower case with its accents dropped, matches a word of a document that is:
 *
 * - the same word, which counts 1;
 * - a word it begins, which counts 0.75;
 * - one edit away (a letter added, dropped or changed, or two letters side by side swapped: {@link withinOneEdit}),
 *   where both words have `editMinLength` letters or more, which counts 0.5.
 *
 * A document's score is `sum over the query's words q of (max over its fields f and their words t of weight(f) *
 * kind(q, t))`: each query word's best match, its kind times the weight of the field it is in, summed over the query's
 * words, each counted once. With `match: 'all'` (the default) every query word must match somewhere in the document;
 * with `'any'`, at least one. Hits come highest score first; a tie keeps the order the documents were added in, a
 * document added again under its id counting as added last.
 *
 * A hit holds each field of the document with its matched words marked, and up to `passages` sentences or lines of
 * the passage fields that hold a match: those that hold the most query words, then the earliest, shown in the order of
 * the text, each clipped to about `passageWidth` characters around its first match. A document matched only in
 * another field shows the opening of its text, unmarked. A mark is a whole word at UTF-16 offsets into the text as the
 * index holds it, in NFC; the marks of a text are in order and never overlap.
 *
 * Pure and synchronous: it reads and writes nothing outside itself and imports nothing but the library's word rule,
 * so a page can hold it. It is saved with {@link FuzzyIndex.toJSON} and restored with {@link FuzzyIndex.fromJSON}.
 *
 * @example
 * ```typescript
 * const index = new FuzzyIndex({ fields: { title: 100, keywords: 10, body: 1 } });
 * index.addDocument({
 *   id: 'n1',
 *   fields: { title: 'Enclosure samples', keywords: ['factory'], body: 'The samples leave the factory on Friday.' },
 * });
 * const [hit] = index.search('firday'); // "Friday", one swap away in the body: 0.5 times 1
 * hit.passages; // [{ text: 'The samples leave the factory on Friday.', marks: [{ start: 33, end: 39 }] }]
 *
 * const restored = FuzzyIndex.fromJSON(JSON.parse(JSON.stringify(index.toJSON())));
 * ```
 */
export class FuzzyIndex {
  /** Each field's weight, in the order the fields were given. */
  private readonly weights: Map<string, number>;
  /** The fields passages are taken from, in order. */
  private readonly passageFields: readonly string[];
  /** The tokenizer every text and query is read with. */
  private readonly tokenize: FuzzyTokenizer;
  /** The fewest letters for a match one edit away. */
  private readonly editMinLength: number;
  /** The most passages a hit shows. */
  private readonly passageCount: number;
  /** About how many characters a passage keeps. */
  private readonly passageWidth: number;
  /** The documents by id, in the order they were added. */
  private readonly documents = new Map<string, StoredDocument>();
  /** Every folded word the documents hold. */
  private readonly terms = new Map<string, Term>();
  /** The place the next document added takes. */
  private nextSeq = 0;

  /**
   * Makes an empty index.
   *
   * @throws {RangeError} When `fields` names no field or gives a weight that is not a finite number above 0, when
   * `passageFields` names a field `fields` does not or one twice, or when `editMinLength`, `passages` or
   * `passageWidth` is not a whole number of at least 1, 0 and 1.
   * @throws {TypeError} When `tokenize` is given and is not a function.
   */
  constructor(config: FuzzyIndexConfig) {
    const problem = fieldsProblem(config?.fields);
    if (problem !== undefined) throw new RangeError(`FuzzyIndex: ${problem}.`);
    const weights = Object.entries(config.fields);
    const lowest = weights.reduce((least, [, weight]) => Math.min(least, weight), Number.POSITIVE_INFINITY);
    const settings: Settings = {
      fields: config.fields,
      passageFields: config.passageFields ?? weights.filter(([, weight]) => weight === lowest).map(([name]) => name),
      editMinLength: config.editMinLength ?? 4,
      passages: config.passages ?? 3,
      passageWidth: config.passageWidth ?? 160,
    };
    const settingsFault = settingsProblem(settings);
    if (settingsFault !== undefined) throw new RangeError(`FuzzyIndex: ${settingsFault}.`);
    if (config.tokenize !== undefined && typeof config.tokenize !== 'function') throw new TypeError('FuzzyIndex: tokenize is not a function.');
    this.weights = new Map(weights);
    this.passageFields = [...(settings.passageFields as string[])];
    this.tokenize = config.tokenize ?? wordsOfText;
    this.editMinLength = settings.editMinLength as number;
    this.passageCount = settings.passages as number;
    this.passageWidth = settings.passageWidth as number;
  }

  /** The words of a text by the tokenizer, in order of where they start, each checked to be a stretch of the text. */
  private tokensOf(text: string): FuzzyToken[] {
    const tokens: FuzzyToken[] = [];
    for (const token of this.tokenize(text)) {
      const word: unknown = token?.word;
      const start: unknown = token?.start;
      const end: unknown = token?.end;
      if (
        typeof word !== 'string' ||
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        start >= end ||
        end > text.length
      ) {
        throw new RangeError('FuzzyIndex: the tokenizer answered a word that is not a stretch of its text.');
      }
      tokens.push({ word, start, end });
    }
    return tokens.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  /**
   * Adds a document, replacing one of the same id, which then counts as added last. Fields the index was not made with
   * are left out, and a field given as `undefined` is taken as not given. A refused document leaves the index as it was.
   *
   * @throws {TypeError} When the id is not a text, `fields` is not an object, or a field is not a text or a list of
   * texts.
   * @throws {Error} When the id is empty.
   * @throws {RangeError} When the tokenizer answers a word that is not a stretch of its text.
   */
  addDocument(document: FuzzyDocument): void {
    const id: unknown = document?.id;
    if (typeof id !== 'string') throw new TypeError('FuzzyIndex.addDocument: id is not a text.');
    if (id === '') throw new Error('FuzzyIndex.addDocument: id must not be empty.');
    const given: unknown = document.fields;
    if (typeof given !== 'object' || given === null) throw new TypeError('FuzzyIndex.addDocument: fields is not an object.');
    const fields: Record<string, string | string[]> = {};
    const terms = new Map<string, number>();
    for (const [name, weight] of this.weights) {
      if (!holds(given, name)) continue;
      const value: unknown = (given as Record<string, unknown>)[name];
      if (value === undefined) continue;
      if (!isTextOrTexts(value)) throw new TypeError(`FuzzyIndex.addDocument: field ${name} is not a text or a list of texts.`);
      const stored = typeof value === 'string' ? value.normalize('NFC') : value.map((text) => text.normalize('NFC'));
      for (const text of typeof stored === 'string' ? [stored] : stored) {
        for (const token of this.tokensOf(text)) {
          const term = fold(token.word);
          if (term !== '' && (terms.get(term) ?? 0) < weight) terms.set(term, weight);
        }
      }
      fields[name] = stored;
    }
    this.removeDocument(id);
    this.documents.set(id, { id, seq: this.nextSeq, fields, terms });
    this.nextSeq += 1;
    for (const [term, weight] of terms) {
      let entry = this.terms.get(term);
      if (entry === undefined) {
        entry = { letters: lettersIn(term), postings: new Map() };
        this.terms.set(term, entry);
      }
      entry.postings.set(id, weight);
    }
  }

  /** Adds several documents, in order. A document that is refused throws, and those before it stay added. */
  addDocuments(documents: Iterable<FuzzyDocument>): void {
    for (const document of documents) this.addDocument(document);
  }

  /** Removes a document; true when it was there. */
  removeDocument(id: string): boolean {
    const document = this.documents.get(id);
    if (document === undefined) return false;
    for (const term of document.terms.keys()) {
      const entry = this.terms.get(term);
      if (entry === undefined) continue;
      entry.postings.delete(id);
      if (entry.postings.size === 0) this.terms.delete(term);
    }
    this.documents.delete(id);
    return true;
  }

  /** The query's words, read in NFC by the tokenizer and folded, each once, in the order they were typed. */
  private queryWords(query: string): string[] {
    return [...new Set(this.tokensOf(query.normalize('NFC')).map((token) => fold(token.word)).filter((word) => word !== ''))];
  }

  /**
   * Searches. A query with no word in it, such as an empty one or punctuation alone, finds nothing.
   *
   * @param query - The query text.
   * @param options - `topK` and `match`; see {@link FuzzySearchOptions}.
   * @returns The documents found, highest score first, a tie in the order they were added.
   * @throws {TypeError} When the query is not a text.
   * @throws {RangeError} When `topK` is not a whole number of 0 or more or `Infinity`, or `match` is not `'all'` or
   * `'any'`.
   */
  search(query: string, options: FuzzySearchOptions = {}): FuzzyHit[] {
    if (typeof query !== 'string') throw new TypeError('FuzzyIndex.search: query is not a text.');
    const topK = options.topK ?? 10;
    if (topK !== Number.POSITIVE_INFINITY && !isWhole(topK, 0)) throw new RangeError('FuzzyIndex.search: topK is not a whole number of 0 or more.');
    const match = options.match ?? 'all';
    if (match !== 'all' && match !== 'any') throw new RangeError("FuzzyIndex.search: match is not 'all' or 'any'.");
    const wanted = this.queryWords(query);
    if (wanted.length === 0 || topK === 0) return [];
    const wantedLetters = wanted.map(lettersIn);
    // For each document a query word matched: each query word's best match, its kind times its field's weight.
    const best = new Map<string, number[]>();
    wanted.forEach((word, place) => {
      for (const [term, entry] of this.terms) {
        const kind = kindOf(term, entry.letters, word, wantedLetters[place], this.editMinLength);
        if (kind === 0) continue;
        for (const [id, weight] of entry.postings) {
          let row = best.get(id);
          if (row === undefined) {
            row = new Array<number>(wanted.length).fill(0);
            best.set(id, row);
          }
          row[place] = Math.max(row[place], kind * weight);
        }
      }
    });
    const ranked: Array<{ document: StoredDocument; score: number }> = [];
    for (const [id, row] of best) {
      if (match === 'all' && row.some((value) => value === 0)) continue;
      const document = this.documents.get(id);
      if (document !== undefined) ranked.push({ document, score: row.reduce((sum, value) => sum + value, 0) });
    }
    ranked.sort((a, b) => b.score - a.score || a.document.seq - b.document.seq);
    return ranked.slice(0, topK).map(({ document, score }) => this.hitOf(document, score, wanted, wantedLetters));
  }

  /** A text's words, each with the places in the query of the query words it matches. */
  private readText(text: string, wanted: readonly string[], wantedLetters: readonly number[]): ReadText {
    const words: ReadWord[] = [];
    for (const token of this.tokensOf(text)) {
      const folded = fold(token.word);
      if (folded === '') continue;
      const letters = lettersIn(folded);
      const which: number[] = [];
      wanted.forEach((word, place) => {
        if (kindOf(folded, letters, word, wantedLetters[place], this.editMinLength) > 0) which.push(place);
      });
      words.push({ start: token.start, end: token.end, which });
    }
    return { text, words };
  }

  /** A document as a hit: its fields marked and its passages. */
  private hitOf(document: StoredDocument, score: number, wanted: readonly string[], wantedLetters: readonly number[]): FuzzyHit {
    const fields: Record<string, Marked | Marked[]> = {};
    const read = new Map<string, ReadText[]>();
    for (const [name, value] of Object.entries(document.fields)) {
      const texts = (typeof value === 'string' ? [value] : value).map((text) => this.readText(text, wanted, wantedLetters));
      read.set(name, texts);
      const marked = texts.map(({ text, words }): Marked => ({ text, marks: joined(words.filter((word) => word.which.length > 0)) }));
      fields[name] = typeof value === 'string' ? marked[0] : marked;
    }
    return { id: document.id, score, fields, passages: this.passagesOf(read) };
  }

  /**
   * A hit's passages: of the sentences and lines of its passage fields, in their order, those that hold a match, the
   * most query words first and then the earliest, at most `passages` of them, shown in the order of the text and
   * clipped; with none, the first sentence or line that holds a word, unmarked.
   */
  private passagesOf(read: Map<string, ReadText[]>): Marked[] {
    if (this.passageCount === 0) return [];
    const found: Array<{ text: string; sentence: Span; place: number; holdsWord: boolean; matched: ReadWord[]; distinct: number }> = [];
    for (const name of this.passageFields) {
      for (const { text, words } of read.get(name) ?? []) {
        // The words are in order of where they start, and so are the sentences, so one walk places every word.
        let next = 0;
        for (const sentence of sentencesOf(text)) {
          while (next < words.length && words[next].start < sentence.start) next += 1;
          const inside: ReadWord[] = [];
          while (next < words.length && words[next].start < sentence.end) {
            if (words[next].end <= sentence.end) inside.push(words[next]);
            next += 1;
          }
          const matched = inside.filter((word) => word.which.length > 0);
          const distinct = new Set(matched.flatMap((word) => word.which)).size;
          found.push({ text, sentence, place: found.length, holdsWord: inside.length > 0, matched, distinct });
        }
      }
    }
    const shown = found
      .filter((one) => one.distinct > 0)
      .sort((a, b) => b.distinct - a.distinct || a.place - b.place)
      .slice(0, this.passageCount)
      .sort((a, b) => a.place - b.place);
    if (shown.length === 0) {
      const opening = found.find((one) => one.holdsWord);
      return opening === undefined ? [] : [clip(opening.text.slice(opening.sentence.start, opening.sentence.end), [], this.passageWidth)];
    }
    return shown.map(({ text, sentence, matched }) =>
      clip(
        text.slice(sentence.start, sentence.end),
        joined(matched.map((word) => ({ start: word.start - sentence.start, end: word.end - sentence.start }))),
        this.passageWidth,
      ),
    );
  }

  /** The index as plain JSON: its settings and each document's id and fields, in the order they were added. */
  toJSON(): FuzzyIndexJSON {
    return {
      v: 1,
      fields: Object.fromEntries(this.weights),
      passageFields: [...this.passageFields],
      editMinLength: this.editMinLength,
      passages: this.passageCount,
      passageWidth: this.passageWidth,
      documents: Array.from(this.documents.values(), (document): [string, Record<string, string | string[]>] => [
        document.id,
        Object.fromEntries(Object.entries(document.fields).map(([name, value]) => [name, typeof value === 'string' ? value : [...value]])),
      ]),
    };
  }

  /**
   * A saved index restored: its settings and documents from the JSON, its tokenizer from `options` (the default
   * unless given). A saved index holds texts, so the restore reads them again with that tokenizer.
   *
   * @throws {Error} When the saved index is of another version or is not one {@link FuzzyIndex.toJSON} could have
   * written; the message names what is wrong.
   */
  static fromJSON(json: FuzzyIndexJSON, options: { tokenize?: FuzzyTokenizer } = {}): FuzzyIndex {
    if (json?.v !== 1) throw new Error('FuzzyIndex: a saved index of an unknown version.');
    const problem = settingsProblem(json) ?? documentsProblem(json);
    if (problem !== undefined) throw new Error(`FuzzyIndex: a saved index whose ${problem}.`);
    const index = new FuzzyIndex({
      fields: json.fields,
      passageFields: json.passageFields,
      editMinLength: json.editMinLength,
      passages: json.passages,
      passageWidth: json.passageWidth,
      tokenize: options.tokenize,
    });
    for (const [id, fields] of json.documents) index.addDocument({ id, fields });
    return index;
  }
}
