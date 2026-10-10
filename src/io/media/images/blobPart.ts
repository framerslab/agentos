/**
 * @file blobPart.ts
 * A Buffer as a `BlobPart`, in a module that imports nothing, so code that
 * only builds a Blob does not load the image fetch and its Node networking
 * modules with it.
 */

/**
 * Converts a Node.js `Buffer` into a DOM-compatible `BlobPart`.
 *
 * Recent TypeScript DOM typings require `BlobPart` byte views to be backed by a
 * concrete `ArrayBuffer`, while `Buffer` is typed as `ArrayBufferLike`. A copy of
 * the bytes in an `ArrayBuffer` of its own avoids that mismatch.
 *
 * @param input - Raw image bytes stored in a Node.js `Buffer`.
 * @returns An `ArrayBuffer` safe to pass into `new Blob([...])`.
 */
export function bufferToBlobPart(input: Buffer): ArrayBuffer {
  const bytes = new ArrayBuffer(input.byteLength);
  new Uint8Array(bytes).set(input);
  return bytes;
}
