/**
 * @file tags.ts
 * @description Tags on what a person keeps: short lower-case words such as `budget`, with one spelling for each key,
 * and a vocabulary derived from the documents that hold them. Everything here is pure and runs in a page: it imports
 * the word module's rules and `FuzzyIndex`'s one-edit rule alone.
 *
 * - The grammar: a tag is 1 to 40 code points in NFC and lower case, runs of letters (each with its combining marks)
 *   and decimal digits, with single hyphens between runs in what a person types. `normalizeTag` makes typing a tag;
 *   `tagKey` and `canonicalTag` drop the hyphens, so `q3-planning` and `q3planning` are one tag, spelled `q3planning`.
 * - `classifyLegacyTag` reads a label stored before the grammar: an alias when case, Unicode normalization and
 *   separators alone stand between it and its key; unresolved otherwise (`C++`, `C#`, emoji, empty or overlong).
 * - `tagVocabulary` counts each document once a key; `resolveTag` makes a candidate an existing tag by its key, by its
 *   stem (one spaced word) or one edit away (both keys 5 code points or more, the same digits, no script written
 *   without spaces), or leaves it new.
 *
 * @module agentos/cognition/library/tags
 */
import { withinOneEdit } from '../rag/search/FuzzyIndex.js';
import { isUnspacedScript, stemWord } from './tokens.js';

/** The most code points a tag holds. */
export const TAG_MAX_CHARS = 40;

/** The most tags a new note or session holds. */
export const TAGS_MAX = 20;

/** The most suggestions a row offers. */
export const TAG_SUGGESTIONS_MAX = 5;

/** A run of letters or decimal digits, each followed by its combining marks. */
const RUN = /(?:[\p{L}\p{Nd}]\p{M}*)+/gu;

/** A tag as stored or typed: runs with single hyphens between them. */
const TAG_INPUT = /^(?:[\p{L}\p{Nd}]\p{M}*)+(?:-(?:[\p{L}\p{Nd}]\p{M}*)+)*$/u;

/** A stored label that is an alias: runs separated by white space, underscores or dash punctuation alone. */
const ALIAS_LABEL = /^(?:[\p{L}\p{Nd}]\p{M}*)+(?:[\s_\p{Pd}]+(?:[\p{L}\p{Nd}]\p{M}*)+)*$/u;

/** One separator of a stored label: white space, the underscore or dash punctuation. */
const SEPARATOR = /^[\s_\p{Pd}]$/u;

/**
 * A label without the separators at either end, which are separators there too: scanned by code point once from each
 * end, so a long run of separators inside the label is passed over once. An alternative anchored at the end of the
 * text is tried again from each separator of such a run, and grows with the square of its length.
 */
function withoutEnds(label: string): string {
  const points = Array.from(label);
  let start = 0;
  let end = points.length;
  while (start < end && SEPARATOR.test(points[start] ?? '')) start += 1;
  while (end > start && SEPARATOR.test(points[end - 1] ?? '')) end -= 1;
  return points.slice(start, end).join('');
}

/** A text's length in code points. */
function codePoints(text: string): number {
  return Array.from(text).length;
}

/** A text folded as tags are: NFKC, lower case, then NFC. */
function folded(text: string): string {
  return text.normalize('NFKC').toLowerCase().normalize('NFC');
}

/**
 * A lower-case text with each Greek sigma written again by its place in that text. Lower case writes a capital sigma
 * as final (ς) where a cased letter comes before it and none after it, looking past case-ignorable characters such as
 * a combining mark, the full stop, the colon, an apostrophe or the middle dot, and as medial (σ) otherwise. So the
 * separator a person typed would decide the letter (`ΟΣ.Α` lower-cases to `οσ.α`, `ΟΣ-Α` to `ος-α`), and so would the
 * form of sigma typed (`λογοσ` lower-cases to itself). Each sigma is written as a capital and the text lower-cased
 * again, so each takes the form its place in this text gives it.
 */
function sigmaByPlace(text: string): string {
  return text.replace(/[\u03C2\u03C3]/g, '\u03A3').toLowerCase();
}

/**
 * A tag without its hyphens, made a key. Joined runs could carry a final sigma into the middle of a key, so each sigma
 * is written again by its place in the key: `ΟΣ-Α`, `ΟΣΑ` and `ος α` all give `οσα`, and `λογοσ` gives `λογος`. The
 * key is then composed to NFC again, since joining two runs can set a Hangul syllable beside a final jamo (U+AC00 and
 * U+11A8 compose to U+AC01). So every key is itself a tag.
 */
function keyOf(tag: string): string {
  return sigmaByPlace(tag.replace(/-/g, '')).normalize('NFC');
}

/**
 * Whether a text is a tag as stored or typed: NFC, lower case, runs with single hyphens between them, 1 to 40 code
 * points, and a key of its own. Folding can leave a text no run or too many code points, so the key is asked for:
 * U+FE70, an Arabic mark's isolated form, is a letter whose compatibility form is a space and a mark, and twenty U+FB03
 * ligatures fold to sixty letters. A text whose compatibility form keeps a run but drops a mark (Thai U+0E33) is a tag
 * whose key differs from it.
 */
export function isTag(text: string): boolean {
  return text === text.normalize('NFC') && text === text.toLowerCase() && TAG_INPUT.test(text) && codePoints(text) <= TAG_MAX_CHARS && tagKey(text) !== null;
}

/**
 * Typing made a tag: NFKC, lower case and NFC, each run of other characters one hyphen and none at either end, and each
 * sigma written by its place in its run, so the separator typed never changes a letter (`ΟΣ.Α` and `ΟΣ-Α` both give
 * `ος-α`). Null when nothing is left or more than 40 code points are: a tag is refused, never cut.
 */
export function normalizeTag(input: string): string | null {
  const runs = folded(input).match(RUN);
  if (runs === null) return null;
  const tag = runs.map(sigmaByPlace).join('-');
  return codePoints(tag) <= TAG_MAX_CHARS ? tag : null;
}

/** A tag's key: `normalizeTag`'s answer without its hyphens, each sigma lower-cased by its place, in NFC; null where that is null. */
export function tagKey(input: string): string | null {
  const tag = normalizeTag(input);
  return tag === null ? null : keyOf(tag);
}

/** The one spelling of a tag, exactly its key, whatever the vocabulary, the counts, the device or the order of arrival. */
export function canonicalTag(input: string): string | null {
  return tagKey(input);
}

/** What a label stored before the grammar is: an alias of its key, or unresolved; with the key it would have, or null. */
export interface LegacyTagClass {
  state: 'alias' | 'unresolved';
  key: string | null;
}

/**
 * A stored label read without losing it: an alias when case, Unicode normalization and separators (white space, the
 * underscore, dash punctuation) alone stand between it and its key, between its runs or at either end (`budget_` and
 * `-budget` are aliases of `budget`); unresolved otherwise, its key kept as a candidate (`C++` is unresolved with the
 * key `c`, and is never merged into `c`), or null when it has none or it is too long.
 */
export function classifyLegacyTag(label: string): LegacyTagClass {
  const key = tagKey(label);
  return { state: key !== null && ALIAS_LABEL.test(withoutEnds(folded(label))) ? 'alias' : 'unresolved', key };
}

/** Compares two texts code point by code point, the order every tie falls back to. */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** A document the vocabulary and the suggester read: a note, or a kept session. */
export interface TagDocument {
  /** Its id, unique among the documents. */
  id: string;
  /** A note, or a kept session. */
  kind: 'note' | 'session';
  /** Its title. */
  title: string;
  /** Its text: a note's, or a kept session's report lines and the person's notes on it. */
  text: string;
  /** A note's keywords; none for a session. */
  keywords: readonly string[];
  /**
   * Its tags; each is read through `classifyLegacyTag`: a tag or an alias counts under its key, and a label left
   * unresolved (`C++`, `budget.`) or with no key is left out, never counted under its candidate key.
   */
  tags: readonly string[];
  /** When it last changed (a note's latest change, a session's start), in milliseconds since 1970, or null. */
  changedAt: number | null;
}

/** One tag of a vocabulary: the documents that hold it, of each kind, and the latest change among them. */
export interface TagUse {
  tag: string;
  uses: number;
  notes: number;
  sessions: number;
  lastUsed: number | null;
}

/**
 * A document's keys, each once, in the order it holds them: a tag or an alias gives its key, and a label
 * `classifyLegacyTag` leaves unresolved gives none, so `C++` is never counted as `c`.
 */
export function tagKeysOf(document: Pick<TagDocument, 'tags'>): string[] {
  const keys: string[] = [];
  for (const label of document.tags) {
    const { state, key } = classifyLegacyTag(label);
    if (state === 'alias' && key !== null && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** The tags the documents hold, each document counted once a key: most used first, ties by code point. */
export function tagVocabulary(documents: Iterable<TagDocument>): TagUse[] {
  const uses = new Map<string, TagUse>();
  for (const document of documents) {
    for (const key of tagKeysOf(document)) {
      const found: TagUse = uses.get(key) ?? { tag: key, uses: 0, notes: 0, sessions: 0, lastUsed: null };
      found.uses += 1;
      if (document.kind === 'note') found.notes += 1;
      else found.sessions += 1;
      if (document.changedAt !== null && (found.lastUsed === null || document.changedAt > found.lastUsed)) found.lastUsed = document.changedAt;
      uses.set(key, found);
    }
  }
  return [...uses.values()].sort((a, b) => b.uses - a.uses || compareCodePoints(a.tag, b.tag));
}

/** What a candidate becomes: an existing tag, by its key, its stem or one edit, or a new one; with what it was. */
export type TagResolution = { kind: 'existing'; tag: string; via: 'key' | 'stem' | 'edit'; from: string } | { kind: 'new'; tag: string; from: string };

/** The order among several matches: the most used, then the latest used, then the first by code point. */
export function preferredTagOrder(a: TagUse, b: TagUse): number {
  if (a.uses !== b.uses) return b.uses - a.uses;
  if (a.lastUsed !== b.lastUsed) return (b.lastUsed ?? Number.NEGATIVE_INFINITY) - (a.lastUsed ?? Number.NEGATIVE_INFINITY);
  return compareCodePoints(a.tag, b.tag);
}

/** The decimal digits of a key, in order, which a one-edit match must keep. */
function digitsIn(key: string): string {
  return (key.match(/\p{Nd}/gu) ?? []).join('');
}

/**
 * A candidate resolved against a vocabulary: the existing tag of its key; for one spaced word, the existing tag of its
 * stem; for a key of 5 code points or more in a spaced script, the existing tag one edit away with the same digits
 * (`q3` and `q4`, two years, two versions and `plan` and `play` stay apart); among several, `preferredTagOrder`'s
 * first. Otherwise a new tag, spelled as its key. Null for a candidate with no key.
 */
export function resolveTag(candidate: string, vocabulary: readonly TagUse[]): TagResolution | null {
  const normalized = normalizeTag(candidate);
  if (normalized === null) return null;
  const key = keyOf(normalized);
  const exact = vocabulary.find((found) => found.tag === key);
  if (exact !== undefined) return { kind: 'existing', tag: exact.tag, via: 'key', from: candidate };
  const spaced = !isUnspacedScript(key);
  if (spaced && !normalized.includes('-')) {
    const stem = stemWord(key);
    const stemmed = vocabulary.filter((found) => !isUnspacedScript(found.tag) && stemWord(found.tag) === stem);
    if (stemmed.length > 0) return { kind: 'existing', tag: [...stemmed].sort(preferredTagOrder)[0]!.tag, via: 'stem', from: candidate };
  }
  if (spaced && codePoints(key) >= 5) {
    const digits = digitsIn(key);
    const near = vocabulary.filter((found) => codePoints(found.tag) >= 5 && !isUnspacedScript(found.tag) && digitsIn(found.tag) === digits && withinOneEdit(found.tag, key));
    if (near.length > 0) return { kind: 'existing', tag: [...near].sort(preferredTagOrder)[0]!.tag, via: 'edit', from: candidate };
  }
  return { kind: 'new', tag: key, from: candidate };
}
