/**
 * @module learning/store/storableText
 *
 * The text a learning store keeps. A SQL text column holds UTF-8, so a database driver writes U+FFFD in place of a
 * lone surrogate (a UTF-16 code unit with no partner): a row with one reads back changed, and a key with one reads,
 * changes and deletes the rows of another key, the one with U+FFFD in its place. So every store refuses to write a
 * row whose text holds a lone surrogate, and a read, change or deletion by such a key finds nothing. JSON a store
 * keeps (a session row's lists, which the SQL store writes with `JSON.stringify`) writes each one as an escape, and
 * keeps it.
 */

/** A high surrogate with no low one after it, or a low one with no high one before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether any of `texts` holds a lone surrogate. */
export function holdsLoneSurrogate(...texts: ReadonlyArray<string | null | undefined>): boolean {
  return texts.some((text) => typeof text === 'string' && LONE_SURROGATE.test(text));
}

/**
 * Refuses a row any of whose text fields holds a lone surrogate.
 * @throws {Error} Naming the row and the field, before anything is written.
 */
export function assertStorableText(what: string, row: object): void {
  for (const [field, value] of Object.entries(row)) {
    if (typeof value === 'string' && LONE_SURROGATE.test(value)) {
      throw new Error(
        `A learning store writes no text that holds a lone surrogate, which a SQL text column cannot hold: the ${what}'s ${field} holds one.`,
      );
    }
  }
}
