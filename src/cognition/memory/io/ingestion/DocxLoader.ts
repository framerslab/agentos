/**
 * @fileoverview DocxLoader — loads `.docx` documents using `mammoth`.
 *
 * The `mammoth` library extracts raw text from OOXML (Office Open XML) Word
 * documents by stripping all formatting and returning the plain-text content.
 * This keeps the ingestion pipeline fast and dependency-light while still
 * producing high-quality text suitable for chunking and embedding.
 *
 * A Word file is a ZIP archive whose parts mammoth inflates as it reads them,
 * so a file of a few megabytes can inflate to gigabytes. Before mammoth reads
 * a file, the loader inflates every entry of its archive with `node:zlib`
 * under a bound ({@link DocxLoaderOptions.maxInflatedBytes}) and throws
 * {@link DocumentTooLargeError} once the entries pass it.
 *
 * @module memory/ingestion/DocxLoader
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { constants as bufferConstants } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';
import mammoth from 'mammoth';
import type { IDocumentLoader } from './IDocumentLoader.js';
import type { LoadOptions, LoadedDocument, DocumentMetadata } from '../facade/types.js';
import { validatePath } from './pathUtils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Extensions handled by this loader, each with a leading dot. */
const SUPPORTED_EXTENSIONS = ['.docx'] as const;

/** The bound when {@link DocxLoaderOptions.maxInflatedBytes} is left out: 128 MiB. */
const DEFAULT_MAX_INFLATED_BYTES = 134_217_728;

/** Signature of a ZIP archive's end of central directory record. */
const END_RECORD_SIGNATURE = 0x06054b50;

/** Signature of a ZIP central directory file header. */
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;

/** Signature of a ZIP local file header. */
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** Length of the end of central directory record without its comment. */
const END_RECORD_LENGTH = 22;

/** How far back from the end of a file the end record is searched for: the record and the longest comment (65,535 bytes). */
const END_RECORD_SEARCH = 65_557;

/** Length of a central directory file header without its name, extra field and comment. */
const CENTRAL_HEADER_LENGTH = 46;

/** Length of a local file header without its name and extra field. */
const LOCAL_HEADER_LENGTH = 30;

/** Compression method of an entry stored as it is. */
const METHOD_STORED = 0;

/** Compression method of a deflated entry. */
const METHOD_DEFLATED = 8;

/** A 16-bit field of the end record at this value announces a ZIP64 record. */
const ZIP64_MARK_16 = 0xffff;

/** A 32-bit size or offset at this value announces a ZIP64 record. */
const ZIP64_MARK_32 = 0xffffffff;

// ---------------------------------------------------------------------------
// Errors and options
// ---------------------------------------------------------------------------

/** Thrown when a document would take more memory to read than its loader allows. */
export class DocumentTooLargeError extends Error {
  /** A stable code for callers that branch on the kind of failure. */
  readonly code = 'DOCUMENT_TOO_LARGE';

  /**
   * @param limit - The bound, in bytes, that the document passed.
   */
  constructor(readonly limit: number) {
    super(`the document inflates past ${limit} bytes`);
    this.name = 'DocumentTooLargeError';
  }
}

/** Options of the Word loader. */
export interface DocxLoaderOptions {
  /** The most the archive's entries may inflate to, together, before mammoth reads the file. Default 134,217,728 (128 MiB). */
  maxInflatedBytes?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the lower-cased extension (with dot) of a file path.
 *
 * @param filePath - Absolute or relative file path.
 */
function extOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

/**
 * Count the approximate number of words in a string.
 *
 * Splits on runs of whitespace — intentionally lightweight for the typical
 * document sizes encountered during ingestion.
 *
 * @param text - Raw text to count.
 */
function wordCount(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
}

/**
 * The error for a buffer the loader cannot read as a Word file's ZIP archive.
 *
 * @param cause - The error that showed it, when there is one.
 */
function notAWordArchive(cause?: unknown): Error {
  const error = new Error('DocxLoader: not a Word archive');
  return cause === undefined ? error : Object.assign(error, { cause });
}

/**
 * Whether an error is zlib's refusal to inflate past `maxOutputLength`.
 *
 * @param error - What the inflate call threw.
 */
function isOutputCapError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE';
}

/**
 * Finds the end of central directory record, searched back from the end of
 * the buffer over the record and the longest comment it may carry.
 *
 * @param buffer - The whole file.
 * @returns The record's offset, or -1 when the buffer holds none.
 */
function findEndRecord(buffer: Buffer): number {
  const first = Math.max(0, buffer.length - END_RECORD_SEARCH);
  for (let offset = buffer.length - END_RECORD_LENGTH; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_RECORD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * The bytes of one entry's data, found after its local header.
 *
 * @param buffer - The whole file.
 * @param localOffset - The local header's offset, from the central directory.
 * @param compressedSize - The data's length, from the central directory.
 * @throws {Error} `DocxLoader: not a Word archive` when the header or its data lies outside the buffer.
 */
function entryData(buffer: Buffer, localOffset: number, compressedSize: number): Buffer {
  if (
    localOffset + LOCAL_HEADER_LENGTH > buffer.length ||
    buffer.readUInt32LE(localOffset) !== LOCAL_HEADER_SIGNATURE
  ) {
    throw notAWordArchive();
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + LOCAL_HEADER_LENGTH + nameLength + extraLength;
  if (start + compressedSize > buffer.length) throw notAWordArchive();
  return buffer.subarray(start, start + compressedSize);
}

/**
 * How many bytes one entry inflates to, inflating no further than what the
 * bound leaves for it: zlib stops within one chunk of its output past the cap.
 *
 * @param data - The entry's data as the archive holds it.
 * @param method - The entry's compression method, from the central directory.
 * @param remaining - What the bound leaves for this entry.
 * @param bound - The whole bound, which the error carries.
 * @throws {DocumentTooLargeError} When the entry inflates past `remaining`.
 * @throws {Error} `DocxLoader: not a Word archive` when the method is neither stored nor deflated, or the data does not inflate.
 */
function inflatedLength(data: Buffer, method: number, remaining: number, bound: number): number {
  if (method === METHOD_STORED) return data.length;
  if (method !== METHOD_DEFLATED) throw notAWordArchive();
  // zlib takes a cap from 1 to buffer.constants.MAX_LENGTH, and its synchronous
  // calls throw ERR_BUFFER_TOO_LARGE as soon as their output passes the cap.
  const maxOutputLength = Math.min(Math.max(1, remaining), bufferConstants.MAX_LENGTH);
  try {
    return inflateRawSync(data, { maxOutputLength }).length;
  } catch (error) {
    if (!isOutputCapError(error)) throw notAWordArchive(error);
  }
  throw new DocumentTooLargeError(bound);
}

/**
 * Inflates every entry of a Word file's ZIP archive under a bound before
 * mammoth reads it, holding one entry's output at a time.
 *
 * The archive is read the way mammoth's ZIP reader (JSZip) reads it: the end
 * record found from the end of the file, the central directory it points to,
 * and each entry's data after its local header, with the central directory's
 * method and compressed size. The size an entry states for its inflated data
 * is never trusted. An archive that reader would read from other bytes (a
 * ZIP64 record, or bytes between the central directory and the end record,
 * which JSZip takes for data prepended to the archive and moves every offset
 * by) is refused rather than counted from bytes mammoth does not inflate.
 * So is an archive whose entries' data together pass the bytes before its
 * central directory: entries lie one after another there, so such entries
 * share their data, and inflating each again from the same bytes would take
 * time that grows with the square of the file's size.
 *
 * @param buffer - The whole file.
 * @param bound - The most the entries may inflate to, together.
 * @throws {DocumentTooLargeError} When the entries inflate past the bound.
 * @throws {Error} `DocxLoader: not a Word archive` when the buffer is not a ZIP archive this check can read.
 */
function assertInflatesWithin(buffer: Buffer, bound: number): void {
  const end = findEndRecord(buffer);
  if (end < 0) throw notAWordArchive();

  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  const zip64 =
    buffer.readUInt16LE(end + 4) === ZIP64_MARK_16 || // this disk's number
    buffer.readUInt16LE(end + 6) === ZIP64_MARK_16 || // the disk where the central directory starts
    buffer.readUInt16LE(end + 8) === ZIP64_MARK_16 || // entries on this disk
    buffer.readUInt16LE(end + 10) === ZIP64_MARK_16 || // entries in all
    directorySize === ZIP64_MARK_32 ||
    directoryOffset === ZIP64_MARK_32;
  if (zip64 || directoryOffset + directorySize !== end) throw notAWordArchive();

  let inflated = 0;
  let compressed = 0;
  let entry = directoryOffset;
  while (entry < end) {
    if (entry + CENTRAL_HEADER_LENGTH > end || buffer.readUInt32LE(entry) !== CENTRAL_HEADER_SIGNATURE) {
      throw notAWordArchive();
    }
    const method = buffer.readUInt16LE(entry + 10);
    const compressedSize = buffer.readUInt32LE(entry + 20);
    const statedSize = buffer.readUInt32LE(entry + 24);
    const localOffset = buffer.readUInt32LE(entry + 42);
    const next =
      entry +
      CENTRAL_HEADER_LENGTH +
      buffer.readUInt16LE(entry + 28) + // name
      buffer.readUInt16LE(entry + 30) + // extra field
      buffer.readUInt16LE(entry + 32); // comment
    // The stated size is read only to recognise a ZIP64 entry, whose real
    // sizes and offset JSZip takes from its extra field.
    if (next > end || compressedSize === ZIP64_MARK_32 || statedSize === ZIP64_MARK_32 || localOffset === ZIP64_MARK_32) {
      throw notAWordArchive();
    }
    // Every entry's data lies before the central directory, apart from the
    // others, so the data together fit there; past it, entries share bytes.
    compressed += compressedSize;
    if (compressed > directoryOffset) throw notAWordArchive();

    inflated += inflatedLength(entryData(buffer, localOffset, compressedSize), method, bound - inflated, bound);
    if (inflated > bound) throw new DocumentTooLargeError(bound);
    entry = next;
  }
}

// ---------------------------------------------------------------------------
// DocxLoader
// ---------------------------------------------------------------------------

/**
 * Document loader for Microsoft Word (`.docx`) files.
 *
 * Uses `mammoth.extractRawText()` to strip all styling and return plain
 * prose text, which is then stored as the `content` field.  The `metadata`
 * block includes an approximate `wordCount`.
 *
 * Before mammoth reads a file, the loader inflates every entry of its ZIP
 * archive under {@link DocxLoaderOptions.maxInflatedBytes} (128 MiB unless
 * given), one entry's output at a time, and refuses the file with
 * {@link DocumentTooLargeError} once the entries pass the bound together.
 *
 * @implements {IDocumentLoader}
 *
 * @example
 * ```ts
 * const loader = new DocxLoader();
 * const doc = await loader.load('/docs/spec.docx');
 * console.log(doc.metadata.wordCount); // e.g. 1842
 * ```
 *
 * @example An uploaded file refused past 64 MiB inflated
 * ```ts
 * const loader = new DocxLoader({ maxInflatedBytes: 64 * 1024 * 1024 });
 * try {
 *   const doc = await loader.load(uploadedBuffer);
 * } catch (error) {
 *   if (error instanceof DocumentTooLargeError) {
 *     console.log(`inflates past ${error.limit} bytes`); // mammoth never ran
 *   }
 * }
 * ```
 */
export class DocxLoader implements IDocumentLoader {
  /** @inheritdoc */
  readonly supportedExtensions: string[] = [...SUPPORTED_EXTENSIONS];

  /** The most the archive's entries may inflate to, together, before mammoth reads the file. */
  private readonly maxInflatedBytes: number;

  /**
   * @param options - The loader's options; with none, the bound is 128 MiB.
   * @throws {RangeError} When `maxInflatedBytes` is not a positive, finite number.
   */
  constructor(options: DocxLoaderOptions = {}) {
    const maxInflatedBytes = options.maxInflatedBytes ?? DEFAULT_MAX_INFLATED_BYTES;
    // NaN and Infinity bound nothing: the inflated sum is never past either,
    // and zlib then caps an entry's output at its own maximum.
    if (!Number.isFinite(maxInflatedBytes) || maxInflatedBytes <= 0) {
      throw new RangeError(`DocxLoader: maxInflatedBytes must be a positive, finite number, got ${maxInflatedBytes}`);
    }
    this.maxInflatedBytes = maxInflatedBytes;
  }

  // -------------------------------------------------------------------------
  // canLoad
  // -------------------------------------------------------------------------

  /** @inheritdoc */
  canLoad(source: string | Buffer): boolean {
    if (Buffer.isBuffer(source)) {
      // OOXML magic: PK zip signature (0x50 0x4B 0x03 0x04).
      // .docx files are ZIP archives — check for the PK header.
      return source.length >= 4 &&
        source[0] === 0x50 && source[1] === 0x4B &&
        source[2] === 0x03 && source[3] === 0x04;
    }
    return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extOf(source) as '.docx');
  }

  // -------------------------------------------------------------------------
  // load
  // -------------------------------------------------------------------------

  /**
   * @inheritdoc
   * @throws {DocumentTooLargeError} When the archive's entries inflate past the loader's bound; mammoth never runs.
   * @throws {Error} `DocxLoader: not a Word archive` when the file is not a ZIP archive the bound's check can read.
   */
  async load(source: string | Buffer, _options?: LoadOptions): Promise<LoadedDocument> {
    let buffer: Buffer;
    let resolvedPath: string | undefined;

    if (Buffer.isBuffer(source)) {
      buffer = source;
    } else {
      resolvedPath = validatePath(source);
      buffer = await fs.readFile(resolvedPath);
    }

    // mammoth inflates every part it reads, so the archive's entries are
    // inflated under the bound first and mammoth runs only within it.
    assertInflatesWithin(buffer, this.maxInflatedBytes);

    // mammoth.extractRawText strips all OOXML formatting and returns plain text.
    // The `buffer` option accepts a Node Buffer directly (no temp file needed).
    const result = await mammoth.extractRawText({ buffer });

    // `result.value` is the extracted text; `result.messages` holds any
    // conversion warnings (ignored here — they're rarely actionable for
    // text-only extraction).
    const content = result.value;

    const meta: DocumentMetadata = {
      wordCount: wordCount(content),
      ...(resolvedPath ? { source: resolvedPath } : {}),
    };

    return {
      content,
      metadata: meta,
      format: 'docx',
    };
  }
}
