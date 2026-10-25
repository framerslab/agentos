/**
 * The HTML reader in Node, over a stand-in of plain objects that carries only the node properties the reader may walk,
 * through the library's browser entry. The browser test reads the same cases through the page's own DOMParser.
 */
import { describe, expect, it } from 'vitest';

import { readHtml } from '../browser.js';
import { DRAWING_AND_FORMULA, HTML_CASES } from './htmlCases.js';
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

  it("takes no title from a drawing or a formula handed over as the element, since a <title> in one is not the page's", () => {
    const [drawing, formula] = standInDocument(DRAWING_AND_FORMULA).childNodes;
    expect(drawing && readHtml(drawing)).toEqual({ title: null, markdown: 'Sales', images: 0, cut: false });
    expect(formula && readHtml(formula)).toEqual({ title: null, markdown: 'x', images: 0, cut: false });
  });

  it("reads the header and footer of an article handed over as the element, which are the article's own", () => {
    const [article] = standInDocument('<article><header><h2>Day one</h2></header><p>We walked.</p><footer>Filed under travel</footer></article>').childNodes;
    expect(article && readHtml(article)).toEqual({ title: null, markdown: '## Day one\n\nWe walked.\n\nFiled under travel', images: 0, cut: false });
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

  it('cuts words four quotes deep in one pass, not a search at every depth', () => {
    const document = standInDocument(`${'<blockquote>'.repeat(4)}<p>${'word '.repeat(6_000)}</p>${'</blockquote>'.repeat(4)}`);
    const started = performance.now();
    const read = readHtml(document, { maxCharacters: 20_000 });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(read).toMatchObject({ markdown: `> > > > ${'word '.repeat(3_998).trimEnd()}`, cut: true });
  });

  it('writes a quote holding a list of 300,000 items under one, whole and cut', () => {
    const items = '<li>x</li>'.repeat(300_000);
    const document = standInDocument(`<blockquote><ul><li>all<ul>${items}</ul></li></ul><p>after words</p></blockquote>`);
    const whole = readHtml(document);
    expect(whole.cut).toBe(false);
    expect(whole.markdown.split('\n')).toHaveLength(300_003);
    expect(whole.markdown.endsWith('\n>   - x\n>\n> after words')).toBe(true);
    // the list fits whole and the paragraph after it keeps one word
    const cut = readHtml(document, { maxCharacters: whole.markdown.length - 3 });
    expect(cut.cut).toBe(true);
    expect(cut.markdown.length).toBe(whole.markdown.length - ' words'.length);
    expect(cut.markdown.endsWith('\n>   - x\n>\n> after')).toBe(true);
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
