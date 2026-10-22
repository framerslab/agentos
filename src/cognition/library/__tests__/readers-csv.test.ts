/**
 * The CSV reader, through the library's browser entry: RFC 4180's fields (a quoted field may hold the separator, line
 * breaks and doubled quotes; CRLF ends a record), the separator found on the first line, the bounds, and the cells
 * written so a table of pipe lines reads back as the same words.
 */
import { describe, expect, it } from 'vitest';

import { readCsv } from '../browser.js';

/** Lines joined with line feeds. */
const lines = (...each: string[]): string => each.join('\n');

describe('readCsv', () => {
  it('reads quoted commas, a quoted line break made a space, a quoted bar made a slash, doubled quotes and CRLF', () => {
    const read = readCsv('Name,Note,Count\r\n"Smith, Ana","Line one\r\nline two",3\r\n"Lee ""Jo""","a | b",4\r\n');
    expect(read).toEqual({
      markdown: lines(
        '| Name       | Note              | Count |',
        '| ---------- | ----------------- | ----- |',
        '| Smith, Ana | Line one line two | 3     |',
        '| Lee "Jo"   | a / b             | 4     |',
      ),
      rows: 3,
      columns: 3,
      separator: ',',
      cut: false,
      breaksMadeSpaces: true,
      empty: false,
    });
  });

  it('reads a first line of semicolons and no comma with the semicolon, though a later line holds a comma', () => {
    const read = readCsv('Datum;Betrag\n01.02.2026;12,50\n');
    expect(read.separator).toBe(';');
    expect(read.markdown).toBe(lines('| Datum      | Betrag |', '| ---------- | ------ |', '| 01.02.2026 | 12,50  |'));
    expect(read.breaksMadeSpaces).toBe(false);
  });

  it('reads tabs, found on the first line or named, and drops a byte order mark', () => {
    const table = lines('| a   | b   |', '| --- | --- |', '| 1   | 2   |');
    const found = readCsv('\uFEFFa\tb\n1\t2\n');
    expect(found.separator).toBe('\t');
    expect(found.markdown).toBe(table);
    expect(readCsv('a\tb\n1\t2', { separator: '\t' }).markdown).toBe(table);
  });

  it('cuts a sheet of 600 rows at 500, its header row among them', () => {
    const sheet = ['n', ...Array.from({ length: 599 }, (_, index) => String(index + 1))].join('\n');
    const read = readCsv(sheet, { maxRows: 500 });
    const written = read.markdown.split('\n');
    expect(read).toMatchObject({ rows: 500, columns: 1, cut: true, empty: false });
    expect(written).toHaveLength(501);
    expect(written.slice(0, 3)).toEqual(['| n   |', '| --- |', '| 1   |']);
    expect(written.at(-1)).toBe('| 499 |');
  });

  it('holds the table a note holds unless told otherwise: 500 rows, 30 columns, a column padded to 40 characters at most', () => {
    const wide = Array.from({ length: 31 }, (_, index) => `c${index + 1}`).join(',');
    const sheet = [wide, ...Array.from({ length: 500 }, (_, index) => String(index + 1))].join('\n');
    expect(readCsv(sheet)).toMatchObject({ rows: 500, columns: 30, cut: true });
    expect(readCsv(`Note\n${'x'.repeat(50)}\ny\n`).markdown).toBe(
      lines(`| ${'Note'.padEnd(40)} |`, `| ${'-'.repeat(40)} |`, `| ${'x'.repeat(50)} |`, `| ${'y'.padEnd(40)} |`),
    );
  });

  it('answers empty for a text with no row', () => {
    const none = { markdown: '', rows: 0, columns: 0, separator: ',', cut: false, breaksMadeSpaces: false, empty: true };
    expect(readCsv('')).toEqual(none);
    expect(readCsv('\r\n\n')).toEqual(none);
  });

  it('reads a text of one header row as a table of one row', () => {
    expect(readCsv('Title,Owner')).toMatchObject({ markdown: lines('| Title | Owner |', '| ----- | ----- |'), rows: 1, columns: 2, cut: false });
  });

  it('fills a short row with empty cells, and cuts the columns past maxColumns', () => {
    expect(readCsv('a,b\n1,2,3\n')).toMatchObject({
      markdown: lines('| a   | b   |     |', '| --- | --- | --- |', '| 1   | 2   | 3   |'),
      columns: 3,
      cut: false,
    });
    expect(readCsv('a,b\n1,2,3\n', { maxColumns: 2 })).toMatchObject({
      markdown: lines('| a   | b   |', '| --- | --- |', '| 1   | 2   |'),
      columns: 2,
      cut: true,
    });
  });

  it('escapes the characters of a cell that would read as a mark', () => {
    expect(readCsv('Formula,Note\n2*3,`code`\n').markdown).toBe(
      lines('| Formula | Note     |', '| ------- | -------- |', '| 2\\*3    | \\`code\\` |'),
    );
  });

  it('keeps a quote inside an unquoted field and the words after a closing quote, and skips a blank line', () => {
    expect(readCsv('Size,Part\n5" bolt,"x"y\n\n"",z\n')).toMatchObject({
      markdown: lines('| Size    | Part |', '| ------- | ---- |', '| 5" bolt | xy   |', '|         | z    |'),
      rows: 3,
    });
  });

  it('refuses a bound that is no count and a separator it does not read', () => {
    expect(() => readCsv('a', { maxRows: -1 })).toThrow(RangeError);
    expect(() => readCsv('a', { maxColumns: Number.NaN })).toThrow(RangeError);
    expect(() => readCsv('a', { separator: '|' as unknown as ',' })).toThrow(RangeError);
  });
});
