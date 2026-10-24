/**
 * @fileoverview The Markdown the library's readers write, in a line-based profile a notes editor reads: one line is one
 * block (a paragraph, a heading of level one to three, a bulleted, numbered or checklist item nested by indentation, a
 * quote's line, a divider, a fenced code block's line or a table's row), with bold, italic, struck words (two tildes
 * each side) and inline code in a line. Typed characters that would read as a block or a mark get a backslash before
 * them, so a written text reads back as the same words. It imports nothing.
 * @module agentos/cognition/library/readers/markdown
 */

/** A run of a line's words and the marks on it. Inline code takes no other mark. */
export interface MarkedRun {
  /** The run's characters. */
  text: string;
  /** True for bold words. */
  bold: boolean;
  /** True for italic words. */
  italic: boolean;
  /** True for struck words. */
  strike: boolean;
  /** True for inline code. */
  code: boolean;
}

/**
 * A line CommonMark reads as a heading: up to three spaces, one to six hashes, then a space or a tab and its words, or
 * nothing. The profile's headings stop at the third level, but a line of four to six hashes is escaped all the same.
 */
const HEADING = /^( {0,3})(#{1,6})(?:[ \t](.*))?$/;

/**
 * A run of hashes that ends a heading's words after a space or a tab, or is all its words, which CommonMark reads as
 * the heading's closing sequence and leaves out.
 */
const CLOSING_HASHES = /(?:^|[ \t])(#+)[ \t]*$/;

/**
 * A code line a note's text protects: spaces or none, then one or two hashes and a space. A code block's writer puts
 * a space before such a line, and the profile's reader takes it away again.
 */
const HASH_LINE = /^ *#{1,2} /;

/** A divider: three or more of the same dash, star or underscore, spaces between them allowed. */
export const DIVIDER = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** A quote's line: up to three spaces, then the quote's mark. */
const QUOTE = /^ {0,3}>/;

/** A bulleted item: its indentation, its bullet, then its words or nothing. */
const BULLET = /^( *)([-*+])(?: (.*))?$/;

/** A numbered item: its indentation, its number, its full stop or bracket, then its words or nothing. */
const ORDERED = /^( *)(\d{1,9})([.)])(?: (.*))?$/;

/**
 * A line of equals signs or of dashes, which CommonMark reads as the underline of a heading after a paragraph's line,
 * whatever its length: `=` and `--` among them.
 */
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;

/** A table's separator line: cells of dashes, a colon at either end allowed, between bars. */
const TABLE_SEPARATOR = /^ {0,3}\|?(?:[ \t]*:?-+:?[ \t]*\|)*[ \t]*:?-+:?[ \t]*\|?[ \t]*$/;

/** The characters a backslash escapes: every ASCII punctuation character, as CommonMark has it. */
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/** A Unicode white space character, which ends a mark's run at its side. */
const SPACE = /\s/u;

/** A letter or a digit: an underscore between two of them is inside a word, where it opens and closes nothing. */
const WORD = /[\p{L}\p{N}]/u;

/** A Unicode punctuation or symbol character, which the rules for a mark's delimiters read. */
const PUNCTUATION = /[\p{P}\p{S}]/u;

/** The characters `escapeText` decides on; every other character is written as it is. */
const SPECIAL = /[`\\*_~[<&]/g;

/** An entity or a numeric character reference at a text's start, which CommonMark reads as the character it names. */
const ENTITY = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/;

/**
 * What can follow `<` to open an HTML tag, a comment, a declaration or an autolink in CommonMark: a letter, `/`, `!` or
 * `?`, and every character an email autolink's address may start with, digits among them (`<3@example.com>`).
 */
const TAG_START = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/;

/** The three marks a run can carry beside code. */
type RunMark = 'bold' | 'italic' | 'strike';

/** The three marks, in the order the writer opens the delimiters of runs that end together. */
const MARKS: readonly RunMark[] = ['bold', 'italic', 'strike'];

/** The delimiters of the three marks. */
const DELIMITER = { bold: '**', italic: '*', strike: '~~' } as const;

/** The most characters a table pads a column to; a longer cell runs past its column. */
const PAD_LIMIT = 40;

/** The character, a whole code point, that ends just before a place in a text; `undefined` at its start. */
function charBefore(text: string, at: number): string | undefined {
  if (at <= 0) return undefined;
  const low = text.charCodeAt(at - 1);
  if (low >= 0xdc00 && low <= 0xdfff && at >= 2) {
    const high = text.charCodeAt(at - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(at - 2, at);
  }
  return text[at - 1];
}

/** The character, a whole code point, that starts at a place in a text; `undefined` at its end. */
function charAt(text: string, at: number): string | undefined {
  const point = text.codePointAt(at);
  return point === undefined ? undefined : String.fromCodePoint(point);
}

/**
 * True when the character of a run at the side given, its last or its first, is one a delimiter can stand beside on
 * its far side: neither white space nor punctuation, and not inline code.
 */
function wordChar(cell: MarkedRun | undefined, side: 'first' | 'last'): boolean {
  if (cell === undefined || cell.code) return false;
  const char = side === 'first' ? charAt(cell.text, 0) : charBefore(cell.text, cell.text.length);
  return char !== undefined && !SPACE.test(char) && !PUNCTUATION.test(char);
}

/**
 * The runs with the white space at either edge of a bold, italic or struck run moved outside the mark, since a mark's
 * delimiters cannot stand beside a space, and the punctuation at an edge moved outside it where a letter or a digit
 * stands beyond that edge, as CommonMark's flanking rules need; then merged with their like, code with the code
 * beside it.
 */
function expelSpaces(runs: readonly MarkedRun[]): MarkedRun[] {
  const cells: MarkedRun[] = [];
  for (const run of runs) {
    // only a marked run's edges can move, so a run with no mark stays whole, however long
    if (run.code || !(run.bold || run.italic || run.strike)) cells.push({ ...run });
    else for (const char of run.text) cells.push({ ...run, text: char });
  }
  for (const mark of MARKS) {
    let at = 0;
    while (at < cells.length) {
      if (cells[at]?.[mark] !== true) {
        at += 1;
        continue;
      }
      let end = at;
      while (cells[end]?.[mark] === true) end += 1;
      for (let first = at; first < end; first += 1) {
        const cell = cells[first];
        if (cell === undefined || !(SPACE.test(cell.text) || (PUNCTUATION.test(cell.text) && wordChar(cells[first - 1], 'last')))) break;
        cell[mark] = false;
      }
      for (let last = end - 1; last >= at; last -= 1) {
        const cell = cells[last];
        if (cell === undefined || cell[mark] !== true) break;
        if (!(SPACE.test(cell.text) || (PUNCTUATION.test(cell.text) && wordChar(cells[last + 1], 'first')))) break;
        cell[mark] = false;
      }
      at = end;
    }
  }
  const merged: MarkedRun[] = [];
  for (const cell of cells) {
    const last = merged[merged.length - 1];
    // code beside code is one span, so one span's closing backticks never meet the next one's opening
    if (last !== undefined && last.code && cell.code) last.text += cell.text;
    else if (last !== undefined && !last.code && !cell.code && MARKS.every((mark) => last[mark] === cell[mark])) last.text += cell.text;
    else merged.push(cell);
  }
  return merged;
}

/**
 * A run's characters with the escapes that keep them text: every backtick, a backslash before a punctuation character
 * or at the run's end, a star unless a space stands at each side of it inside the run, an underscore unless a letter
 * or a digit stands at each side of it, inside a word, or a space does, and a tilde beside another tilde or at either
 * end of the run, where it could join a struck run's two. The profile reads none of these as anything but itself
 * after its backslash, and CommonMark reads more as marks than it does, so the escapes also cover what CommonMark
 * would read: an underscore that could open or close emphasis, every `[`, which could open a link, a `<` that could
 * open a tag, an autolink or an email autolink, and a `&` that starts an entity. Characters are read as whole code
 * points.
 */
export function escapeText(text: string): string {
  let written = '';
  let from = 0;
  for (const match of text.matchAll(SPECIAL)) {
    const at = match.index ?? 0;
    const char = match[0];
    const before = charBefore(text, at);
    const after = charAt(text, at + 1);
    let escape = false;
    if (char === '`' || char === '[') escape = true;
    else if (char === '\\') escape = after === undefined || ESCAPABLE.test(after);
    else if (char === '*') escape = !(before !== undefined && SPACE.test(before) && after !== undefined && SPACE.test(after));
    else if (char === '_') {
      escape = !(before !== undefined && after !== undefined && ((WORD.test(before) && WORD.test(after)) || (SPACE.test(before) && SPACE.test(after))));
    } else if (char === '~') escape = before === undefined || after === undefined || before === '~' || after === '~';
    else if (char === '<') escape = after !== undefined && TAG_START.test(after);
    else if (char === '&') escape = ENTITY.test(text.slice(at, at + 40));
    if (escape) {
      written += `${text.slice(from, at)}\\${char}`;
      from = at + 1;
    }
  }
  return written + text.slice(from);
}

/** A code span around its text: a fence of backticks longer than any run inside it, and a space each side where needed. */
function codeSpan(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Writes a line's runs: bold, italic, struck words and code around the escaped text. The marks a run opens go in the
 * order of how long each runs on, the longest first, so an outer mark never closes inside an inner one; where two runs
 * still cross, the white space a run starts with is written before the delimiter, which cannot open before white space.
 */
export function writeInline(runs: readonly MarkedRun[]): string {
  let line = '';
  const open: RunMark[] = [];
  const closeFrom = (keep: number): void => {
    while (open.length > keep) line += DELIMITER[open.pop() ?? 'bold'];
  };
  const spans = expelSpaces(runs);
  const runLength = (from: number, mark: RunMark): number => {
    let end = from;
    while (spans[end]?.code === false && spans[end]?.[mark] === true) end += 1;
    return end - from;
  };
  spans.forEach((span, place) => {
    if (span.code) {
      closeFrom(0);
      line += codeSpan(span.text);
      return;
    }
    const wanted = MARKS.filter((mark) => span[mark]);
    let keep = 0;
    while (keep < open.length && wanted.includes(open[keep] ?? 'bold')) keep += 1;
    closeFrom(keep);
    const fresh = wanted.filter((mark) => !open.includes(mark)).sort((a, b) => runLength(place, b) - runLength(place, a));
    let text = span.text;
    if (fresh.length > 0) {
      const lead = /^\s+/u.exec(text)?.[0] ?? '';
      line += lead;
      text = text.slice(lead.length);
    }
    for (const mark of fresh) {
      open.push(mark);
      line += DELIMITER[mark];
    }
    line += escapeText(text);
  });
  closeFrom(0);
  return line;
}

/**
 * A written line of words with a backslash before the character that would make it start a block: a heading's hash, a
 * bullet, a number's full stop or bracket, a quote's mark, a divider's first character, and, for a paragraph's line,
 * the first of a line of equals signs or of dashes (a heading's underline in CommonMark) and a table separator's first
 * character; and before a checklist's box at the start of a list item's words.
 *
 * @param line - The line as `writeInline` wrote it.
 * @param inItem - Whether the line is a list item's words, after its marker.
 */
export function escapeStart(line: string, inItem: boolean): string {
  const at = (index: number): string => `${line.slice(0, index)}\\${line.slice(index)}`;
  const lead = /^ */.exec(line)?.[0].length ?? 0;
  if (HEADING.test(line) || DIVIDER.test(line) || QUOTE.test(line) || BULLET.test(line)) return at(lead);
  const ordered = ORDERED.exec(line);
  if (ordered !== null) return at(lead + (ordered[2]?.length ?? 0));
  if (inItem && /^\[[ xX]\](?: |$)/.test(line)) return at(0);
  if (!inItem && SETEXT.test(line)) return at(lead);
  if (!inItem && line.includes('|') && TABLE_SEPARATOR.test(line)) return at(lead);
  return line;
}

/**
 * A heading's line: its hashes, a space, then its words as `writeInline` wrote them, with a backslash before a run of
 * hashes that ends them after a space or is all of them, so `Version #` keeps its hash where CommonMark would read it
 * as the closing sequence. The profile reads the hash after the backslash as itself.
 *
 * @param level - The heading's level, one to three.
 * @param words - The heading's words as `writeInline` wrote them.
 */
export function writeHeading(level: number, words: string): string {
  const closing = CLOSING_HASHES.exec(words);
  const hashes = closing?.[1];
  if (closing === null || hashes === undefined) return `${'#'.repeat(level)} ${words}`;
  const at = words.length - closing[0].length + closing[0].indexOf(hashes);
  return `${'#'.repeat(level)} ${words.slice(0, at)}\\${words.slice(at)}`;
}

/**
 * A code block's lines: a fence longer than any run of backticks a line starts with, up to three spaces in, since such
 * a run closes a fence in CommonMark; then the language, the code and the fence.
 */
export function writeCodeBlock(code: readonly string[], language: string): string[] {
  let longest = 2;
  for (const line of code) {
    let start = 0;
    while (start < 3 && line[start] === ' ') start += 1;
    let run = 0;
    while (line[start + run] === '`') run += 1;
    longest = Math.max(longest, run);
  }
  const fence = '`'.repeat(longest + 1);
  return [`${fence}${language}`, ...code.map((line) => (HASH_LINE.test(line) ? ` ${line}` : line)), fence];
}

/** A text's length in code points. */
function width(text: string): number {
  let count = 0;
  for (const _char of text) count += 1;
  return count;
}

/**
 * A table's lines: its first row as the header, a separator line, then the other rows, each a line of cells between
 * bars. A column is padded to its widest cell, up to 40 characters, so the bars line up in plain text, and a separator
 * cell is at least three dashes; a longer cell runs past its column. Each cell is written already: one line, its bars
 * made slashes, its characters escaped.
 *
 * @param rows - The rows' written cells, the header row first; a short row is filled with empty cells.
 * @param columns - How many columns the table has.
 */
export function writeTable(rows: readonly (readonly string[])[], columns: number): string[] {
  const widths = Array.from({ length: columns }, (_, column) => {
    let widest = 3;
    for (const row of rows) widest = Math.max(widest, Math.min(PAD_LIMIT, width(row[column] ?? '')));
    return widest;
  });
  const line = (cells: readonly string[]): string =>
    `| ${widths
      .map((size, column) => {
        const cell = cells[column] ?? '';
        return `${cell}${' '.repeat(Math.max(0, size - width(cell)))}`;
      })
      .join(' | ')} |`;
  const [head = [], ...rest] = rows;
  return [line(head), `| ${widths.map((size) => '-'.repeat(size)).join(' | ')} |`, ...rest.map(line)];
}
