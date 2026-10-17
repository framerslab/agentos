/**
 * @fileoverview OfficeLoader: PowerPoint, Excel, OpenDocument text, sheets and
 * slides, RTF and EPUB documents read in memory through `officeparser`, an
 * optional peer dependency; and a scanned PDF read by OCR over at most
 * `ocrPages` pages when the caller sets it.
 *
 * officeparser inflates the parts of an archive it reads and builds element
 * trees and cell nodes from them, so a small file can ask for far more memory
 * than its size. The loader hands officeparser the caller's bounds on what
 * those parts inflate to, on the XML elements read and on the table cells. At
 * the first bound a read reaches, one officeparser only warns of included, the
 * loader stops the read and refuses the document with
 * {@link DocumentTooLargeError}, before any of its text is written.
 *
 * A scan is read by OCR in a worker thread of its own, through `loadIsolated`'s
 * kind `'scan'`. tesseract.js, which officeparser runs for OCR, throws a
 * failure its worker reports outside the promise of the read; in that thread
 * the failure ends the worker, and the read rejects with it, while the
 * caller's process reads on.
 *
 * This module is the package's entry `@framers/agentos/cognition/memory/office`.
 * Importing it loads no package and no Node built-in: officeparser is imported
 * by the first read, `loadIsolated` by the first scan, and officeparser imports
 * pdf.js and tesseract.js only to read a scan; `DocumentTooLargeError` comes
 * from a module that imports nothing. The memory module's index exports the
 * same names.
 *
 * @module memory/ingestion/OfficeLoader
 */

import type { DocumentMetadata, LoadOptions, LoadedDocument } from '../facade/types.js';
import { DocumentTooLargeError } from './DocumentTooLargeError.js';
import type { IDocumentLoader } from './IDocumentLoader.js';
import { loadOfficeparser } from './loadOfficeparser.js';

// The error this loader throws past a bound, the one DocxLoader throws, so a
// caller of this entry can check for it without importing another.
export { DocumentTooLargeError };

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

/** The extensions this loader reads, each with the file type officeparser is told. */
export const OFFICE_TYPES = {
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
  '.odt': 'odt',
  '.ods': 'ods',
  '.odp': 'odp',
  '.rtf': 'rtf',
  '.epub': 'epub',
} as const;

/** A format this loader reads; `pdf` only by OCR. */
export type OfficeFormat = (typeof OFFICE_TYPES)[keyof typeof OFFICE_TYPES] | 'pdf';

// ---------------------------------------------------------------------------
// Errors and options
// ---------------------------------------------------------------------------

/**
 * Thrown for a PDF asked for while OCR is off, and for a scan whose pages gave
 * no text. For the second, `cause` is the first failure officeparser reported
 * for a picture OCR could not read, when it reported one.
 */
export class ScannedDocumentError extends Error {
  /** A stable code for callers that branch on the kind of failure. */
  readonly code = 'SCANNED_DOCUMENT';

  /**
   * @param message - Which of the two it is.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ScannedDocumentError';
  }
}

/**
 * The part of officeparser this loader calls: its `parseOffice` export, which
 * answers a document that writes itself as text. The text writer's result
 * lists the issues it reported among its `messages`.
 */
export type OfficeParse = (
  input: Buffer,
  config: Record<string, unknown>,
) => Promise<{
  to(format: 'text', config?: Record<string, unknown>): Promise<{ value: unknown; messages?: unknown }>;
  metadata?: { pages?: number };
}>;

/** Options of the office loader. */
export interface OfficeLoaderOptions {
  /**
   * The most the parts officeparser reads from an archive may inflate to,
   * together, counted as they inflate. Default 67,108,864 (64 MiB).
   */
  maxInflatedBytes?: number;
  /**
   * The most XML elements read from a document's parts, an EPUB's chapters
   * included. An `.xlsx` workbook's sheets are read without building
   * elements, and their cells count toward `maxTableCells` alone; an `.ods`
   * file's sheets are XML, and count toward both. officeparser's own default
   * when left out.
   */
  maxXmlElements?: number;
  /**
   * The most cells an `.xlsx` workbook's sheets, and an OpenDocument file's
   * sheets and tables, may hold. officeparser counts no other format's
   * cells: a `.pptx` or `.epub` table's cells are XML elements, which
   * `maxXmlElements` bounds, and none of the loader's three bounds counts an
   * `.rtf` file's. officeparser allows a document one more cell for each
   * byte of its file; the loader takes that allowance out of the limit it
   * passes, so this is the bound itself. officeparser's own default, with
   * its allowance, when left out.
   */
  maxTableCells?: number;
  /** Pages of a scanned PDF read by OCR, from the first: a whole number; 0 refuses a PDF. Default 0. */
  ocrPages?: number;
  /**
   * The heap, in MB, of the separate process pdf.js runs in while a scan is
   * read: 64 or more. Default 256. A scan whose pdf.js would run in the
   * reading thread instead, outside this cap, is refused.
   */
  pdfProcessMemoryMb?: number;
  /**
   * officeparser's `parseOffice`. Given, every read calls it in the thread
   * that calls `load`, a scan read by OCR included. Left out, officeparser is
   * imported on the first read, and a scan is read in a worker thread of its own.
   */
  parse?: OfficeParse;
}

/** Options of one read. */
export interface OfficeLoadOptions extends LoadOptions {
  /**
   * Cancels this read and no other: `load` rejects with the signal's reason.
   * officeparser checks the signal between its steps, so a step that reads
   * one part's markup finishes first; a scan read in a worker thread ends with
   * its worker. A deadline is a signal made for the read:
   * `AbortSignal.timeout(ms)`.
   */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * officeparser's codes for a document past one of its bounds: the first three
 * it throws, the others it reports as warnings and reads on.
 */
const LIMIT_CODES: ReadonlySet<string> = new Set([
  'ZIP_SIZE_LIMIT_EXCEEDED',
  'ZIP_ENTRY_COUNT_LIMIT_EXCEEDED',
  'XML_ELEMENT_LIMIT_EXCEEDED',
  'TABLE_CELL_LIMIT_EXCEEDED',
  'TABLE_GRID_LIMIT_EXCEEDED',
  'REPEATED_CONTENT_LIMIT_EXCEEDED',
  'RAW_CONTENT_LIMIT_EXCEEDED',
  'PDF_CONTENT_LIMIT_EXCEEDED',
]);

/**
 * officeparser's warnings that pdf.js is about to read a PDF in the reading
 * thread, outside the process `pdfProcessMemoryMb` caps: no process could
 * start, or pdf.js's worker file was not found on disk.
 */
const PDF_IN_THREAD_CODES: ReadonlySet<string> = new Set(['PDF_SEPARATE_PROCESS_UNAVAILABLE', 'PDF_WORKER_FALLBACK']);

/** The bound when {@link OfficeLoaderOptions.maxInflatedBytes} is left out: 64 MiB. */
const DEFAULT_MAX_INFLATED_BYTES = 67_108_864;

/** The pdf.js process's heap when {@link OfficeLoaderOptions.pdfProcessMemoryMb} is left out, in MB. */
const DEFAULT_PDF_PROCESS_MEMORY_MB = 256;

/** The smallest heap, in MB, officeparser starts its pdf.js process with. */
const MIN_PDF_PROCESS_MEMORY_MB = 64;

/**
 * The deadline a scan's worker thread is given: the longest delay a Node
 * timer holds, so the caller's signal is the read's deadline, as it is for a
 * read in the caller's thread.
 */
const SCAN_TIMEOUT_MS = 2_147_483_647;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The format a load's hint names.
 *
 * @param hint - `LoadOptions.format`: a format's name, with or without a leading dot, in any case.
 * @throws {Error} When the hint names none of the formats.
 */
function formatOf(hint: string | undefined): OfficeFormat {
  const value = (hint ?? '').replace(/^\./, '').toLowerCase();
  if (value === 'pdf') return 'pdf';
  const found = Object.values(OFFICE_TYPES).find((type) => type === value);
  if (found === undefined) {
    throw new Error(`OfficeLoader: name the format (${Object.values(OFFICE_TYPES).join(', ')} or pdf).`);
  }
  return found;
}

/**
 * The refusal of a document that reached a bound.
 *
 * @param limit - The loader's `maxInflatedBytes`, which the error carries whichever bound was reached.
 * @param code - officeparser's code for the bound reached, which the error's `cause` names.
 */
function tooLarge(limit: number, code: string): DocumentTooLargeError {
  return Object.assign(new DocumentTooLargeError(limit), { cause: new Error(`officeparser: ${code}`) });
}

/**
 * The refusal of a scan whose pdf.js would read it in the reading thread,
 * where `pdfProcessMemoryMb` does not hold it.
 *
 * @param reason - officeparser's warning code, or what else runs pdf.js in this thread.
 */
function pdfInThread(reason: string): Error {
  return new Error(
    `OfficeLoader: pdf.js would read the scan in this thread, outside the process pdfProcessMemoryMb caps (${reason}); the scan was not read.`,
  );
}

/**
 * The codes of the issues officeparser's text writer lists among the messages of its result.
 *
 * @param messages - The result's `messages`.
 */
function codesOf(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((issue: unknown) => {
    const code = (issue as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? [code] : [];
  });
}

// ---------------------------------------------------------------------------
// OfficeLoader
// ---------------------------------------------------------------------------

/**
 * Document loader for PowerPoint (`.pptx`), Excel (`.xlsx`), OpenDocument
 * (`.odt`, `.ods`, `.odp`), RTF (`.rtf`) and EPUB (`.epub`) files, read in
 * memory through officeparser, which is imported on the first read.
 *
 * The loader reads bytes under the format its caller names: it reads no file
 * from a path and does not guess a format from the bytes. The text is the
 * document's as officeparser writes it, without its comments and without its
 * pictures.
 *
 * With {@link OfficeLoaderOptions.ocrPages} above 0, `load(bytes, { format: 'pdf' })`
 * reads a scanned PDF in a worker thread of its own (`loadIsolated`'s kind
 * `'scan'`): officeparser reads the first `ocrPages` pages with pdf.js, in a
 * process of its own capped at `pdfProcessMemoryMb`, and tesseract.js
 * recognizes the text of each picture on them. A picture OCR could not read is
 * left out of the text, and the read goes on. A failure tesseract.js throws
 * outside officeparser's promise ends the worker thread, and the read rejects
 * with it.
 *
 * @implements {IDocumentLoader}
 *
 * @example An uploaded deck, refused past its bounds
 * ```ts
 * const loader = new OfficeLoader({ maxInflatedBytes: 32 * 1024 * 1024, maxXmlElements: 400_000 });
 * try {
 *   const doc = await loader.load(uploadedBuffer, { format: 'pptx', signal: AbortSignal.timeout(30_000) });
 *   console.log(doc.metadata.wordCount);
 * } catch (error) {
 *   if (error instanceof DocumentTooLargeError) {
 *     console.log(error.cause); // names the bound the document reached
 *   }
 * }
 * ```
 *
 * @example A scanned PDF, its first three pages read by OCR
 * ```ts
 * const loader = new OfficeLoader({ ocrPages: 3 });
 * const doc = await loader.load(scanBuffer, { format: 'pdf', signal: AbortSignal.timeout(120_000) });
 * ```
 */
export class OfficeLoader implements IDocumentLoader {
  /** @inheritdoc */
  readonly supportedExtensions: string[] = Object.keys(OFFICE_TYPES);

  /**
   * @param options - The loader's options; with none, an archive is bounded at 64 MiB inflated and a PDF is refused.
   * @throws {RangeError} When a bound is not a positive, finite number, `ocrPages` is not a whole number of 0 or
   *   more, or `pdfProcessMemoryMb` is under 64.
   */
  constructor(private readonly options: OfficeLoaderOptions = {}) {
    for (const name of ['maxInflatedBytes', 'maxXmlElements', 'maxTableCells'] as const) {
      const value = options[name];
      // NaN and Infinity bound nothing: officeparser reads a count past neither, and
      // takes its own 512 MB for a bound on inflation it cannot use.
      if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
        throw new RangeError(`OfficeLoader: ${name} must be a positive, finite number, got ${value}`);
      }
    }
    const { ocrPages, pdfProcessMemoryMb } = options;
    // officeparser reads a page range it cannot parse ("1-2.5", "1-1e+21") as every page.
    if (ocrPages !== undefined && !(Number.isSafeInteger(ocrPages) && ocrPages >= 0)) {
      throw new RangeError(`OfficeLoader: ocrPages must be a whole number of 0 or more, got ${ocrPages}`);
    }
    // officeparser replaces a heap too small for Node to start with its own default of 1,024 MB.
    if (
      pdfProcessMemoryMb !== undefined &&
      !(Number.isFinite(pdfProcessMemoryMb) && pdfProcessMemoryMb >= MIN_PDF_PROCESS_MEMORY_MB)
    ) {
      throw new RangeError(
        `OfficeLoader: pdfProcessMemoryMb must be a finite number of ${MIN_PDF_PROCESS_MEMORY_MB} or more, got ${pdfProcessMemoryMb}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // canLoad
  // -------------------------------------------------------------------------

  /**
   * True for a file name with one of the loader's extensions. A buffer does
   * not say its format, so the answer for one is false; `load` reads it under
   * the format its caller names.
   *
   * @param source - A file name or path, or a document's bytes.
   */
  canLoad(source: string | Buffer): boolean {
    if (Buffer.isBuffer(source)) return false;
    const lower = source.toLowerCase();
    return this.supportedExtensions.some((extension) => lower.endsWith(extension));
  }

  // -------------------------------------------------------------------------
  // load
  // -------------------------------------------------------------------------

  /**
   * Reads a document's bytes under the format its caller names.
   *
   * @param source - The file's bytes. A path is refused: the loader reads no file.
   * @param options - `format` names the document's format: a value of {@link OFFICE_TYPES}, with or without a
   *   leading dot, or `pdf` for a scanned PDF. `signal` cancels this read.
   * @returns The document's text, with `metadata.wordCount`, and `metadata.pageCount` when officeparser reports
   *   a page count.
   * @throws {DocumentTooLargeError} When the document reaches a bound, one officeparser only warns of included.
   *   The error's `limit` is the loader's `maxInflatedBytes` whichever bound was reached, and its `cause` names
   *   the bound by officeparser's code.
   * @throws {ScannedDocumentError} For a PDF while `ocrPages` is 0, and for a scan whose pages gave no text. When
   *   officeparser reported a picture OCR could not read, the first such failure is the error's `cause`.
   * @throws The reason of `options.signal` when the caller aborts it.
   * @throws {Error} When `source` is a path, when `options.format` names none of the formats, when officeparser
   *   is not installed, and when a scan's pdf.js would run in the reading thread; the error a scan's worker
   *   thread ended on, and `loadIsolated`'s refusals of a scan's worker; and officeparser's own error for a file
   *   it cannot read.
   */
  async load(source: string | Buffer, options?: OfficeLoadOptions): Promise<LoadedDocument> {
    if (!Buffer.isBuffer(source)) throw new Error('OfficeLoader reads bytes: pass the file as a Buffer.');
    const format = formatOf(options?.format);
    const ocrPages = this.options.ocrPages ?? 0;
    if (format === 'pdf' && ocrPages === 0) {
      throw new ScannedDocumentError('OfficeLoader reads a PDF only by OCR, and ocrPages is 0.');
    }
    const signal = options?.signal;
    signal?.throwIfAborted();
    const { parse } = this.options;
    if (format === 'pdf' && parse === undefined) return this.readScanInWorker(source, ocrPages, signal);
    return this.read(source, format, parse ?? (await loadOfficeparser()), signal);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Reads a scan by OCR in a worker thread of its own, through `loadIsolated`'s kind `'scan'`, under this loader's
   * bounds and the caller's signal. The worker builds an office loader with officeparser handed in, which reads
   * the scan in that thread.
   *
   * @param source - The scan's bytes.
   * @param ocrPages - The pages read by OCR, 1 or more.
   * @param signal - The caller's signal for this read.
   */
  private async readScanInWorker(
    source: Buffer,
    ocrPages: number,
    signal: AbortSignal | undefined,
  ): Promise<LoadedDocument> {
    const { loadIsolated } = await import('./loadIsolated.js');
    const { maxInflatedBytes, maxXmlElements, maxTableCells, pdfProcessMemoryMb } = this.options;
    return loadIsolated('scan', source, {
      ocrPages,
      maxInflatedBytes,
      maxXmlElements,
      maxTableCells,
      pdfProcessMemoryMb,
      signal,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
  }

  /**
   * Reads a document in the calling thread with officeparser's `parse`. The read stops at the first bound
   * officeparser reaches or warns of, and refuses the document before its text is written; a scan stops where
   * pdf.js would read it in this thread.
   *
   * @param source - The document's bytes.
   * @param format - Its format.
   * @param parse - officeparser's `parseOffice`.
   * @param signal - The caller's signal for this read.
   */
  private async read(
    source: Buffer,
    format: OfficeFormat,
    parse: OfficeParse,
    signal: AbortSignal | undefined,
  ): Promise<LoadedDocument> {
    // pdf.js preloaded in this thread is the one officeparser reads a PDF with, outside any process of its own.
    if (format === 'pdf' && (globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker !== undefined) {
      throw pdfInThread('pdf.js preloaded as globalThis.pdfjsWorker');
    }
    const limit = this.options.maxInflatedBytes ?? DEFAULT_MAX_INFLATED_BYTES;
    const { maxXmlElements, maxTableCells } = this.options;

    // officeparser checks its signal between its steps: this one ends the read at the first bound reached, and
    // with the caller's signal when there is one.
    const stop = new AbortController();
    const abortSignal = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
    // A bound officeparser only warns of refuses the document as a thrown one does. A picture OCR could not read
    // is a warning too, and officeparser reads on without that picture's text: the first such failure is kept,
    // for a scan that gives no text at all.
    const reached: string[] = [];
    const unread: unknown[] = [];
    // Set by the warning handler, so typed as it may end up rather than as it starts.
    let inThread = undefined as string | undefined;
    const config: Record<string, unknown> = {
      fileType: format,
      decompressionLimits: {
        maxUncompressedBytes: limit,
        ...(maxXmlElements === undefined ? {} : { maxXmlElements }),
        // officeparser adds one cell for each byte of the file to the limit it is
        // given, so the file's length is taken out of the caller's bound here.
        ...(maxTableCells === undefined ? {} : { maxTableCells: maxTableCells - source.length }),
      },
      abortSignal,
      ignoreComments: true,
      onWarning: (issue: { code?: unknown; details?: unknown }) => {
        const { code } = issue;
        if (typeof code !== 'string') return;
        if (LIMIT_CODES.has(code)) {
          reached.push(code);
          stop.abort();
        } else if (format === 'pdf' && PDF_IN_THREAD_CODES.has(code)) {
          inThread ??= code;
          stop.abort();
        } else if (code === 'OCR_FAILED' && unread.length === 0) {
          unread.push(issue.details);
        }
      },
    };
    if (format === 'pdf') {
      const ocrPages = this.options.ocrPages ?? 0;
      config.ocr = true;
      // officeparser recognizes text in the pictures it extracts, and in no others.
      config.extractAttachments = true;
      config.pdfParserConfig = {
        pageRange: `1-${ocrPages}`,
        processMemoryMb: this.options.pdfProcessMemoryMb ?? DEFAULT_PDF_PROCESS_MEMORY_MB,
      };
    }

    let text = '';
    let pages: unknown;
    let failed = false;
    let failure: unknown;
    try {
      const parsed = await parse(source, config);
      // A document refused while it was parsed has no text written.
      if (!stop.signal.aborted) {
        // Written as text, a picture is a line naming it by default. Asked for the
        // recognized text alone, a picture read by OCR is its text, and any other
        // picture is left out.
        const written = await parsed.to('text', { includeImages: 'ocr-text-only', abortSignal });
        // The writer reports a bound it reaches to the parse's warning handler and
        // lists it among its result's messages; either refuses the document.
        for (const code of codesOf(written.messages)) {
          if (LIMIT_CODES.has(code)) reached.push(code);
        }
        text = typeof written.value === 'string' ? written.value : '';
        pages = parsed.metadata?.pages;
      }
    } catch (error) {
      failed = true;
      failure = error;
    }
    // A bound reached, or pdf.js about to run here, ended the read: officeparser's
    // abort is this loader's own, and the refusal says why.
    if (reached.length > 0) throw tooLarge(limit, reached[0]);
    if (inThread !== undefined) throw pdfInThread(`officeparser: ${inThread}`);
    if (failed) {
      if (signal?.aborted) throw signal.reason;
      const code = (failure as { officeIssue?: { code?: unknown } } | null)?.officeIssue?.code;
      if (typeof code === 'string' && LIMIT_CODES.has(code)) throw tooLarge(limit, code);
      throw failure;
    }

    const trimmed = text.trim();
    if (format === 'pdf' && trimmed === '') {
      const noText = new ScannedDocumentError('OCR read no text from the scanned pages.');
      // Why the first picture went unread, when officeparser said: a worker that did
      // not start in time, a recognition that failed or ran past its time.
      throw unread.length > 0 ? Object.assign(noText, { cause: unread[0] }) : noText;
    }
    const metadata: DocumentMetadata = {
      wordCount: trimmed === '' ? 0 : trimmed.split(/\s+/).length,
      ...(typeof pages === 'number' ? { pageCount: pages } : {}),
    };
    return { content: text, metadata, format };
  }
}
