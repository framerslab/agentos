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

/** A heading line: up to three spaces, one to three hashes, then a space and its words, or nothing. */
const HEADING = /^( {0,3})(#{1,3})(?: (.*))?$/;

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

/** A table's separator line: cells of dashes, a colon at either end allowed, between bars. */
const TABLE_SEPARATOR = /^ {0,3}\|?(?:[ \t]*:?-+:?[ \t]*\|)*[ \t]*:?-+:?[ \t]*\|?[ \t]*$/;

/** The characters a backslash escapes: every ASCII punctuation character, as CommonMark has it. */
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/** A Unicode white space character, which ends a mark's run at its side. */
const SPACE = /\s/u;

/** A Unicode punctuation or symbol character, which the rules for a mark's delimiters read. */
const PUNCTUATION = /[\p{P}\p{S}]/u;

/** The three marks a run can carry beside code. */
type RunMark = 'bold' | 'italic' | 'strike';

/** The three marks, in the order the writer opens the delimiters of runs that end together. */
const MARKS: readonly RunMark[] = ['bold', 'italic', 'strike'];

/** The delimiters of the three marks. */
const DELIMITER = { bold: '**', italic: '*', strike: '~~' } as const;

/** The most characters a table pads a column to; a longer cell runs past its column. */
const PAD_LIMIT = 40;

/** True for a character a delimiter can stand beside on its far side: one neither white space nor punctuation. */
function wordChar(cell: MarkedRun | undefined): boolean {
  return cell !== undefined && !cell.code && !SPACE.test(cell.text) && !PUNCTUATION.test(cell.text);
}

/**
 * The runs with the white space at either edge of a bold, italic or struck run moved outside the mark, since a mark's
 * delimiters cannot stand beside a space, and the punctuation at an edge moved outside it where a letter or a digit
 * stands beyond that edge, as CommonMark's flanking rules need; then merged with their like.
 */
function expelSpaces(runs: readonly MarkedRun[]): MarkedRun[] {
  const cells: MarkedRun[] = [];
  for (const run of runs) {
    if (run.code) cells.push({ ...run });
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
        if (cell === undefined || !(SPACE.test(cell.text) || (PUNCTUATION.test(cell.text) && wordChar(cells[first - 1])))) break;
        cell[mark] = false;
      }
      for (let last = end - 1; last >= at; last -= 1) {
        const cell = cells[last];
        if (cell === undefined || cell[mark] !== true) break;
        if (!(SPACE.test(cell.text) || (PUNCTUATION.test(cell.text) && wordChar(cells[last + 1])))) break;
        cell[mark] = false;
      }
      at = end;
    }
  }
  const merged: MarkedRun[] = [];
  for (const cell of cells) {
    const last = merged[merged.length - 1];
    if (last !== undefined && !last.code && !cell.code && MARKS.every((mark) => last[mark] === cell[mark])) last.text += cell.text;
    else merged.push(cell);
  }
  return merged;
}

/**
 * A run's characters with the escapes that keep them text: every backtick, a backslash before a punctuation character
 * or at the run's end, a star unless a space stands at each side of it inside the run, and a tilde beside another
 * tilde or at either end of the run, where it could join a struck run's two.
 */
export function escapeText(text: string): string {
  const chars = Array.from(text);
  return chars
    .map((char, at) => {
      const before = chars[at - 1];
      const after = chars[at + 1];
      if (char === '`') return '\\`';
      if (char === '\\' && (after === undefined || ESCAPABLE.test(after))) return '\\\\';
      if (char === '*' && !(before !== undefined && SPACE.test(before) && after !== undefined && SPACE.test(after))) return '\\*';
      if (char === '~' && (before === undefined || after === undefined || before === '~' || after === '~')) return '\\~';
      return char;
    })
    .join('');
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
 * a table separator's first character; and before a checklist's box at the start of a list item's words.
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
  if (!inItem && line.includes('|') && TABLE_SEPARATOR.test(line)) return at(lead);
  return line;
}

/** A code block's lines: a fence longer than any run of backticks a line starts with, the language, the code, the fence. */
export function writeCodeBlock(code: readonly string[], language: string): string[] {
  let longest = 2;
  for (const line of code) {
    let run = 0;
    while (line[run] === '`') run += 1;
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
