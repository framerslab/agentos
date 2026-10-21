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

  it('refuses a maxCharacters that is no count', () => {
    const document = standInDocument('<p>Words.</p>');
    for (const maxCharacters of [-1, Number.NaN, '5' as unknown as number, null as unknown as number]) {
      expect(() => readHtml(document, { maxCharacters })).toThrow(RangeError);
    }
  });
});
