/**
 * @fileoverview The forms a grouped lexical search reads, held once for `LibraryIndex.searchGroups` and for the stores
 * that answer `lexicalGroupSearch`, so the index never admits a date, a cursor's rank, a source id or a number of
 * words that its store then refuses. Not exported from the package: the options' own documentation states each form.
 */

/** The most words a grouped search takes, as the stores' lexical search reads at most 32 words of a query. */
export const LEXICAL_GROUP_WORDS_MAX = 32;

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
export const LEXICAL_GROUP_RANK_FORM = /^\d+(?:\.\d+)?$/;

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
