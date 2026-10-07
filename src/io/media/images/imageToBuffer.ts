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
 * - **Raw base64 string** — a string in the base64 alphabet (standard or
 *   URL-safe) whose decoded bytes start with a PNG, JPEG, GIF, WebP, AVIF or
 *   HEIC signature is decoded, even when it contains `/`, which standard
 *   base64 uses (RFC 4648, Table 1). Any other string that does not look
 *   like a URL or a file path is decoded as base64 too.
 * - **`file://` URL** — resolved to a local filesystem path and read.
 * - **HTTP/HTTPS URL** — fetched via `globalThis.fetch` and buffered.
 * - **Local file path** — any other string that contains `/` or `\`, or ends
 *   in a file extension, is read with `fs.readFile`. A string from an
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

  // Raw base64 image data. It comes before the path check because standard
  // base64 contains `/`, and that check would send it to fs.readFile.
  const decoded = decodeImageBase64(trimmed);
  if (decoded) {
    return decoded;
  }

  // Heuristic: if the string contains path separators or a file extension,
  // treat it as a filesystem path.  Otherwise assume raw base64.
  const looksLikePath =
    trimmed.includes('/') || trimmed.includes('\\') || /\.\w{2,5}$/.test(trimmed);
  if (looksLikePath) {
    return fs.readFile(trimmed);
  }

  // Fallback: raw base64 string (no data URL prefix).
  return Buffer.from(trimmed, 'base64');
}

/** The standard and URL-safe base64 alphabets of RFC 4648, with optional padding. */
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Decodes `value` when it is base64 whose bytes start with an image signature.
 *
 * @param value - A trimmed string that is not a data URL or a URL.
 * @returns The decoded image bytes, or `null` when `value` is not base64 or its
 *   bytes do not start with a PNG, JPEG, GIF, WebP, AVIF or HEIC signature.
 */
function decodeImageBase64(value: string): Buffer | null {
  const compact = value.replace(/\s+/g, '');
  if (compact.length < 8 || !BASE64_PATTERN.test(compact)) {
    return null;
  }
  const bytes = Buffer.from(compact, 'base64');
  return hasImageSignature(bytes) ? bytes : null;
}

/**
 * True when `bytes` start with the signature of an image format the image
 * providers accept: PNG, JPEG, GIF, WebP, or an ISO media file such as AVIF or
 * HEIC (`ftyp` at offset 4).
 */
function hasImageSignature(bytes: Buffer): boolean {
  const startsWith = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  return (
    startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) || // PNG
    startsWith(0xff, 0xd8, 0xff) || // JPEG
    startsWith(0x47, 0x49, 0x46, 0x38) || // GIF8
    (startsWith(0x52, 0x49, 0x46, 0x46) && bytes.subarray(8, 12).toString('latin1') === 'WEBP') ||
    bytes.subarray(4, 8).toString('latin1') === 'ftyp'
  );
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
