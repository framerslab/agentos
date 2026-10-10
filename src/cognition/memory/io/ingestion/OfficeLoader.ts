/**
 * @fileoverview OfficeLoader: PowerPoint, Excel, OpenDocument text, sheets and
 * slides, RTF and EPUB documents read in memory through `officeparser`, an
 * optional peer dependency; and a scanned PDF read by OCR over at most
 * `ocrPages` pages when the caller sets it.
 *
 * officeparser inflates the parts of an archive it reads and builds element
 * trees and cell nodes from them, so a small file can ask for far more memory
 * than its size. The loader hands officeparser the caller's bounds on what
 * those parts inflate to, on the XML elements read and on the table cells, and
 * refuses a document that reaches a bound, one officeparser only warns of
 * included, with {@link DocumentTooLargeError}.
 *
 * @module memory/ingestion/OfficeLoader
 */

import type { DocumentMetadata, LoadOptions, LoadedDocument } from '../facade/types.js';
import { DocumentTooLargeError } from './DocxLoader.js';
import type { IDocumentLoader } from './IDocumentLoader.js';

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

/** Thrown for a PDF asked for while OCR is off, and for a scan whose pages gave no text. */
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
 * answers a document that writes itself as text.
 */
export type OfficeParse = (
  input: Buffer,
  config: Record<string, unknown>,
) => Promise<{
  to(format: 'text', config?: Record<string, unknown>): Promise<{ value: unknown }>;
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
   * The most XML elements read from a document's parts. A workbook's sheets
   * are read without building elements, and their cells count toward
   * `maxTableCells` alone. officeparser's own default when left out.
   */
  maxXmlElements?: number;
  /**
   * The most table cells a document may hold. officeparser allows a document
   * one more cell for each byte of its file; the loader takes that allowance
   * out of the limit it passes, so this is the bound itself. officeparser's
   * own default, with its allowance, when left out.
   */
  maxTableCells?: number;
  /** Pages of a scanned PDF read by OCR, from the first: a whole number; 0 refuses a PDF. Default 0. */
  ocrPages?: number;
  /** The heap, in MB, of the separate process pdf.js runs in during OCR: 64 or more. Default 256. */
  pdfProcessMemoryMb?: number;
  /**
   * Cancels a read. officeparser checks the signal between its steps and ends
   * OCR and the pdf.js process on it, and the read rejects with its
   * `AbortError`; a step that reads one part's markup finishes first. A
   * deadline is a signal: `AbortSignal.timeout(ms)`.
   */
  signal?: AbortSignal;
  /** officeparser's `parseOffice`; imported on the first read when left out. */
  parse?: OfficeParse;
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

/** The bound when {@link OfficeLoaderOptions.maxInflatedBytes} is left out: 64 MiB. */
const DEFAULT_MAX_INFLATED_BYTES = 67_108_864;

/** The pdf.js process's heap when {@link OfficeLoaderOptions.pdfProcessMemoryMb} is left out, in MB. */
const DEFAULT_PDF_PROCESS_MEMORY_MB = 256;

/** The smallest heap, in MB, officeparser starts its pdf.js process with. */
const MIN_PDF_PROCESS_MEMORY_MB = 64;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** officeparser's `parseOffice`, imported once and only when a document needs it. */
let parser: Promise<OfficeParse> | null = null;

/**
 * Imports officeparser on the first read. A failed import is tried again on
 * the next read, so a package installed meanwhile is found.
 *
 * @throws {Error} When officeparser is not installed; the import's error is its `cause`.
 */
function loadParser(): Promise<OfficeParse> {
  parser ??= import('officeparser')
    .then((module) => module.parseOffice as unknown as OfficeParse)
    .catch((error: unknown) => {
      parser = null;
      throw Object.assign(new Error(`OfficeLoader needs the optional peer dependency officeparser: ${String(error)}`), {
        cause: error,
      });
    });
  return parser;
}

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
 * reads a scanned PDF: officeparser reads the first `ocrPages` pages with
 * pdf.js, in a process of its own where one can start, and tesseract.js
 * recognizes the text of each picture on them.
 *
 * @implements {IDocumentLoader}
 *
 * @example An uploaded deck, refused past its bounds
 * ```ts
 * const loader = new OfficeLoader({ maxInflatedBytes: 32 * 1024 * 1024, maxXmlElements: 400_000 });
 * try {
 *   const doc = await loader.load(uploadedBuffer, { format: 'pptx' });
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
 * const loader = new OfficeLoader({ ocrPages: 3, signal: AbortSignal.timeout(60_000) });
 * const doc = await loader.load(scanBuffer, { format: 'pdf' });
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
   *   leading dot, or `pdf` for a scanned PDF.
   * @returns The document's text, with `metadata.wordCount`, and `metadata.pageCount` when officeparser reports
   *   a page count.
   * @throws {DocumentTooLargeError} When the document reaches a bound, one officeparser only warns of included.
   *   The error's `limit` is the loader's `maxInflatedBytes` whichever bound was reached, and its `cause` names
   *   the bound by officeparser's code.
   * @throws {ScannedDocumentError} For a PDF while `ocrPages` is 0, and for a scan whose pages gave no text.
   * @throws {Error} When `source` is a path, when `options.format` names none of the formats, and when
   *   officeparser is not installed; and officeparser's own error for a file it cannot read or a read its
   *   signal cancelled.
   */
  async load(source: string | Buffer, options?: LoadOptions): Promise<LoadedDocument> {
    if (!Buffer.isBuffer(source)) throw new Error('OfficeLoader reads bytes: pass the file as a Buffer.');
    const format = formatOf(options?.format);
    const ocrPages = this.options.ocrPages ?? 0;
    if (format === 'pdf' && ocrPages === 0) {
      throw new ScannedDocumentError('OfficeLoader reads a PDF only by OCR, and ocrPages is 0.');
    }
    const limit = this.options.maxInflatedBytes ?? DEFAULT_MAX_INFLATED_BYTES;
    const { maxXmlElements, maxTableCells, signal } = this.options;

    // officeparser only warns past some bounds (a sheet's cells): a warned bound
    // refuses the document as a thrown one does.
    const reached: string[] = [];
    const config: Record<string, unknown> = {
      fileType: format,
      decompressionLimits: {
        maxUncompressedBytes: limit,
        ...(maxXmlElements === undefined ? {} : { maxXmlElements }),
        // officeparser adds one cell for each byte of the file to the limit it is
        // given, so the file's length is taken out of the caller's bound here.
        ...(maxTableCells === undefined ? {} : { maxTableCells: maxTableCells - source.length }),
      },
      abortSignal: signal ?? null,
      ignoreComments: true,
      onWarning: (issue: { code?: unknown }) => {
        if (typeof issue.code === 'string' && LIMIT_CODES.has(issue.code)) reached.push(issue.code);
      },
    };
    if (format === 'pdf') {
      config.ocr = true;
      // officeparser recognizes text in the pictures it extracts, and in no others.
      config.extractAttachments = true;
      config.pdfParserConfig = {
        pageRange: `1-${ocrPages}`,
        processMemoryMb: this.options.pdfProcessMemoryMb ?? DEFAULT_PDF_PROCESS_MEMORY_MB,
      };
    }

    let text: string;
    let pages: unknown;
    try {
      const parse = this.options.parse ?? (await loadParser());
      const parsed = await parse(source, config);
      // Written as text, a picture is a line naming it by default. Asked for the
      // recognized text alone, a picture read by OCR is its text, and any other
      // picture is left out.
      const written = await parsed.to('text', { includeImages: 'ocr-text-only', abortSignal: signal ?? null });
      text = typeof written.value === 'string' ? written.value : '';
      pages = parsed.metadata?.pages;
    } catch (error) {
      const code = (error as { officeIssue?: { code?: unknown } } | null)?.officeIssue?.code;
      if (typeof code === 'string' && LIMIT_CODES.has(code)) throw tooLarge(limit, code);
      throw error;
    }
    if (reached.length > 0) throw tooLarge(limit, reached[0]);

    const trimmed = text.trim();
    if (format === 'pdf' && trimmed === '') throw new ScannedDocumentError('OCR read no text from the scanned pages.');
    const metadata: DocumentMetadata = {
      wordCount: trimmed === '' ? 0 : trimmed.split(/\s+/).length,
      ...(typeof pages === 'number' ? { pageCount: pages } : {}),
    };
    return { content: text, metadata, format };
  }
}
