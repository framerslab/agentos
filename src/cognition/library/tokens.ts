/**
 * @file tokens.ts
 * @description The word rule of the library's lexical legs: lower case, runs of letters and digits, in order, in
 * any script. PostgresVectorStore.lexicalSearch builds its query from the same runs, so an index that tokenizes with
 * this rule and the store read a query's words the same way. The rule stems nothing: a prefix match stands in for
 * stemming in every language.
 *
 * @module agentos/cognition/library/tokens
 */

/** The words of a text: lower-case runs of letters and digits, in order. */
export function lexicalTokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Where a query's words first begin a word of a text, and the text around that place, for a search hit. */
export interface Snippet {
  /** Where in the text the first word that begins with a query word starts, or -1 when none does. */
  at: number;
  /**
   * Whole words around that word, white space collapsed: about `before` characters ahead of it and about `after`
   * past its start, each end moved to a space or to the text's end.
   */
  text: string;
}

/**
 * A hit's snippet: the first word of the text that begins with one of the query's words (the lexical legs' prefix
 * rule, on the same runs of letters and digits), and whole words around it; with no such word, the text's start. The
 * offset is the text's own, read on the text as given, so a caller places the hit in its turns. `before` is 80 and
 * `after` 120 unless given.
 */
export function snippetAround(text: string, words: readonly string[], options: { before?: number; after?: number } = {}): Snippet {
  const before = options.before ?? 80;
  const after = options.after ?? 120;
  const wanted = words.map((word) => word.toLowerCase()).filter((word) => word.length > 0);
  let at = -1;
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0].toLowerCase();
    if (wanted.some((query) => word.startsWith(query))) {
      at = match.index ?? -1;
      break;
    }
  }
  const anchor = Math.max(0, at);
  const from = anchor <= before ? 0 : text.lastIndexOf(' ', anchor - before) + 1;
  const stop = text.indexOf(' ', Math.min(text.length, anchor + after));
  return { at, text: text.slice(from, stop === -1 ? text.length : stop).replace(/\s+/g, ' ').trim() };
}
