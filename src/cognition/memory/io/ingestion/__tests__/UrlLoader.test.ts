/**
 * @fileoverview Tests for {@link UrlLoader} over any loader source, with an
 * injected fetch, and for its existing callers, which pass a
 * {@link LoaderRegistry} and read through the global fetch.
 *
 * @module memory/ingestion/__tests__/UrlLoader.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HtmlLoader } from '../HtmlLoader.js';
import type { IDocumentLoader } from '../IDocumentLoader.js';
import { LoaderRegistry } from '../LoaderRegistry.js';
import { PdfLoader } from '../PdfLoader.js';
import { UrlLoader, type LoaderSource, type UrlLoaderOptions } from '../UrlLoader.js';

/**
 * A one-page PDF 1.4 file that draws `text` in Helvetica: the header, the
 * catalog, the page tree, the page, its content stream and its font, the
 * cross-reference table with each object's byte offset, and the trailer.
 * `text` holds no parenthesis or backslash.
 */
function pdfOf(text: string): Buffer {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let file = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(file.length);
    file += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = file.length;
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) file += `${String(offset).padStart(10, '0')} 00000 n \n`;
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(file, 'latin1');
}

/** A loader source with the HTML and PDF loaders alone, which notes each extension it is asked for. */
function loaderSource(): LoaderSource & { asked: string[] } {
  const asked: string[] = [];
  const html = new HtmlLoader();
  const pdf = new PdfLoader();
  return {
    asked,
    getLoader(extension: string): IDocumentLoader | undefined {
      asked.push(extension);
      return extension === '.html' ? html : extension === '.pdf' ? pdf : undefined;
    },
  };
}

/** A fetch that answers `body` as `contentType` from `finalUrl`, whatever address it is given. */
function answering(finalUrl: string, contentType: string, body: Buffer): NonNullable<UrlLoaderOptions['fetchDocument']> {
  return vi.fn(async () => ({ url: finalUrl, contentType, body }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UrlLoader', () => {
  it('reads an HTML answer of the given fetch, with the final address as its source', async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    const source = loaderSource();
    const fetchDocument = answering(
      'https://pages.test/final',
      'text/html',
      Buffer.from('<html><head><title>Plans</title></head><body><p>The review moved to Thursday.</p></body></html>'),
    );
    const doc = await new UrlLoader(source, { fetchDocument }).load('https://pages.test/start');

    expect(fetchDocument).toHaveBeenCalledWith('https://pages.test/start');
    expect(globalFetch).not.toHaveBeenCalled();
    expect(source.asked).toEqual(['.html']);
    expect(doc.format).toBe('html');
    expect(doc.content).toContain('The review moved to Thursday.');
    expect(doc.metadata).toMatchObject({ title: 'Plans', source: 'https://pages.test/final' });
  });

  it('hands an XHTML answer to the HTML loader, so no tag and no script is kept as text', async () => {
    const source = loaderSource();
    const xhtml =
      '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><body>' +
      '<nav>Home</nav><script>var shown = "from the script";</script><p>Minutes of the review.</p></body></html>';
    const doc = await new UrlLoader(source, {
      fetchDocument: answering('https://pages.test/minutes', 'application/xhtml+xml', Buffer.from(xhtml)),
    }).load('https://pages.test/minutes');

    expect(source.asked).toEqual(['.html']);
    expect(doc.format).toBe('html');
    expect(doc.content).toContain('Minutes of the review.');
    expect(doc.content).not.toContain('<');
    expect(doc.content).not.toContain('from the script');
  });

  it('hands a PDF answer to the PDF loader', async () => {
    const source = loaderSource();
    const doc = await new UrlLoader(source, {
      fetchDocument: answering('https://pages.test/review.pdf', 'application/pdf', pdfOf('The quarterly review moved to Thursday.')),
    }).load('https://pages.test/review');

    expect(source.asked).toEqual(['.pdf']);
    expect(doc.format).toBe('pdf');
    expect(doc.content).toContain('quarterly review moved to Thursday');
    expect(doc.metadata).toMatchObject({ pageCount: 1, source: 'https://pages.test/review.pdf' });
  });

  it('still takes a LoaderRegistry and reads through the global fetch, canLoad unchanged', async () => {
    const loader = new UrlLoader(new LoaderRegistry());
    expect(loader.supportedExtensions).toEqual([]);
    expect(loader.canLoad('https://pages.test/a')).toBe(true);
    expect(loader.canLoad('http://pages.test/a')).toBe(true);
    expect(loader.canLoad('/notes/a.html')).toBe(false);
    expect(loader.canLoad(Buffer.from('https://pages.test/a'))).toBe(false);

    const globalFetch = vi.fn(async () => new Response('<p>Read the old way.</p>', { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', globalFetch);
    const doc = await loader.load('https://pages.test/a');
    expect(globalFetch).toHaveBeenCalledWith('https://pages.test/a');
    expect(doc.content).toBe('Read the old way.');
    expect(doc.metadata.source).toBe('https://pages.test/a');
  });
});
