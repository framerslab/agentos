/// <reference lib="dom" />
/**
 * The HTML and CSV readers in a page, in Chromium and in WebKit, through the library's browser entry: every case the
 * Node test reads through its stand-in, parsed here by the page's own DOMParser as a page parses a file a person picked;
 * an XHTML document, whose element names are in lower case; and a sheet.
 */
import { describe, expect, it } from 'vitest';

import { readCsv, readHtml } from '../browser.js';
import { HTML_CASES } from './htmlCases.js';

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
