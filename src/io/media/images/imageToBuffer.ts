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
import { fileURLToPath } from 'node:url';

import { fetchUntrustedImage } from './untrustedImageFetch.js';

/** Options for {@link imageToBuffer}. */
export interface ImageToBufferOptions {
  /**
   * The input comes from an untrusted source, such as a model's tool call or
   * a user. A local file path or a `file:` URL is refused instead of read,
   * and an http(s) URL is fetched only from a public network address: each
   * connection's address is checked when the connection is made, so a host
   * name that resolves to this machine or a private network is refused, and
   * every redirect is checked the same way. The fetch stops at `maxBytes`
   * and `timeoutMs`. Default `false`.
   */
  untrusted?: boolean;
  /** For an untrusted http(s) URL: the most bytes the response may have (default 50 MiB). */
  maxBytes?: number;
  /** For an untrusted http(s) URL: how long the fetch may take in milliseconds, redirects and body included (default 30 seconds). */
  timeoutMs?: number;
}

/**
 * Converts an image input from any of the supported formats into a `Buffer`.
 *
 * Supported input formats:
 * - **`Buffer`** — returned as-is.
 * - **Data URL** (RFC 2397) — `data:image/png;base64,iVBOR...` is decoded
 *   from base64; one without `;base64`, such as
 *   `data:image/svg+xml,%3Csvg%3E...`, is percent-decoded byte by byte.
 * - **Raw base64 string** — decoded. A string that does not look like a URL
 *   or a file path is decoded directly. One that looks like a path is read as
 *   a file first, and decoded when no file exists there and it is base64
 *   (standard or URL-safe) whose bytes start with a PNG, JPEG, GIF, WebP, TIFF,
 *   AVIF, HEIC, BMP, ICO, JPEG 2000, JPEG XL or SVG signature: standard base64
 *   uses `/` (RFC 4648, Table 1), so a JPEG's base64 begins with `/9j/`. A
 *   missing path is still an error; when the string is base64 of another
 *   format, the error says so without repeating the string.
 * - **`file:` URL** — converted to a local path with `fileURLToPath` and read.
 * - **HTTP/HTTPS URL** — fetched via `globalThis.fetch` and buffered.
 * - **Local file path** — a string that contains `/` or `\`, or ends in a
 *   file extension, is read with `fs.readFile`.
 *
 * A string from an untrusted source can name any file the process can read,
 * and a URL can point at this machine or a private network, a cloud
 * metadata service among them. Pass `{ untrusted: true }` for such input:
 * file paths and `file:` URLs are refused (raw base64 of a recognised image
 * format is still decoded), and an http(s) URL is fetched only from public
 * network addresses, checked at every connection and every redirect, within
 * `maxBytes` and `timeoutMs`.
 *
 * @param input - The image in any supported format.
 * @param options - {@link ImageToBufferOptions}; `untrusted` for input from
 *   a model or a user.
 * @returns A `Buffer` containing the raw image bytes.
 *
 * @throws {TypeError} When `input` is neither a string nor a Buffer.
 * @throws {Error} When a remote URL fetch fails or the file cannot be read;
 *   with `untrusted`, also when the input names a local file
 *   (`code: 'IMAGE_LOCAL_FILE_REFUSED'`) or a URL whose address or redirect
 *   is refused (`code: 'IMAGE_URL_REFUSED'`).
 *
 * @example
 * ```ts
 * const buf1 = await imageToBuffer('data:image/png;base64,iVBOR...');
 * const buf2 = await imageToBuffer(fs.readFileSync('photo.png'));
 * const buf3 = await imageToBuffer('https://example.com/photo.png');
 * const buf4 = await imageToBuffer('/absolute/path/to/image.jpg');
 * // A URL a model's tool call gave: public hosts only, 50 MiB and 30 s at most.
 * const buf5 = await imageToBuffer(toolArgs.imageUrl, { untrusted: true });
 * ```
 */
export async function imageToBuffer(input: string | Buffer, options: ImageToBufferOptions = {}): Promise<Buffer> {
  // Already a Buffer — nothing to do.
  if (Buffer.isBuffer(input)) {
    return input;
  }

  if (typeof input !== 'string') {
    throw new TypeError('imageToBuffer: expected a string (base64, URL, or file path) or Buffer.');
  }

  const trimmed = input.trim();

  // Data URL (RFC 2397): base64 after ";base64", percent-encoded bytes otherwise.
  if (/^data:/i.test(trimmed)) {
    const commaIdx = trimmed.indexOf(',');
    if (commaIdx === -1) {
      throw new Error('imageToBuffer: malformed data URL — missing comma separator.');
    }
    const payload = trimmed.slice(commaIdx + 1);
    return /;base64$/i.test(trimmed.slice(0, commaIdx)) ? Buffer.from(payload, 'base64') : percentDecodeBytes(payload);
  }

  // file: URL — convert to a local path and read.
  if (/^file:/i.test(trimmed)) {
    if (options.untrusted) {
      throw localFileRefusal(trimmed);
    }
    return fs.readFile(fileURLToPath(trimmed));
  }

  // Remote HTTP(S) URL — fetch and buffer.
  if (/^https?:\/\//i.test(trimmed)) {
    if (options.untrusted) {
      return fetchUntrustedImage(trimmed, { maxBytes: options.maxBytes, timeoutMs: options.timeoutMs });
    }
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
  if (looksLikePath && options.untrusted) {
    // No file is read for untrusted input; base64 of an image is still decoded.
    const bytes = imageBase64(trimmed);
    if (bytes) {
      return bytes;
    }
    throw localFileRefusal(trimmed);
  }
  if (looksLikePath) {
    try {
      return await fs.readFile(trimmed);
    } catch (error) {
      // Standard base64 uses `/` (RFC 4648, Table 1), so raw base64 looks like a
      // path. When no file exists there and the string decodes to image bytes,
      // it is the image; a missing path that does not stays an error.
      const compact = trimmed.replace(/\s+/g, '');
      if (!isMissingFileError(error) || !BASE64_PATTERN.test(compact)) {
        throw error;
      }
      const bytes = Buffer.from(compact, 'base64');
      if (hasImageSignature(bytes)) {
        return bytes;
      }
      // Node's error names the whole string as the path, which for a base64
      // payload can run to megabytes in a message or a log line. It is not
      // attached as `cause` either: Node prints an error's cause with it.
      throw Object.assign(
        new Error(
          `imageToBuffer: no file exists at ${preview(trimmed)}, and it is not base64 of a ` +
            'recognised image format (PNG, JPEG, GIF, WebP, TIFF, AVIF, HEIC, BMP, ICO, ' +
            'JPEG 2000, JPEG XL or SVG). Pass the image as a data URL or a Buffer.',
        ),
        { code: (error as NodeJS.ErrnoException).code },
      );
    }
  }

  // Fallback: raw base64 string (no data URL prefix).
  return Buffer.from(trimmed, 'base64');
}

/** The error for untrusted input that names a local file. */
function localFileRefusal(value: string): Error {
  return Object.assign(
    new Error(
      `imageToBuffer: ${preview(value)} looks like a local file path or file URL, and untrusted input is ` +
        'not read from the file system. Pass the image as a data URL, an http(s) URL or a Buffer.',
    ),
    { code: 'IMAGE_LOCAL_FILE_REFUSED' },
  );
}

/** The bytes of `text` when it is base64 (standard or URL-safe) of a recognised image format, else `undefined`. */
function imageBase64(text: string): Buffer | undefined {
  const compact = text.replace(/\s+/g, '');
  if (!BASE64_PATTERN.test(compact)) {
    return undefined;
  }
  const bytes = Buffer.from(compact, 'base64');
  return hasImageSignature(bytes) ? bytes : undefined;
}

/** The value of an ASCII hex digit, or -1. */
function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

/**
 * The bytes of a percent-encoded data URL payload: each `%XX` is one byte and
 * any other character its UTF-8 bytes. A `%` that starts no valid escape is
 * kept as it is, so decoding never throws.
 */
function percentDecodeBytes(payload: string): Buffer {
  const text = Buffer.from(payload, 'utf8');
  const out = Buffer.allocUnsafe(text.length);
  let length = 0;
  for (let i = 0; i < text.length; i += 1) {
    const high = text[i] === 0x25 && i + 2 < text.length ? hexValue(text[i + 1]) : -1;
    const low = high >= 0 ? hexValue(text[i + 2]) : -1;
    if (low >= 0) {
      out[length] = high * 16 + low;
      i += 2;
    } else {
      out[length] = text[i];
    }
    length += 1;
  }
  return out.subarray(0, length);
}

/** The standard and URL-safe base64 alphabets of RFC 4648, with optional padding. */
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** A short, quoted form of `value` for an error message: at most its first 40 characters. */
function preview(value: string): string {
  return value.length <= 40
    ? JSON.stringify(value)
    : `${JSON.stringify(value.slice(0, 40))}... (${value.length} characters)`;
}

/**
 * True when `bytes` start with the signature of PNG, JPEG, GIF, WebP, TIFF, an
 * ISO media file such as AVIF or HEIC (`ftyp` at offset 4), BMP, ICO, JPEG 2000,
 * the JPEG XL container, or SVG text. JPEG XL's bare codestream marker (FF 0A)
 * is left out: two bytes are too few, and a path such as `/work...` decodes to
 * them.
 */
function hasImageSignature(bytes: Buffer): boolean {
  const startsWith = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  return (
    startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) || // PNG
    startsWith(0xff, 0xd8, 0xff) || // JPEG
    startsWith(0x47, 0x49, 0x46, 0x38) || // GIF8
    (startsWith(0x52, 0x49, 0x46, 0x46) && bytes.subarray(8, 12).toString('latin1') === 'WEBP') ||
    startsWith(0x49, 0x49, 0x2a, 0x00) || // TIFF, little-endian
    startsWith(0x4d, 0x4d, 0x00, 0x2a) || // TIFF, big-endian
    bytes.subarray(4, 8).toString('latin1') === 'ftyp' ||
    // BMP: "BM", then the file size, which a whole file's bytes match.
    (startsWith(0x42, 0x4d) && bytes.length >= 6 && bytes.readUInt32LE(2) === bytes.length) ||
    startsWith(0x00, 0x00, 0x01, 0x00) || // ICO
    startsWith(0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a) || // JPEG 2000 (JP2)
    startsWith(0xff, 0x4f, 0xff, 0x51) || // JPEG 2000 codestream
    startsWith(0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a) || // JPEG XL container
    isSvgText(bytes)
  );
}

/**
 * The XML prolog items that may come before the root element: the XML
 * declaration and other processing instructions, comments, and a DOCTYPE
 * (internal subset included), each with the whitespace before it.
 *
 * A DOCTYPE's quoted literals and its subset's comments and processing
 * instructions are read whole, so a `>` in a system identifier, a `]>` in an
 * entity value or a quote in a processing instruction does not end it.
 * Every part has one way to match (a subset comment ends at its first `-->`,
 * a processing instruction at its first `?>`),
 * which keeps a failed match linear in the input: a lazy `[\s\S]*?` comment
 * body inside the repeated subset could end at any later `-->` and backtrack
 * exponentially on input that has many comments and no closing `]`.
 */
const XML_PROLOG_ITEM =
  /^\s*(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE(?:[^>["']|"[^"]*"|'[^']*')*(?:\[(?:<!--(?:[^-]|-(?!->))*-->|<\?(?:[^?]|\?(?!>))*\?>|"[^"]*"|'[^']*'|<(?!!--|\?)|[^\]"'<])*\])?\s*>)/i;

/**
 * True when `bytes` are SVG markup: after the XML prolog (declaration,
 * comments, DOCTYPE), the root element is `<svg>`.
 */
function isSvgText(bytes: Buffer): boolean {
  let head = bytes.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '');
  for (let item = XML_PROLOG_ITEM.exec(head); item; item = XML_PROLOG_ITEM.exec(head)) {
    head = head.slice(item[0].length);
  }
  return /^\s*<svg[\s/>]/.test(head);
}

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
