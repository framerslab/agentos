/**
 * @fileoverview Tests for OfficeLoader: each format read by the real
 * officeparser from a file written in the test, the bounds a document is
 * refused past, and a scanned page read by OCR.
 *
 * The OCR case runs tesseract.js, whose worker fetches its English data from
 * its own address the first time it starts, so that case needs the network.
 *
 * @module memory/ingestion/__tests__/OfficeLoader.test
 */

import { describe, expect, it, vi } from 'vitest';

import { DocumentTooLargeError } from '../DocxLoader.js';
import { OFFICE_TYPES, OfficeLoader, ScannedDocumentError } from '../OfficeLoader.js';
import {
  epubOf,
  odpOf,
  odsOf,
  odtOf,
  pptxOf,
  rtfOf,
  scannedPdf,
  xlsxOf,
  xlsxOfCells,
} from './fixtures/officeFiles.js';

const SENTENCE = 'The rooms are held until the twentieth.';

describe('OfficeLoader', () => {
  it.each([
    ['pptx', pptxOf],
    ['xlsx', xlsxOf],
    ['odt', odtOf],
    ['ods', odsOf],
    ['odp', odpOf],
    ['rtf', rtfOf],
    ['epub', epubOf],
  ] as const)('reads a .%s file in memory', async (format, build) => {
    const loaded = await new OfficeLoader().load(Buffer.from(await build(SENTENCE)), { format });
    expect(loaded.format).toBe(format);
    expect(loaded.content.replace(/\s+/g, ' ')).toContain(SENTENCE);
  });

  it('names the extensions it reads and reads no path', () => {
    expect(new OfficeLoader().supportedExtensions).toEqual(Object.keys(OFFICE_TYPES));
    expect(new OfficeLoader().canLoad('slides.pptx')).toBe(true);
    expect(new OfficeLoader().canLoad('notes.docx')).toBe(false);
  });

  it('refuses an archive that inflates past the bound, before reading its text', async () => {
    const big = xlsxOf(SENTENCE.repeat(40_000));
    await expect(new OfficeLoader({ maxInflatedBytes: 65_536 }).load(big, { format: 'xlsx' })).rejects.toBeInstanceOf(
      DocumentTooLargeError,
    );
  });

  it('refuses an OpenDocument file past the element bound before reading its XML', async () => {
    const many = await odtOf(Array.from({ length: 2_000 }, () => SENTENCE).join('\n\n'));
    await expect(new OfficeLoader({ maxXmlElements: 1_000 }).load(many, { format: 'odt' })).rejects.toBeInstanceOf(
      DocumentTooLargeError,
    );
  });

  it('passes the caller bounds to officeparser and refuses a document it only warned of', async () => {
    const warned = vi.fn(async (_input: Buffer, config: Record<string, unknown>) => {
      (config.onWarning as (issue: { code: string }) => void)({ code: 'TABLE_CELL_LIMIT_EXCEEDED' });
      return { to: async () => ({ value: SENTENCE }), metadata: {} };
    });
    const loader = new OfficeLoader({
      maxInflatedBytes: 1_000_000,
      maxXmlElements: 5_000,
      maxTableCells: 2_000,
      parse: warned,
    });
    const file = Buffer.from('x');
    await expect(loader.load(file, { format: 'xlsx' })).rejects.toBeInstanceOf(DocumentTooLargeError);
    // officeparser allows a document one more table cell for each of its bytes,
    // which the loader takes back out of the bound it passes: one byte here.
    expect(warned).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({
        decompressionLimits: {
          maxUncompressedBytes: 1_000_000,
          maxXmlElements: 5_000,
          maxTableCells: 2_000 - file.length,
        },
      }),
    );
  });

  it('holds a sheet to the cell bound itself, though officeparser allows a cell more for each byte of the file', async () => {
    const sheet = xlsxOfCells(40);
    const loaded = await new OfficeLoader({ maxTableCells: 40 }).load(sheet, { format: 'xlsx' });
    expect(loaded.format).toBe('xlsx');
    // One cell under the sheet's forty. Without the allowance taken out, each
    // byte of the file would add a cell to the bound, and the sheet would be read.
    const refused = new OfficeLoader({ maxTableCells: 39 }).load(sheet, { format: 'xlsx' });
    await expect(refused).rejects.toBeInstanceOf(DocumentTooLargeError);
    await expect(refused).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
  });

  it('refuses, when it is built, an option that would not hold a read to what it says', () => {
    // NaN and Infinity bound nothing: officeparser reads past neither.
    expect(() => new OfficeLoader({ maxXmlElements: Number.NaN })).toThrow(RangeError);
    expect(() => new OfficeLoader({ maxTableCells: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    // For a bound on inflation it cannot use, officeparser takes its own 512 MB.
    expect(() => new OfficeLoader({ maxInflatedBytes: -1 })).toThrow(RangeError);
    // A page range officeparser cannot parse ("1-1.5") is read as every page.
    expect(() => new OfficeLoader({ ocrPages: 1.5 })).toThrow(RangeError);
    // A heap too small for Node to start is replaced by officeparser's 1,024 MB.
    expect(() => new OfficeLoader({ pdfProcessMemoryMb: 32 })).toThrow(RangeError);
  });

  it('refuses a PDF while OCR is off', async () => {
    await expect(new OfficeLoader().load(scannedPdf(), { format: 'pdf' })).rejects.toBeInstanceOf(
      ScannedDocumentError,
    );
  });

  it('asks officeparser for OCR over the pages allowed, with the caller signal and memory cap', async () => {
    const written = vi.fn(async (_format: 'text', _config?: Record<string, unknown>) => ({ value: 'Tesseract.js' }));
    const parse = vi.fn(async () => ({ to: written, metadata: { pages: 1 } }));
    const controller = new AbortController();
    const loader = new OfficeLoader({ ocrPages: 3, pdfProcessMemoryMb: 256, signal: controller.signal, parse });
    const loaded = await loader.load(scannedPdf(), { format: 'pdf' });
    expect(parse).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({
        fileType: 'pdf',
        ocr: true,
        extractAttachments: true,
        abortSignal: controller.signal,
        pdfParserConfig: expect.objectContaining({ pageRange: '1-3', processMemoryMb: 256 }),
      }),
    );
    // Written as text, a picture is a line naming it unless the text recognized in it is asked for.
    expect(written).toHaveBeenCalledWith('text', expect.objectContaining({ includeImages: 'ocr-text-only' }));
    expect(loaded).toMatchObject({ content: 'Tesseract.js', format: 'pdf', metadata: { pageCount: 1, wordCount: 1 } });
  });

  it('reads the scanned page by OCR', async () => {
    const loaded = await new OfficeLoader({ ocrPages: 1 }).load(scannedPdf(), { format: 'pdf' });
    expect(loaded.content).toMatch(/Tesseract/);
    expect(loaded.content).not.toContain('[Image:');
    expect(loaded.metadata.pageCount).toBe(1);
  }, 120_000);

  it('refuses a source given as a path', async () => {
    await expect(new OfficeLoader().load('/tmp/slides.pptx')).rejects.toThrow(/bytes/);
  });
});
