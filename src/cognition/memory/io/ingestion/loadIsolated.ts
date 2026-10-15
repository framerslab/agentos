/**
 * @fileoverview loadIsolated: a document read with the loader of its kind in a
 * worker thread, under a heap cap, a deadline and, when asked, a bound on the
 * worker's memory outside its heap.
 *
 * The document loaders read on their caller's thread and heap, and a crafted
 * file can make a read take far more memory than its size: mammoth builds
 * element trees many times the size of the XML it parses, and DocxLoader's
 * `maxInflatedBytes` bounds what a Word file's archive inflates to, not the
 * memory its read takes. `loadIsolated` reads in a `node:worker_threads`
 * worker whose old generation is capped with
 * `resourceLimits.maxOldGenerationSizeMb`, so a read that fills that heap ends
 * the worker while the caller's process reads on.
 *
 * The heap cap leaves out the memory outside V8's heap: Node's resource limits
 * count no `ArrayBuffer`, and the loaders hold large typed arrays (JSZip keeps
 * a Word part's inflated chunks and then their concatenation, and pdf.js keeps
 * every decoded byte of a stream). {@link IsolatedLoadOptions.maxExternalMb}
 * bounds that memory: every 20 ms the worker's `external_memory` is read with
 * `worker.getHeapStatistics()`, and the worker is ended once it passes the
 * bound. The check reads between allocations, on a timer on the caller's
 * thread: what the worker allocates between two checks can pass the bound
 * before the worker is ended, and a read that ends between two checks is
 * answered whatever it held at its peak. Without `maxExternalMb`, nothing
 * bounds the worker's memory outside its heap.
 *
 * The worker is a thread of the caller's process: it bounds a read's memory
 * and time, and it is not a sandbox for code. Its entry is
 * `isolatedLoadWorker.js`, compiled beside this module, which finds it from
 * its own URL. It is started with an empty `execArgv` in place of the Node
 * options it would inherit from the caller's thread, and `NODE_OPTIONS` from
 * the environment applies to it. V8's options are the whole process's, so a
 * `--max-old-space-size` the process was started with overrides the heap cap.
 *
 * @module memory/ingestion/loadIsolated
 */

import { Worker } from 'node:worker_threads';
import type { LoadedDocument } from '../facade/types.js';
import { DocumentTooLargeError } from './DocxLoader.js';
import type { IsolatedLoadAnswer, IsolatedLoadRequest } from './isolatedLoadWorker.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The kinds `loadIsolated` reads, one loader each. */
const KINDS: readonly IsolatedLoadKind[] = ['pdf', 'docx', 'text', 'markdown'];

/** The worker's old generation when `maxHeapMb` is left out, in MiB. */
const DEFAULT_MAX_HEAP_MB = 256;

/** The deadline when `timeoutMs` is left out, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The longest delay a Node timer holds: a longer one fires after 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** How often the worker's memory outside its heap is read, in milliseconds. */
const EXTERNAL_CHECK_MS = 20;

/** Bytes in a MiB. */
const BYTES_PER_MIB = 1_048_576;

// ---------------------------------------------------------------------------
// Types and errors
// ---------------------------------------------------------------------------

/** The loaders `loadIsolated` reads with: `PdfLoader`, `DocxLoader`, `TextLoader` and `MarkdownLoader`. */
export type IsolatedLoadKind = 'pdf' | 'docx' | 'text' | 'markdown';

/** Options of {@link loadIsolated}. */
export interface IsolatedLoadOptions {
  /**
   * The worker's old generation, in MiB (`resourceLimits.maxOldGenerationSizeMb`). Default 256. A
   * `--max-old-space-size` the process was started with, on its command line or in `NODE_OPTIONS`, overrides it.
   */
  maxHeapMb?: number;
  /** How long the read may take from the worker's start, in milliseconds, at most 2,147,483,647. Default 30,000. */
  timeoutMs?: number;
  /** The Word loader's bound on what the archive's entries inflate to (`DocxLoaderOptions.maxInflatedBytes`); its default when left out. */
  maxInflatedBytes?: number;
  /**
   * The worker's array buffers and external strings, in MiB, past which it is ended: read every 20 ms with
   * `worker.getHeapStatistics()`, which Node 22.16 and 24.0 add; on an earlier Node, a read given it is refused
   * with a `TypeError`. No check when left out.
   */
  maxExternalMb?: number;
}

/** Thrown when a document's read ends on the worker's heap cap or on its memory outside the heap. */
export class DocumentTooComplexError extends Error {
  /** A stable code for callers that branch on the kind of failure. */
  readonly code = 'DOCUMENT_TOO_COMPLEX';

  /**
   * @param limitMb - The bound, in MiB, the read passed.
   * @param resource - `'heap'` for the worker's heap cap, `'external'` for its memory outside the heap.
   */
  constructor(
    readonly limitMb: number,
    readonly resource: 'heap' | 'external' = 'heap',
  ) {
    super(`reading the document took more than ${limitMb} MiB of ${resource === 'heap' ? 'heap' : 'memory outside the heap'}`);
    this.name = 'DocumentTooComplexError';
  }
}

/** Thrown when a document is not read within its deadline. */
export class DocumentReadTimeoutError extends Error {
  /** A stable code for callers that branch on the kind of failure. */
  readonly code = 'DOCUMENT_READ_TIMEOUT';

  /** @param timeoutMs - The deadline, in milliseconds, the read passed. */
  constructor(readonly timeoutMs: number) {
    super(`the document was not read within ${timeoutMs} ms`);
    this.name = 'DocumentReadTimeoutError';
  }
}

/** How a read ended, before its worker is ended. */
type Outcome = { ok: true; document: LoadedDocument } | { ok: false; error: Error };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A bound given to `loadIsolated`, checked before any worker starts.
 *
 * @param name - The option's name, for the error.
 * @param value - Its value.
 * @param max - The largest value it may take.
 * @throws {RangeError} When the value is not a positive, finite number of at most `max`.
 */
function bound(name: string, value: number, max = Number.MAX_VALUE): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
    const most = max === Number.MAX_VALUE ? '' : ` of at most ${max}`;
    throw new RangeError(`loadIsolated: ${name} must be a positive, finite number${most}, got ${String(value)}`);
  }
  return value;
}

/**
 * Whether a message from the worker has the shape of its answer.
 *
 * @param value - What the worker posted.
 */
function isAnswer(value: unknown): value is IsolatedLoadAnswer {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false;
  if (value.ok === true) return 'document' in value && typeof value.document === 'object' && value.document !== null;
  if (value.ok !== false) return false;
  if ('tooLarge' in value) return typeof value.tooLarge === 'number';
  return 'name' in value && typeof value.name === 'string' && 'message' in value && typeof value.message === 'string';
}

/**
 * The loader's own error, rebuilt from the name and message the worker posted.
 *
 * @param name - The error's name, such as `Error` or `TypeError`.
 * @param message - Its message.
 */
function loaderError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * How a read ends on the worker's message: its document, the Word loader's bound passed through as
 * {@link DocumentTooLargeError}, or the loader's own error.
 *
 * @param value - What the worker posted.
 */
function outcomeOf(value: unknown): Outcome {
  if (!isAnswer(value)) return { ok: false, error: new Error('loadIsolated: the worker answered with no document') };
  if (value.ok) return { ok: true, document: value.document };
  if ('tooLarge' in value) return { ok: false, error: new DocumentTooLargeError(value.tooLarge) };
  return { ok: false, error: loaderError(value.name, value.message) };
}

/**
 * Whether the worker's error is the end Node gives a worker that reached its heap cap.
 *
 * @param error - The worker's `'error'`.
 */
function isOutOfMemory(error: Error): boolean {
  return 'code' in error && error.code === 'ERR_WORKER_OUT_OF_MEMORY';
}

/**
 * Settles a read on the first of the worker's answer, its error, its exit, the deadline and the bound on its
 * memory outside the heap; then clears the timers, ends the worker and waits for its exit before the promise
 * settles, so no worker outlives its read.
 *
 * @param worker - The worker reading the document.
 * @param maxHeapMb - Its heap cap, which the error at that cap names.
 * @param timeoutMs - The deadline.
 * @param maxExternalMb - The bound on its memory outside the heap, when there is one.
 */
function awaitRead(
  worker: Worker,
  maxHeapMb: number,
  timeoutMs: number,
  maxExternalMb: number | undefined,
): Promise<LoadedDocument> {
  return new Promise<LoadedDocument>((resolve, reject) => {
    let outcome: Outcome | undefined;
    let statsInFlight = false;
    // Listened for from the start, so an exit that comes before the read settles is seen.
    const exited = new Promise<void>((done) => {
      worker.once('exit', () => done());
    });

    function settle(next: Outcome): void {
      if (outcome !== undefined) return;
      outcome = next;
      clearTimeout(deadline);
      if (externalCheck !== undefined) clearInterval(externalCheck);
      // terminate() resolves on the worker's 'exit', and at once for a worker that has already stopped.
      void worker
        .terminate()
        .then(() => exited)
        .then(() => (next.ok ? resolve(next.document) : reject(next.error)));
    }

    function checkExternal(limitMb: number): void {
      if (statsInFlight || outcome !== undefined) return;
      statsInFlight = true;
      worker.getHeapStatistics().then(
        (stats) => {
          statsInFlight = false;
          // An answer that comes after the read settled changes nothing.
          if (stats.external_memory > limitMb * BYTES_PER_MIB) {
            settle({ ok: false, error: new DocumentTooComplexError(limitMb, 'external') });
          }
        },
        () => {
          // The worker is no longer running: its exit, or what ended it, settles the read.
          statsInFlight = false;
        },
      );
    }

    function watchExternal(limitMb: number): ReturnType<typeof setInterval> {
      return setInterval(() => checkExternal(limitMb), EXTERNAL_CHECK_MS);
    }

    const deadline = setTimeout(() => settle({ ok: false, error: new DocumentReadTimeoutError(timeoutMs) }), timeoutMs);
    const externalCheck = maxExternalMb === undefined ? undefined : watchExternal(maxExternalMb);

    worker.on('message', (value: unknown) => settle(outcomeOf(value)));
    worker.on('messageerror', (error: Error) => settle({ ok: false, error }));
    worker.on('error', (error: Error) => {
      settle({ ok: false, error: isOutOfMemory(error) ? new DocumentTooComplexError(maxHeapMb, 'heap') : error });
    });
    worker.on('exit', (code: number) => {
      settle({ ok: false, error: new Error(`loadIsolated: the worker exited with code ${code} before it answered`) });
    });
  });
}

// ---------------------------------------------------------------------------
// loadIsolated
// ---------------------------------------------------------------------------

/**
 * Reads a document's bytes with the loader of `kind` in a worker thread and answers what that loader answers.
 *
 * The bytes are copied into a buffer of the function's own, which is moved to the worker, so the caller's
 * buffer stays usable. The worker's old generation is capped at `maxHeapMb`, the read ends after `timeoutMs`,
 * and with `maxExternalMb` it ends once the worker's memory outside its heap passes that bound. On every path,
 * an answer included, the worker is ended before the returned promise settles.
 *
 * @param kind - The loader to read with.
 * @param bytes - The document, as a `Buffer` or any `Uint8Array`.
 * @param options - The read's bounds.
 * @returns What the loader answers: the document's `content`, `metadata` and `format`.
 * @throws {TypeError} For a kind outside the four, bytes that are not a `Uint8Array`, or `maxExternalMb` where `worker.getHeapStatistics()` is missing.
 * @throws {RangeError} For a bound that is not a positive, finite number, or a `timeoutMs` past 2,147,483,647.
 * @throws {DocumentTooComplexError} When the worker reaches its heap cap, or its external memory passes `maxExternalMb`.
 * @throws {DocumentReadTimeoutError} When the read passes `timeoutMs`.
 * @throws {DocumentTooLargeError} When a Word file's entries inflate past `maxInflatedBytes`.
 * @throws {Error} The loader's own error, with its name and message, such as `DocxLoader: not a Word archive`.
 *
 * @example A Word file from someone you do not know
 * ```ts
 * import { loadIsolated, DocumentTooComplexError, DocumentReadTimeoutError } from '@framers/agentos/cognition/memory';
 *
 * try {
 *   const doc = await loadIsolated('docx', upload, { maxHeapMb: 256, timeoutMs: 30_000, maxExternalMb: 128 });
 *   console.log(doc.content.length);
 * } catch (error) {
 *   if (error instanceof DocumentTooComplexError) console.log(`more than ${error.limitMb} MiB of ${error.resource}`);
 *   else if (error instanceof DocumentReadTimeoutError) console.log(`not read within ${error.timeoutMs} ms`);
 *   else throw error;
 * }
 * ```
 */
export async function loadIsolated(
  kind: IsolatedLoadKind,
  bytes: Uint8Array,
  options: IsolatedLoadOptions = {},
): Promise<LoadedDocument> {
  if (!KINDS.includes(kind)) {
    throw new TypeError(`loadIsolated: kind must be one of ${KINDS.join(', ')}, got ${String(kind)}`);
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('loadIsolated: bytes must be a Buffer or a Uint8Array');
  }
  const maxHeapMb = bound('maxHeapMb', options.maxHeapMb ?? DEFAULT_MAX_HEAP_MB);
  const timeoutMs = bound('timeoutMs', options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxInflatedBytes =
    options.maxInflatedBytes === undefined ? undefined : bound('maxInflatedBytes', options.maxInflatedBytes);
  const maxExternalMb = options.maxExternalMb === undefined ? undefined : bound('maxExternalMb', options.maxExternalMb);
  if (maxExternalMb !== undefined && typeof Worker.prototype.getHeapStatistics !== 'function') {
    throw new TypeError('loadIsolated: maxExternalMb needs worker.getHeapStatistics(), which Node 22.16 and 24.0 add');
  }

  // A buffer of the function's own, moved to the worker: the caller's buffer stays usable whatever it views,
  // and a Buffer from Node's pool, which cannot be moved, never enters the transfer list.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const request: IsolatedLoadRequest = { kind, bytes: copy.buffer, maxInflatedBytes };
  const worker = new Worker(new URL('./isolatedLoadWorker.js', import.meta.url), {
    workerData: request,
    transferList: [copy.buffer],
    resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
    // In place of the Node options a worker inherits from the caller's thread: an `--input-type` given with
    // `node -e` refuses a file as the worker's entry (ERR_INPUT_TYPE_NOT_ALLOWED), and the caller's `--require`
    // and `--import` preloads would load inside the capped heap. NODE_OPTIONS still applies, and V8's options
    // (`--max-old-space-size` among them) are the whole process's, so they hold for the worker whatever this says.
    execArgv: [],
  });
  return awaitRead(worker, maxHeapMb, timeoutMs, maxExternalMb);
}
