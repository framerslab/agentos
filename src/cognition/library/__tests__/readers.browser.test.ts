/// <reference lib="dom" />
/**
 * The HTML and CSV readers in a page, in Chromium and in WebKit, through the library's browser entry: every case the
 * Node test reads through its stand-in, parsed here by the page's own DOMParser as a page parses a file a person picked;
 * an XHTML document, whose element names are in lower case; and a sheet.
 */
import { describe, expect, it } from 'vitest';

import { readCsv, readHtml } from '../browser.js';
import { DRAWING_AND_FORMULA, HTML_CASES } from './htmlCases.js';

describe("readHtml over the page's DOMParser", () => {
  for (const page of HTML_CASES) {
    it(page.name, () => {
      const document = new DOMParser().parseFromString(page.html, 'text/html');
      expect(readHtml(document, page.options)).toEqual({
        title: page.title,
        markdown: page.markdown,
        images: page.images,
        cut: page.cut,
      });
    });
  }

  it('reads an XHTML document, whose element names are in lower case', () => {
    const document = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Kept</title></head><body><h2>Plan</h2><p>Go <b>now</b>.</p></body></html>',
      'application/xhtml+xml',
    );
    expect(readHtml(document)).toEqual({ title: 'Kept', markdown: '## Plan\n\nGo **now**.', images: 0, cut: false });
  });

  it("takes no title from a drawing or a formula handed over as the element, since a <title> in one is not the page's", () => {
    const [drawing, formula] = Array.from(new DOMParser().parseFromString(DRAWING_AND_FORMULA, 'text/html').body.children);
    expect(drawing && readHtml(drawing)).toEqual({ title: null, markdown: 'Sales', images: 0, cut: false });
    expect(formula && readHtml(formula)).toEqual({ title: null, markdown: 'x', images: 0, cut: false });
  });

  it('writes a quote holding a list of 100,000 items under one', () => {
    const items = '<li>x</li>'.repeat(100_000);
    const document = new DOMParser().parseFromString(`<blockquote><ul><li>all<ul>${items}</ul></li></ul></blockquote>`, 'text/html');
    const read = readHtml(document);
    expect(read.markdown.split('\n')).toHaveLength(100_001);
    expect(read.markdown.endsWith('\n>   - x')).toBe(true);
  });
});

describe('readCsv in a page', () => {
  it('reads a sheet with quoted commas and a quoted line break into one table', () => {
    expect(readCsv('Name,Note\r\n"Smith, Ana","Line one\r\nline two"\r\n')).toEqual({
      markdown: ['| Name       | Note              |', '| ---------- | ----------------- |', '| Smith, Ana | Line one line two |'].join('\n'),
      rows: 2,
      columns: 2,
      separator: ',',
      cut: false,
      breaksMadeSpaces: true,
      empty: false,
    });
  });
});
