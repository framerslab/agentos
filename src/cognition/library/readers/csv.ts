/**
 * @fileoverview A CSV or TSV text read into one Markdown table of pipe lines: RFC 4180's fields (a quoted field may hold
 * the separator, line breaks and doubled quotes; a CRLF ends a record), the separator found on the first line when none
 * is named, the first row as the header, and each cell one line. Pure: it imports nothing outside the readers.
 * @module agentos/cognition/library/readers/csv
 */

import { boundOf } from './bounds.js';
import { escapeText, writeTable } from './markdown.js';

/** A separator the CSV reader reads: a comma, a semicolon or a tab. */
export type CsvSeparator = ',' | ';' | '\t';

/** How `readCsv` reads a text. */
export interface ReadCsvOptions {
  /** The separator. Left out, it is found on the text's first line: a tab, else a semicolon with no comma, else a comma. */
  separator?: CsvSeparator;
  /**
   * The most rows the table keeps, its header row among them; the rows past it are left out and `cut` is true. 0, any
   * positive number or `Infinity`; a bound below 0, `NaN` or no number at all is refused with a `RangeError`.
   * @default 500
   */
  maxRows?: number;
  /**
   * The most columns the table keeps; the cells past it are left out and `cut` is true. Bounded as `maxRows` is.
   * @default 30
   */
  maxColumns?: number;
}

/** What `readCsv` answers. */
export interface CsvRead {
  /**
   * One table block: the first row as the header, a separator line, then the rows; a cell is one line, its line breaks
   * made spaces and its bars made slashes, its characters escaped where they would read as a mark. `''` with no row.
   */
  markdown: string;
  /** The rows the table holds, its header row among them. */
  rows: number;
  /** The columns the table holds. */
  columns: number;
  /** The separator the text was read with. */
  separator: CsvSeparator;
  /** True when rows or columns past the bounds were left out. */
  cut: boolean;
  /** True when a line break inside a quoted cell the table holds was made a space. */
  breaksMadeSpaces: boolean;
  /** True for a text with no row. */
  empty: boolean;
}

/** The separators the reader takes. */
const SEPARATORS: readonly string[] = [',', ';', '\t'];

/** A line break inside a field with the spaces and tabs beside it, made one space in a cell. */
const BREAK = /[ \t]*(?:\r\n|\r|\n)[ \t]*/g;

/** The text's first line that holds more than white space, which names the separator when none is given. */
function firstLine(text: string): string {
  let at = 0;
  while (at < text.length) {
    let end = at;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1;
    const line = text.slice(at, end);
    if (line.trim() !== '') return line;
    at = end + 1;
  }
  return '';
}

/** The separator a text's first line names: a tab, else a semicolon with no comma, else a comma. */
function separatorOf(text: string): CsvSeparator {
  const line = firstLine(text);
  if (line.includes('\t')) return '\t';
  if (line.includes(';') && !line.includes(',')) return ';';
  return ',';
}

/** One record as read, and where the next one starts. */
interface CsvRecord {
  fields: string[];
  next: number;
}

/**
 * Reads the record that starts at a place. A field that opens with a quote runs to its closing quote, a doubled quote
 * inside it read as one; any words after the closing quote are kept, as is a quote inside a field that does not open
 * with one. A quote left open runs to the text's end.
 */
function readRecord(text: string, from: number, separator: string): CsvRecord {
  const fields: string[] = [];
  let at = from;
  for (;;) {
    let value = '';
    if (text[at] === '"') {
      at += 1;
      for (;;) {
        const quote = text.indexOf('"', at);
        if (quote < 0) {
          value += text.slice(at);
          at = text.length;
          break;
        }
        value += text.slice(at, quote);
        if (text[quote + 1] === '"') {
          value += '"';
          at = quote + 2;
          continue;
        }
        at = quote + 1;
        break;
      }
    }
    let end = at;
    while (end < text.length && text[end] !== separator && text[end] !== '\n' && text[end] !== '\r') end += 1;
    value += text.slice(at, end);
    fields.push(value);
    at = end;
    if (at < text.length && text[at] === separator) {
      at += 1;
      continue;
    }
    if (text[at] === '\r' && text[at + 1] === '\n') at += 2;
    else if (at < text.length) at += 1;
    return { fields, next: at };
  }
}

/**
 * Reads a CSV or TSV text into one Markdown table. A byte order mark at the start is dropped, a row whose every cell is
 * empty (a blank line among them) is skipped, a short row is filled with empty cells, and the columns after the last
 * that holds a word are left out. A cell is read as one line: a line break inside a quoted cell, with the spaces beside
 * it, is made one space, a bar is made a slash, and the cell's ends are trimmed.
 *
 * @param text - The file's text.
 * @param options - The separator and the bounds.
 * @throws RangeError for a separator other than a comma, a semicolon or a tab, and for a bound below 0, `NaN` or no
 * number at all.
 */
export function readCsv(text: string, options?: ReadCsvOptions): CsvRead {
  if (typeof text !== 'string') throw new TypeError('readCsv: the text must be a string');
  const given = options ?? {};
  if (given.separator !== undefined && !SEPARATORS.includes(given.separator)) {
    throw new RangeError(`readCsv: separator must be ',', ';' or a tab, not ${JSON.stringify(String(given.separator))}`);
  }
  const maxRows = boundOf('readCsv', 'maxRows', given.maxRows, 500, true);
  const maxColumns = boundOf('readCsv', 'maxColumns', given.maxColumns, 30, true);
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const separator = given.separator ?? separatorOf(body);

  const rows: string[][] = [];
  const broken: boolean[][] = [];
  let cut = false;
  let at = 0;
  while (at < body.length) {
    const record = readRecord(body, at, separator);
    at = record.next;
    const cells = record.fields.map((field) => field.replace(BREAK, ' ').trim());
    if (cells.every((cell) => cell === '')) continue;
    if (rows.length >= maxRows) {
      cut = true;
      break;
    }
    rows.push(cells);
    // a break that only edged the cell's words was trimmed away with its spaces, so only one between words counts
    broken.push(record.fields.map((field) => /[\r\n]/.test(field.trim())));
  }

  let wide = 0;
  for (const row of rows) {
    for (let column = row.length - 1; column >= 0; column -= 1) {
      if (row[column] !== '') {
        wide = Math.max(wide, column + 1);
        break;
      }
    }
  }
  const columns = Math.min(wide, maxColumns);
  if (wide > columns) cut = true;

  const breaksMadeSpaces = broken.some((row) => row.slice(0, columns).some((made) => made));

  const markdown =
    rows.length === 0 || columns === 0
      ? ''
      : writeTable(
          rows.map((row) => Array.from({ length: columns }, (_, column) => escapeText((row[column] ?? '').replace(/\|/g, '/')))),
          columns,
        ).join('\n');
  return { markdown, rows: rows.length, columns, separator, cut, breaksMadeSpaces, empty: rows.length === 0 && !cut };
}
