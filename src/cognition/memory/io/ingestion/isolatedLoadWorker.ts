/**
 * @fileoverview The entry of the worker thread `loadIsolated` starts: it reads
 * the document it is handed with the loader of its kind and posts back what
 * the loader answers, or the error the read threw.
 *
 * `loadIsolated` starts this module's compiled file, `isolatedLoadWorker.js`
 * beside its own, with its request as `workerData`. Imported anywhere else,
 * the module does nothing: it reads only in a worker thread handed a request.
 *
 * @module memory/ingestion/isolatedLoadWorker
 */

import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import type { LoadOptions, LoadedDocument } from '../facade/types.js';
import type { IDocumentLoader } from './IDocumentLoader.js';
import type { IsolatedLoadKind } from './loadIsolated.js';

/** What `loadIsolated` hands the worker as its `workerData`. */
export interface IsolatedLoadRequest {
  /** The loader to read with. */
  kind: IsolatedLoadKind;
  /** The document's bytes, moved to the worker. */
  bytes: ArrayBuffer;
  /** The Word or office loader's bound on what the archive's entries inflate to; its default when left out. */
  maxInflatedBytes?: number;
  /** The office loader's bound on XML elements, for the office kinds and `'scan'`; its default when left out. */
  maxXmlElements?: number;
  /** The office loader's bound on table cells, for the office kinds and `'scan'`; its default when left out. */
  maxTableCells?: number;
  /** The pages of a scan read by OCR, for `'scan'`. */
  ocrPages?: number;
  /** The heap, in MB, of the process pdf.js reads a scan in, for `'scan'`; the office loader's default when left out. */
  pdfProcessMemoryMb?: number;
}

/**
 * What the worker posts back: the loader's answer; a loader's bound by its
 * limit and message, with the office loader's cause naming the bound; a scan
 * that gave no text by its message and cause; or any other error by its name
 * and message.
 */
export type IsolatedLoadAnswer =
  | { ok: true; document: LoadedDocument }
  | { ok: false; tooLarge: number; message?: string; cause?: string }
  | { ok: false; scanned: string; cause?: { name: string; message: string } }
  | { ok: false; name: string; message: string };

/**
 * Whether the worker's data is a request `loadIsolated` made.
 *
 * @param value - The worker's `workerData`.
 */
function isRequest(value: unknown): value is IsolatedLoadRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    'bytes' in value &&
    value.bytes instanceof ArrayBuffer
  );
}

/**
 * Builds the loader of a request's kind, importing only that loader's module,
 * so a text read loads neither mammoth nor unpdf, and only an office read
 * loads officeparser. The office loader is handed officeparser, so it reads in
 * this thread, a scan by OCR included.
 *
 * @param request - What `loadIsolated` handed the worker.
 * @throws {TypeError} For a kind outside the twelve.
 */
async function loaderFor(request: IsolatedLoadRequest): Promise<IDocumentLoader> {
  const { kind, maxInflatedBytes } = request;
  switch (kind) {
    case 'pdf': {
      const { PdfLoader } = await import('./PdfLoader.js');
      return new PdfLoader();
    }
    case 'docx': {
      const { DocxLoader } = await import('./DocxLoader.js');
      return new DocxLoader({ maxInflatedBytes });
    }
    case 'text': {
      const { TextLoader } = await import('./TextLoader.js');
      return new TextLoader();
    }
    case 'markdown': {
      const { MarkdownLoader } = await import('./MarkdownLoader.js');
      return new MarkdownLoader();
    }
    default: {
      const { OFFICE_TYPES, OfficeLoader } = await import('./OfficeLoader.js');
      const office: readonly string[] = Object.values(OFFICE_TYPES);
      if (kind !== 'scan' && !office.includes(kind)) {
        throw new TypeError(`loadIsolated: no loader for the kind ${String(kind)}`);
      }
      const { loadOfficeparser } = await import('./loadOfficeparser.js');
      const { maxXmlElements, maxTableCells, ocrPages, pdfProcessMemoryMb } = request;
      return new OfficeLoader({
        maxInflatedBytes,
        maxXmlElements,
        maxTableCells,
        ocrPages,
        pdfProcessMemoryMb,
        parse: await loadOfficeparser(),
      });
    }
  }
}

/**
 * The format a kind's loader is told: an office kind's own, a PDF for
 * `'scan'`, and none for the loaders that need none.
 *
 * @param kind - The read's kind.
 */
function loadOptionsOf(kind: IsolatedLoadKind): LoadOptions | undefined {
  if (kind === 'pdf' || kind === 'docx' || kind === 'text' || kind === 'markdown') return undefined;
  return { format: kind === 'scan' ? 'pdf' : kind };
}

/**
 * The answer for an error the read threw: a loader's bound by its code, limit
 * and message, a scan that gave no text by its code (each read by its code, so
 * no other kind loads the loader that throws it to recognise it), and any other
 * error by its name and message. A bound's or a scan's cause goes with it.
 *
 * @param error - What the read threw.
 */
function failureOf(error: unknown): IsolatedLoadAnswer {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const cause = 'cause' in error ? error.cause : undefined;
    if (error.code === 'DOCUMENT_TOO_LARGE' && 'limit' in error && typeof error.limit === 'number') {
      return {
        ok: false,
        tooLarge: error.limit,
        // The office loader's message names the bound the document reached, which may not be `limit`.
        ...(error instanceof Error ? { message: error.message } : {}),
        ...(cause instanceof Error ? { cause: cause.message } : {}),
      };
    }
    if (error.code === 'SCANNED_DOCUMENT' && error instanceof Error) {
      // officeparser's report of a picture OCR could not read carries what failed, an error or its text.
      const why =
        cause === undefined
          ? {}
          : cause instanceof Error
            ? { cause: { name: cause.name, message: cause.message } }
            : { cause: { name: 'Error', message: String(cause) } };
      return { ok: false, scanned: error.message, ...why };
    }
  }
  if (error instanceof Error) return { ok: false, name: error.name, message: error.message };
  return { ok: false, name: 'Error', message: String(error) };
}

/**
 * Posts an answer, or, when the structured clone cannot copy it (a function or
 * a symbol in the metadata), the clone's error in its place.
 *
 * @param port - The port to the thread that started the worker.
 * @param answer - What the read answered.
 */
function post(port: MessagePort, answer: IsolatedLoadAnswer): void {
  try {
    port.postMessage(answer);
  } catch (error) {
    port.postMessage(failureOf(error));
  }
}

/**
 * Reads the request's bytes with the loader of its kind and posts what the
 * loader answers, or the error the read threw.
 *
 * @param port - The port to the thread that started the worker.
 * @param request - What `loadIsolated` handed the worker.
 */
async function read(port: MessagePort, request: IsolatedLoadRequest): Promise<void> {
  let answer: IsolatedLoadAnswer;
  try {
    const loader = await loaderFor(request);
    // A view of the moved buffer, not a copy.
    const document = await loader.load(Buffer.from(request.bytes), loadOptionsOf(request.kind));
    answer = { ok: true, document: { content: document.content, metadata: document.metadata, format: document.format } };
  } catch (error) {
    answer = failureOf(error);
  }
  post(port, answer);
}

if (parentPort !== null && isRequest(workerData)) {
  void read(parentPort, workerData);
}
