/**
 * @file imageToBuffer.ts
 * Shared utility for normalising heterogeneous image inputs into a `Buffer`.
 *
 * Image editing, upscaling, and variation APIs accept images in multiple
 * formats (base64 data URLs, raw base64 strings, `Buffer` instances, local
 * file paths, and remote HTTP/HTTPS URLs).  This helper unifies them into
 * a single `Buffer` so that downstream provider code never has to worry
 * about the input shape.
 */
import * as fs from 'node:fs/promises';

/**
 * Converts an image input from any of the supported formats into a `Buffer`.
 *
 * Supported input formats:
 * - **`Buffer`** — returned as-is.
 * - **Base64 data URL** — e.g. `data:image/png;base64,iVBOR...`.  The base64
 *   payload is extracted and decoded.
 * - **Raw base64 string** — decoded. A string that does not look like a URL
 *   or a file path is decoded directly. One that looks like a path is read as
 *   a file first, and decoded when no file exists there and it is in the base64
 *   alphabet (standard or URL-safe): standard base64 uses `/` (RFC 4648,
 *   Table 1), so a JPEG's base64 begins with `/9j/`.
 * - **`file://` URL** — resolved to a local filesystem path and read.
 * - **HTTP/HTTPS URL** — fetched via `globalThis.fetch` and buffered.
 * - **Local file path** — a string that contains `/` or `\`, or ends in a
 *   file extension, is read with `fs.readFile`. A string from an
 *   untrusted caller can name any file the process can read, so pass such
 *   input as a `Buffer` or a data URL.
 *
 * @param input - The image in any supported format.
 * @returns A `Buffer` containing the raw image bytes.
 *
 * @throws {TypeError} When `input` is neither a string nor a Buffer.
 * @throws {Error} When a remote URL fetch fails or the file cannot be read.
 *
 * @example
 * ```ts
 * const buf1 = await imageToBuffer('data:image/png;base64,iVBOR...');
 * const buf2 = await imageToBuffer(fs.readFileSync('photo.png'));
 * const buf3 = await imageToBuffer('https://example.com/photo.png');
 * const buf4 = await imageToBuffer('/absolute/path/to/image.jpg');
 * ```
 */
export async function imageToBuffer(input: string | Buffer): Promise<Buffer> {
  // Already a Buffer — nothing to do.
  if (Buffer.isBuffer(input)) {
    return input;
  }

  if (typeof input !== 'string') {
    throw new TypeError('imageToBuffer: expected a string (base64, URL, or file path) or Buffer.');
  }

  const trimmed = input.trim();

  // Base64 data URL (e.g. "data:image/png;base64,iVBOR...")
  if (trimmed.startsWith('data:')) {
    const commaIdx = trimmed.indexOf(',');
    if (commaIdx === -1) {
      throw new Error('imageToBuffer: malformed data URL — missing comma separator.');
    }
    // Everything after the comma is the base64 payload.
    return Buffer.from(trimmed.slice(commaIdx + 1), 'base64');
  }

  // file:// URL — convert to local path and read.
  if (trimmed.startsWith('file://')) {
    const filePath = new URL(trimmed).pathname;
    return fs.readFile(filePath);
  }

  // Remote HTTP(S) URL — fetch and buffer.
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const response = await globalThis.fetch(trimmed);
    if (!response.ok) {
      throw new Error(
        `imageToBuffer: failed to fetch image from ${trimmed} (${response.status} ${response.statusText}).`
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  // Heuristic: if the string contains path separators or a file extension,
  // treat it as a filesystem path.  Otherwise assume raw base64.
  const looksLikePath =
    trimmed.includes('/') || trimmed.includes('\\') || /\.\w{2,5}$/.test(trimmed);
  if (looksLikePath) {
    try {
      return await fs.readFile(trimmed);
    } catch (error) {
      // Standard base64 uses `/` (RFC 4648, Table 1), so raw base64 looks like a
      // path. When no file exists there and the string is base64, decode it.
      const compact = trimmed.replace(/\s+/g, '');
      if (isMissingFileError(error) && BASE64_PATTERN.test(compact)) {
        return Buffer.from(compact, 'base64');
      }
      throw error;
    }
  }

  // Fallback: raw base64 string (no data URL prefix).
  return Buffer.from(trimmed, 'base64');
}

/** The standard and URL-safe base64 alphabets of RFC 4648, with optional padding. */
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * True for the errors `fs.readFile` gives when nothing exists at the path,
 * which are the errors a base64 string read as a path gives.
 */
function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG';
}

/**
 * Converts a Node.js `Buffer` into a DOM-compatible `BlobPart`.
 *
 * Recent TypeScript DOM typings require `BlobPart` byte views to be backed by a
 * concrete `ArrayBuffer`, while `Buffer` is typed as `ArrayBufferLike`. Returning
 * a plain `Uint8Array` avoids that mismatch for multipart image uploads.
 *
 * @param input - Raw image bytes stored in a Node.js `Buffer`.
 * @returns An `ArrayBuffer` safe to pass into `new Blob([...])`.
 */
export function bufferToBlobPart(input: Buffer): ArrayBuffer {
  const bytes = new ArrayBuffer(input.byteLength);
  new Uint8Array(bytes).set(input);
  return bytes;
}
