/**
 * The HTML reader in Node, over a stand-in of plain objects that carries only the node properties the reader may walk,
 * through the library's browser entry. The browser test reads the same cases through the page's own DOMParser.
 */
import { describe, expect, it } from 'vitest';

import { readHtml } from '../browser.js';
import { HTML_CASES } from './htmlCases.js';
import { standInDocument } from './htmlStandIn.js';

describe('readHtml over a stand-in of the DOM', () => {
  for (const page of HTML_CASES) {
    it(page.name, () => {
      expect(readHtml(standInDocument(page.html), page.options)).toEqual({
        title: page.title,
        markdown: page.markdown,
        images: page.images,
        cut: page.cut,
      });
    });
  }

  it('reads what an element holds as it reads a document', () => {
    const document = standInDocument('<section><h2>Inside</h2><p>Kept.</p></section><p>Outside.</p>');
    const section = document.childNodes[0];
    expect(section && readHtml(section)).toEqual({ title: null, markdown: '## Inside\n\nKept.', images: 0, cut: false });
  });

  it('keeps a table to 500 rows and 30 columns unless told otherwise', () => {
    const row = (cells: string[]): string => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
    const head = row(Array.from({ length: 31 }, (_, index) => `c${index + 1}`));
    const body = Array.from({ length: 500 }, (_, index) => row([String(index + 1)])).join('');
    const read = readHtml(standInDocument(`<table>${head}${body}</table>`));
    const written = read.markdown.split('\n');
    expect(read.cut).toBe(true);
    expect(written).toHaveLength(501);
    expect(written[0]?.split(' | ')).toHaveLength(30);
    expect(written.at(-1)).toMatch(/^\| 499 \|/);
  });

  it('cuts a paragraph of four million characters to a short bound without writing all of it', () => {
    const document = standInDocument(`<p>${'word '.repeat(800_000)}</p>`);
    const started = performance.now();
    const read = readHtml(document, { maxCharacters: 24 });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(read).toMatchObject({ markdown: 'word word word word word', cut: true });
  });

  it('refuses a maxCharacters that is no count', () => {
    const document = standInDocument('<p>Words.</p>');
    for (const maxCharacters of [-1, Number.NaN, '5' as unknown as number, null as unknown as number]) {
      expect(() => readHtml(document, { maxCharacters })).toThrow(RangeError);
    }
  });

  it('refuses a table bound that is no count', () => {
    const document = standInDocument('<p>Words.</p>');
    expect(() => readHtml(document, { maxTableRows: -1 })).toThrow(RangeError);
    expect(() => readHtml(document, { maxTableColumns: Number.NaN })).toThrow(RangeError);
  });
});
