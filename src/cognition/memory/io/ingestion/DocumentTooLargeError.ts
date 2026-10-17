/**
 * @fileoverview DocumentTooLargeError: the refusal of a document that would
 * take more memory to read than its loader allows.
 *
 * It lives in a module that imports nothing, so a module that only throws or
 * checks it loads no parser to do so: the office loader's entry names it
 * without loading the Word loader's mammoth. `DocxLoader.js` and the memory
 * module's index export this same class.
 *
 * @module memory/ingestion/DocumentTooLargeError
 */

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
