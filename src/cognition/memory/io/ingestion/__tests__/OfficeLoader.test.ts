/**
 * @fileoverview Tests for OfficeLoader: each format read by the real
 * officeparser from a file written in the test, the bounds a document is
 * refused past and the read stopped at, a signal that cancels one read, and a
 * scanned page read by OCR.
 *
 * A worker thread cannot load the TypeScript these tests import, so a scan is
 * read here with officeparser handed to the loader, which reads it in this
 * thread; `officeIsolated.node-esm.test.ts` reads one through the worker thread
 * the loader starts on its own. The OCR case runs tesseract.js, whose worker
 * fetches its English data from its own address the first time it starts, so
 * that case needs the network.
 *
 * @module memory/ingestion/__tests__/OfficeLoader.test
 */

import { describe, expect, it, vi } from 'vitest';

import { DocumentTooLargeError } from '../DocxLoader.js';
import { loadOfficeparser } from '../loadOfficeparser.js';
import { OFFICE_TYPES, OfficeLoader, ScannedDocumentError } from '../OfficeLoader.js';
import {
  epubOf,
  odpOf,
  odsOf,
  odtOf,
  pptxOf,
  rtfOf,
  scannedPdf,
  sparseXlsxOf,
  xlsxOf,
  xlsxOfCells,
} from './fixtures/officeFiles.js';

const SENTENCE = 'The rooms are held until the twentieth.';

/** The warning handler officeparser is handed, as a mocked parse calls it. */
type WarningHandler = (issue: { code: string; details?: unknown }) => void;

/** officeparser's error for a read its signal ended, as it throws one. */
function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

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
    const refused = new OfficeLoader({ maxInflatedBytes: 65_536 }).load(big, { format: 'xlsx' });
    await expect(refused).rejects.toBeInstanceOf(DocumentTooLargeError);
    await expect(refused).rejects.toMatchObject({
      limit: 65_536,
      cause: { message: 'officeparser: ZIP_SIZE_LIMIT_EXCEEDED' },
    });
  });

  it('refuses an OpenDocument file past the element bound before reading its XML', async () => {
    const many = await odtOf(Array.from({ length: 2_000 }, () => SENTENCE).join('\n\n'));
    const refused = new OfficeLoader({ maxXmlElements: 1_000 }).load(many, { format: 'odt' });
    await expect(refused).rejects.toBeInstanceOf(DocumentTooLargeError);
    // The error carries the loader's bound on inflation, 64 MiB when left out,
    // whichever bound was reached; its cause names that one.
    await expect(refused).rejects.toMatchObject({
      limit: 67_108_864,
      cause: { message: 'officeparser: XML_ELEMENT_LIMIT_EXCEEDED' },
    });
  });

  it('passes the caller bounds to officeparser, and stops the read at a bound it only warns of, writing no text', async () => {
    let handed: AbortSignal | undefined;
    const written = vi.fn(async () => ({ value: SENTENCE }));
    const warned = vi.fn(async (_input: Buffer, config: Record<string, unknown>) => {
      handed = config.abortSignal as AbortSignal;
      (config.onWarning as WarningHandler)({ code: 'TABLE_CELL_LIMIT_EXCEEDED' });
      return { to: written, metadata: {} };
    });
    const loader = new OfficeLoader({
      maxInflatedBytes: 1_000_000,
      maxXmlElements: 5_000,
      maxTableCells: 2_000,
      parse: warned,
    });
    const file = Buffer.from('x');
    await expect(loader.load(file, { format: 'xlsx' })).rejects.toMatchObject({
      code: 'DOCUMENT_TOO_LARGE',
      cause: { message: 'officeparser: TABLE_CELL_LIMIT_EXCEEDED' },
    });
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
    // The warning aborted the signal officeparser checks between its steps, and
    // the text of a document the loader refuses was never written.
    expect(handed?.aborted).toBe(true);
    expect(written).not.toHaveBeenCalled();
  });

  it('holds a sheet to the cell bound itself, though officeparser allows a cell more for each byte of the file', async () => {
    const sheet = xlsxOfCells(40);
    const loaded = await new OfficeLoader({ maxTableCells: 40 }).load(sheet, { format: 'xlsx' });
    expect(loaded.format).toBe('xlsx');
    // One cell under the sheet's forty. Without the allowance taken out, each
    // byte of the file would add a cell to the bound, and the sheet would be read.
    const refused = new OfficeLoader({ maxTableCells: 39 }).load(sheet, { format: 'xlsx' });
    await expect(refused).rejects.toBeInstanceOf(DocumentTooLargeError);
    await expect(refused).rejects.toMatchObject({
      code: 'DOCUMENT_TOO_LARGE',
      cause: { message: 'officeparser: TABLE_CELL_LIMIT_EXCEEDED' },
    });
  });

  it('refuses a sheet whose two far-apart cells officeparser lays out closer to write it as text', async () => {
    // The grid from A1 to XFD1048576 is past every position officeparser
    // fills, a bound it reports while the text is written, not while it parses.
    const refused = new OfficeLoader().load(sparseXlsxOf(SENTENCE), { format: 'xlsx' });
    await expect(refused).rejects.toBeInstanceOf(DocumentTooLargeError);
    await expect(refused).rejects.toMatchObject({ cause: { message: 'officeparser: TABLE_GRID_LIMIT_EXCEEDED' } });
  });

  it('refuses a document the text writer lists past a bound among its messages', async () => {
    const parse = vi.fn(async () => ({
      to: async () => ({ value: SENTENCE, messages: [{ type: 'warning', code: 'TABLE_GRID_LIMIT_EXCEEDED' }] }),
      metadata: {},
    }));
    const refused = new OfficeLoader({ parse }).load(Buffer.from('x'), { format: 'xlsx' });
    await expect(refused).rejects.toMatchObject({
      code: 'DOCUMENT_TOO_LARGE',
      cause: { message: 'officeparser: TABLE_GRID_LIMIT_EXCEEDED' },
    });
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

  it('cancels the one read its signal is given to, and the loader reads on', async () => {
    const loader = new OfficeLoader();
    const cancelled = AbortSignal.abort();
    await expect(loader.load(xlsxOf(SENTENCE), { format: 'xlsx', signal: cancelled })).rejects.toBe(cancelled.reason);
    // The signal was the read's, not the loader's: the next read, given none, is read.
    const loaded = await loader.load(xlsxOf(SENTENCE), { format: 'xlsx' });
    expect(loaded.content).toContain(SENTENCE);
  });

  it('rejects a read its caller cancels while it runs with the reason the signal gives', async () => {
    const controller = new AbortController();
    const withdrawn = new Error('the upload was withdrawn');
    let handed: AbortSignal | undefined;
    const parse = vi.fn(async (_input: Buffer, config: Record<string, unknown>) => {
      handed = config.abortSignal as AbortSignal;
      controller.abort(withdrawn);
      // officeparser throws its own error at its next check of the signal it was handed.
      throw abortError();
    });
    const refused = new OfficeLoader({ parse }).load(xlsxOf(SENTENCE), { format: 'xlsx', signal: controller.signal });
    await expect(refused).rejects.toBe(withdrawn);
    expect(handed?.aborted).toBe(true);
  });

  it('refuses a PDF while OCR is off', async () => {
    await expect(new OfficeLoader().load(scannedPdf(), { format: 'pdf' })).rejects.toBeInstanceOf(
      ScannedDocumentError,
    );
  });

  it("asks officeparser for OCR over the pages allowed, under the caller's signal and the memory cap", async () => {
    let handed: AbortSignal | undefined;
    const written = vi.fn(async (_format: 'text', _config?: Record<string, unknown>) => ({ value: 'Tesseract.js' }));
    const parse = vi.fn(async (_input: Buffer, config: Record<string, unknown>) => {
      handed = config.abortSignal as AbortSignal;
      return { to: written, metadata: { pages: 1 } };
    });
    const controller = new AbortController();
    const loader = new OfficeLoader({ ocrPages: 3, pdfProcessMemoryMb: 256, parse });
    const loaded = await loader.load(scannedPdf(), { format: 'pdf', signal: controller.signal });
    expect(parse).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({
        fileType: 'pdf',
        ocr: true,
        extractAttachments: true,
        pdfParserConfig: expect.objectContaining({ pageRange: '1-3', processMemoryMb: 256 }),
      }),
    );
    // Written as text, a picture is a line naming it unless the text recognized in it is asked for.
    expect(written).toHaveBeenCalledWith('text', expect.objectContaining({ includeImages: 'ocr-text-only' }));
    expect(loaded).toMatchObject({ content: 'Tesseract.js', format: 'pdf', metadata: { pageCount: 1, wordCount: 1 } });
    // The signal officeparser checks follows the caller's.
    expect(handed?.aborted).toBe(false);
    controller.abort();
    expect(handed?.aborted).toBe(true);
  });

  it.each(['PDF_SEPARATE_PROCESS_UNAVAILABLE', 'PDF_WORKER_FALLBACK'])(
    'refuses a scan when officeparser reports %s, before pdf.js reads it outside its memory cap',
    async (code) => {
      let handed: AbortSignal | undefined;
      const parse = vi.fn(async (_input: Buffer, config: Record<string, unknown>) => {
        handed = config.abortSignal as AbortSignal;
        (config.onWarning as WarningHandler)({ code });
        // officeparser checks its signal before pdf.js opens the document.
        throw abortError();
      });
      const refused = new OfficeLoader({ ocrPages: 1, parse }).load(scannedPdf(), { format: 'pdf' });
      await expect(refused).rejects.toThrow(`officeparser: ${code}`);
      expect(handed?.aborted).toBe(true);
    },
  );

  it('refuses a scan in a thread where pdf.js was preloaded, which officeparser would read it with', async () => {
    const parse = vi.fn();
    const scope = globalThis as unknown as { pdfjsWorker?: unknown };
    scope.pdfjsWorker = {};
    try {
      const refused = new OfficeLoader({ ocrPages: 1, parse }).load(scannedPdf(), { format: 'pdf' });
      await expect(refused).rejects.toThrow('globalThis.pdfjsWorker');
    } finally {
      delete scope.pdfjsWorker;
    }
    expect(parse).not.toHaveBeenCalled();
  });

  it('says why OCR read nothing, when officeparser reported a picture it could not read', async () => {
    // officeparser reports each picture OCR could not read as a warning that
    // carries the failure, and reads on: here both of a scan's pictures fail.
    const first = new Error('OCR worker initialization timed out after 60000ms');
    const second = new Error('OCR recognition timed out after 30000ms');
    const parse = vi.fn(async (_input: Buffer, config: Record<string, unknown>) => {
      const warn = config.onWarning as WarningHandler;
      warn({ code: 'OCR_FAILED', details: first });
      warn({ code: 'OCR_FAILED', details: second });
      return { to: async () => ({ value: '' }), metadata: { pages: 2 } };
    });
    const refused = new OfficeLoader({ ocrPages: 2, parse }).load(scannedPdf(), { format: 'pdf' });
    await expect(refused).rejects.toBeInstanceOf(ScannedDocumentError);
    await expect(refused).rejects.toMatchObject({ code: 'SCANNED_DOCUMENT', cause: first });
  });

  it('reads on without a picture OCR could not read, when the scan still gives text', async () => {
    const parse = vi.fn(async (_input: Buffer, config: Record<string, unknown>) => {
      (config.onWarning as WarningHandler)({
        code: 'OCR_FAILED',
        details: new Error('OCR recognition timed out after 30000ms'),
      });
      return { to: async () => ({ value: 'Tesseract.js' }), metadata: { pages: 2 } };
    });
    const loaded = await new OfficeLoader({ ocrPages: 2, parse }).load(scannedPdf(), { format: 'pdf' });
    expect(loaded).toMatchObject({ content: 'Tesseract.js', format: 'pdf', metadata: { pageCount: 2 } });
  });

  it('reads the scanned page by OCR in this thread, with officeparser handed in', async () => {
    const loader = new OfficeLoader({ ocrPages: 1, parse: await loadOfficeparser() });
    const loaded = await loader.load(scannedPdf(), { format: 'pdf' });
    expect(loaded.content).toMatch(/Tesseract/);
    expect(loaded.content).not.toContain('[Image:');
    expect(loaded.metadata.pageCount).toBe(1);
  }, 120_000);

  it('refuses a source given as a path', async () => {
    await expect(new OfficeLoader().load('/tmp/slides.pptx')).rejects.toThrow(/bytes/);
  });
});
