/**
 * @fileoverview The forms a grouped lexical search reads, held once for `LibraryIndex.searchGroups` and for the stores
 * that answer `lexicalGroupSearch`, so the index never admits a date, a cursor's rank, a source id or a number of
 * words that its store then refuses. Not exported from the package: the options' own documentation states each form.
 */

/** The most words a grouped search takes, as the stores' lexical search reads at most 32 words of a query. */
export const LEXICAL_GROUP_WORDS_MAX = 32;

/**
 * The most stored words one edit away a word of a grouped search is widened to. The store writes every word's stored
 * words into one tsquery, one `|` after another, which Postgres reads, joins and matches by recursion over its tree
 * (`findoprnd_recurse`, `QT2QTN`, `TS_execute_recurse` in src/backend/utils/adt, https://github.com/postgres/postgres/tree/REL_16_STABLE/src/backend/utils/adt), each step held by `check_stack_depth`
 * against `max_stack_depth` (2 MB by default, https://www.postgresql.org/docs/current/runtime-config-resource.html).
 * With this cap a tsquery holds at most 32 words of the search's own, each twice, and 2,048 stored words, whatever a
 * cursor carries, so no expansion reaches that limit.
 */
export const LEXICAL_GROUP_EXPANSION_MAX = 64;

/**
 * The form of an item's date: an ISO 8601 instant with its zone, to the microsecond at most. Postgres reads other
 * texts as dates too (`yesterday`, `infinity`), so a date reaches a statement only in this form; and Postgres keeps a
 * timestamp to the microsecond (https://www.postgresql.org/docs/current/datatype-datetime.html), so a seventh digit
 * of a second would make two instants level. The form alone admits a day or a time that does not exist:
 * {@link isLexicalGroupInstant} holds both.
 */
export const LEXICAL_GROUP_INSTANT_FORM =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** A rank as an earlier page answered it: decimal digits, with or without a fraction. */
const RANK_FORM = /^(\d+)(?:\.(\d+))?$/;

/**
 * The most digits a Postgres numeric holds before its point, leading zeros aside, and after it: 131072 and 16383
 * (https://www.postgresql.org/docs/16/datatype-numeric.html). A text past either overflows the numeric it is cast to.
 */
const NUMERIC_WHOLE_DIGITS_MAX = 131072;
const NUMERIC_FRACTION_DIGITS_MAX = 16383;

/**
 * The most bytes of a word of a tsquery, and the most bytes its words hold together, each with the one byte that
 * ends it, by MAXSTRLEN (2047) and MAXSTRPOS (1048575) in Postgres's src/include/tsearch/ts_type.h
 * (https://github.com/postgres/postgres/blob/REL_16_STABLE/src/include/tsearch/ts_type.h). A tsquery's text past
 * either fails to parse. Releases before https://github.com/postgres/postgres/commit/1fc1b82b2f refuse a word of
 * MAXSTRLEN bytes itself (`lenval >= MAXSTRLEN`), so a word is held to 2046 bytes, which every release reads.
 */
export const LEXICAL_GROUP_STORED_WORD_BYTES_MAX = 2046;
const TSQUERY_WORDS_BYTES_MAX = 1048575;

const utf8 = new TextEncoder();

/** The bytes of a word in UTF-8, as a tsquery holds it. */
export function lexicalGroupWordBytes(word: string): number {
  return utf8.encode(word).length;
}

/**
 * The bytes a grouped search's stored words one edit away have in its tsquery: what one tsquery holds, less the
 * search's own words, each written twice (itself and as a prefix, `word | word:*`), each with the byte that ends it.
 * The store joins the stored words and those words into one tsquery with `||`, and Postgres refuses a joined
 * tsquery in which a word starts past MAXSTRPOS ("tsquery is too large", since
 * https://github.com/postgres/postgres/commit/84b6a7a061); holding all of them to MAXSTRPOS keeps every word under it.
 * A word is counted at its own length: a text search configuration whose dictionaries write a word longer than it
 * is read is past this bound.
 */
export function lexicalGroupExpansionRoom(words: readonly string[]): number {
  return words.reduce((room, word) => room - 2 * (lexicalGroupWordBytes(word) + 1), TSQUERY_WORDS_BYTES_MAX);
}

/** The most hours a date's zone stands from UTC: the zones in use run from 12 hours behind to 14 ahead. */
const ZONE_HOURS_MAX = 14;

/** The days of a month of the proleptic Gregorian calendar, which Postgres reads dates in. */
function daysOf(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Whether a value is an instant a grouped search orders by: a text in {@link LEXICAL_GROUP_INSTANT_FORM} that names a
 * day that exists from the year 1 (Postgres has no year 0), an hour from 0 to 23, a minute and a second from 0 to 59,
 * and a zone at most fourteen hours and 59 minutes from UTC. Every such text is one Postgres reads as a
 * `timestamptz`, so a date the index admits never fails a statement.
 */
export function isLexicalGroupInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = LEXICAL_GROUP_INSTANT_FORM.exec(value);
  if (parts === null) return false;
  const [year, month, day, hour, minute, second, zoneHour, zoneMinute] = parts.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysOf(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    zoneHour <= ZONE_HOURS_MAX &&
    zoneMinute <= 59
  );
}

/**
 * Whether a value is a source id a grouped search can name: a text that is not empty and holds no NUL, which a
 * Postgres text cannot hold (https://www.postgresql.org/docs/current/datatype-character.html).
 */
export function isLexicalGroupSourceId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !value.includes('\u0000');
}

/**
 * Whether a value is a rank a grouped search can start after: decimal digits, with or without a fraction, that a
 * Postgres numeric holds, so at most 131072 digits before the point, leading zeros aside, and 16383 after it. Every
 * rank a page answers is such a text, as Postgres computed it as a numeric.
 */
export function isLexicalGroupRank(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = RANK_FORM.exec(value);
  if (parts === null) return false;
  return parts[1].replace(/^0+/, '').length <= NUMERIC_WHOLE_DIGITS_MAX && (parts[2] ?? '').length <= NUMERIC_FRACTION_DIGITS_MAX;
}

/**
 * Whether a value is a list for each of `words`, in order, of the stored words to widen it to that one tsquery holds
 * beside them: at most {@link LEXICAL_GROUP_EXPANSION_MAX} a word, each stored word a text that is not empty, holds no
 * NUL and is at most 2046 bytes of UTF-8, and all of them together, each with one byte more, at most
 * {@link lexicalGroupExpansionRoom}. A tsvector holds a word of 2047
 * bytes, which a release before Postgres's commit 1fc1b82b2f will not read in a tsquery; a cursor carrying one is
 * refused. Which stored words a word reaches is the caller's to check.
 */
export function isLexicalGroupExpansion(value: unknown, words: readonly string[]): value is string[][] {
  if (!Array.isArray(value) || value.length !== words.length) return false;
  let room = lexicalGroupExpansionRoom(words);
  for (const list of value) {
    if (!Array.isArray(list) || list.length > LEXICAL_GROUP_EXPANSION_MAX) return false;
    for (const word of list) {
      if (typeof word !== 'string' || word === '' || word.includes('\u0000')) return false;
      const length = lexicalGroupWordBytes(word);
      if (length > LEXICAL_GROUP_STORED_WORD_BYTES_MAX) return false;
      room -= length + 1;
      if (room < 0) return false;
    }
  }
  return true;
}
