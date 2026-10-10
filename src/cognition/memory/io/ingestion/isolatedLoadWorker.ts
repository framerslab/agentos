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
import type { LoadedDocument } from '../facade/types.js';
import type { IDocumentLoader } from './IDocumentLoader.js';
import type { IsolatedLoadKind } from './loadIsolated.js';

/** What `loadIsolated` hands the worker as its `workerData`. */
export interface IsolatedLoadRequest {
  /** The loader to read with. */
  kind: IsolatedLoadKind;
  /** The document's bytes, moved to the worker. */
  bytes: ArrayBuffer;
  /** The Word loader's bound on what the archive's entries inflate to; its default when left out. */
  maxInflatedBytes?: number;
}

/**
 * What the worker posts back: the loader's answer, the Word loader's bound by
 * its limit, or any other error by its name and message.
 */
export type IsolatedLoadAnswer =
  | { ok: true; document: LoadedDocument }
  | { ok: false; tooLarge: number }
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
 * Builds the loader of a kind, importing only that loader's module, so a text
 * read loads neither mammoth nor unpdf.
 *
 * @param kind - The loader to build.
 * @param maxInflatedBytes - The Word loader's bound, when one was given.
 * @throws {TypeError} For a kind outside the four.
 */
async function loaderFor(kind: IsolatedLoadKind, maxInflatedBytes: number | undefined): Promise<IDocumentLoader> {
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
    default:
      throw new TypeError(`loadIsolated: no loader for the kind ${String(kind)}`);
  }
}

/**
 * The answer for an error the read threw: the Word loader's bound by its code
 * and limit (read by its code, so no other kind loads the Word loader to
 * recognise it), and any other error by its name and message.
 *
 * @param error - What the read threw.
 */
function failureOf(error: unknown): IsolatedLoadAnswer {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'DOCUMENT_TOO_LARGE' &&
    'limit' in error &&
    typeof error.limit === 'number'
  ) {
    return { ok: false, tooLarge: error.limit };
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
    const loader = await loaderFor(request.kind, request.maxInflatedBytes);
    // A view of the moved buffer, not a copy.
    const document = await loader.load(Buffer.from(request.bytes));
    answer = { ok: true, document: { content: document.content, metadata: document.metadata, format: document.format } };
  } catch (error) {
    answer = failureOf(error);
  }
  post(port, answer);
}

if (parentPort !== null && isRequest(workerData)) {
  void read(parentPort, workerData);
}
