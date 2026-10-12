/**
 * @file blobPart.ts
 * A Buffer as a `BlobPart`, and an image's type by its signature, in a module
 * that imports nothing, so code that only builds a Blob does not load the
 * image fetch and its Node networking modules with it.
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

/** The media type, file extension and name of an image format a provider may take. */
export interface ImagePartType {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  extension: 'png' | 'jpg' | 'webp' | 'gif';
  name: 'PNG' | 'JPEG' | 'WebP' | 'GIF';
}

/** The four formats {@link imagePartType} reads, by media type. */
export const IMAGE_PART_TYPES: Readonly<Record<ImagePartType['mimeType'], ImagePartType>> = {
  'image/png': { mimeType: 'image/png', extension: 'png', name: 'PNG' },
  'image/jpeg': { mimeType: 'image/jpeg', extension: 'jpg', name: 'JPEG' },
  'image/webp': { mimeType: 'image/webp', extension: 'webp', name: 'WebP' },
  'image/gif': { mimeType: 'image/gif', extension: 'gif', name: 'GIF' },
};

/**
 * The format of an image by its signature: PNG, JPEG, WebP or GIF, else
 * `undefined`.
 *
 * @param bytes - The image's bytes.
 */
export function imagePartType(bytes: Buffer): ImagePartType | undefined {
  const startsWith = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return IMAGE_PART_TYPES['image/png'];
  if (startsWith(0xff, 0xd8, 0xff)) return IMAGE_PART_TYPES['image/jpeg'];
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return IMAGE_PART_TYPES['image/webp'];
  }
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return IMAGE_PART_TYPES['image/gif'];
  return undefined;
}

/**
 * The type an edit or upscale route sends an image as: PNG, JPEG or WebP as
 * detected, and anything else, GIF included, as PNG, as these routes always
 * labelled every image. Their providers take those three formats (OpenAI's
 * edits: "a `png`, `webp`, or `jpg` file"; Stability's image routes: JPEG,
 * PNG and WebP), so a GIF is sent as it was before and the provider answers
 * for it.
 *
 * @param bytes - The image's bytes.
 */
export function editPartType(bytes: Buffer): ImagePartType {
  const type = imagePartType(bytes);
  return type && type.mimeType !== 'image/gif' ? type : IMAGE_PART_TYPES['image/png'];
}

/**
 * An image as a multipart file part: a Blob of its format and the file name
 * `<name>.<extension>`.
 *
 * @param bytes - The image's bytes.
 * @param type - Its format, from {@link imagePartType}.
 * @param name - The file name without its extension.
 */
export function imageFilePart(bytes: Buffer, type: ImagePartType, name: string): { blob: Blob; filename: string } {
  return { blob: new Blob([bufferToBlobPart(bytes)], { type: type.mimeType }), filename: `${name}.${type.extension}` };
}

/**
 * An image as a base64 data URL of its format.
 *
 * @param bytes - The image's bytes.
 * @param type - Its format, from {@link imagePartType}.
 */
export function imageDataUrl(bytes: Buffer, type: ImagePartType): string {
  return `data:${type.mimeType};base64,${bytes.toString('base64')}`;
}
