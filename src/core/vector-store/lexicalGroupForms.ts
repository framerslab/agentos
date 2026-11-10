/**
 * @fileoverview The forms a grouped lexical search reads, held once for `LibraryIndex.searchGroups` and for the stores
 * that answer `lexicalGroupSearch`, so the index never admits a date, a cursor's rank or a number of words that its
 * store then refuses. Not exported from the package: the options' own documentation states each form.
 */

/** The most words a grouped search takes, as the stores' lexical search reads at most 32 words of a query. */
export const LEXICAL_GROUP_WORDS_MAX = 32;

/**
 * The form of an item's date: an ISO 8601 instant with its zone. Postgres reads other texts as dates too
 * (`yesterday`, `infinity`), so a date reaches a statement only in this form, and Postgres refuses one that names no
 * real day or time.
 */
export const LEXICAL_GROUP_INSTANT_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A rank as an earlier page answered it: decimal digits, with or without a fraction. */
export const LEXICAL_GROUP_RANK_FORM = /^\d+(?:\.\d+)?$/;
