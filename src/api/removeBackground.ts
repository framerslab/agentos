/**
 * @module api/removeBackground
 */
import { imageDataUrl, imagePartType } from '../io/media/images/blobPart.js';
import { resolveBackgroundRemovalProvider } from '../io/segmentation/BackgroundRemovalProviderRegistry.js';
import { isBase64Payload } from '../io/segmentation/providers/FalBackgroundRemovalProvider.js';
import { SegmentationProviderError } from '../io/segmentation/errors.js';
import type {
  BackgroundRemovalResult,
  RemoveBackgroundOptions,
} from '../io/segmentation/types.js';

/** How long a background removal may take when the call sets no `timeoutMs`. */
export const DEFAULT_BACKGROUND_REMOVAL_TIMEOUT_MS = 60_000;

const OUTPUTS = new Set(['url', 'buffer']);
const FORMATS = new Set(['png', 'webp']);

/**
 * Whether a base64 payload decodes to PNG, JPEG, WebP or GIF bytes. Only its
 * first 32 characters (24 bytes, every signature's length) are decoded.
 */
function holdsImage(payload: string): boolean {
  return imagePartType(Buffer.from(payload.slice(0, 32), 'base64')) !== undefined;
}

/**
 * The image as the provider takes it: an `http(s)` URL or a base64 image data
 * URL whose bytes are PNG, JPEG, WebP or GIF as given, or bytes as a data URL
 * typed by their signature.
 *
 * @throws {SegmentationProviderError} `invalid_request` for any other string,
 *   a data URL whose payload is not standard padded base64 or not one of those
 *   formats among them, and for bytes that are not PNG, JPEG, WebP or GIF.
 */
function toImageUrl(image: RemoveBackgroundOptions['image']): string {
  if (typeof image === 'string') {
    const value = image.trim();
    if (/^https?:\/\//i.test(value)) {
      try {
        new URL(value);
        return value;
      } catch {
        // Falls through to the refusal below.
      }
    } else {
      const dataUrl = /^data:image\/[\w.+-]+;base64,(.*)$/is.exec(value);
      if (dataUrl && isBase64Payload(dataUrl[1]) && holdsImage(dataUrl[1])) return value;
    }
    throw new SegmentationProviderError(
      'removeBackground takes an http(s) URL, a base64 image data URL, or the image bytes; read a local file and pass its bytes.',
      'invalid_request',
    );
  }
  if (image instanceof Uint8Array) {
    const bytes = Buffer.isBuffer(image) ? image : Buffer.from(image.buffer, image.byteOffset, image.byteLength);
    const type = imagePartType(bytes);
    if (!type) {
      throw new SegmentationProviderError('removeBackground reads image bytes as PNG, JPEG, WebP or GIF; these are none of them.', 'invalid_request');
    }
    return imageDataUrl(bytes, type);
  }
  throw new SegmentationProviderError('removeBackground takes the image as a string or bytes.', 'invalid_request');
}

/**
 * Cuts the subject of an image out of its background: the subject on a
 * transparent PNG (or WebP), as a URL on the provider's storage or as bytes.
 *
 * The built-in provider is fal's BiRefNet v2 (`fal-ai/birefnet/v2`), called
 * through fal's synchronous API with `FAL_API_KEY` (or the call's `apiKey`).
 * Other backends implement `IBackgroundRemovalProvider` and register
 * with `registerBackgroundRemovalProvider(id, provider)`.
 *
 * @param opts - The image and how to return the cut-out.
 * @returns The cut-out, the matte with `returnMask`, the provider and model,
 *   and the call's duration.
 *
 * @throws {SegmentationProviderError} `invalid_request` before any request
 *   for an image it cannot send or a malformed option, and for an answer the
 *   provider refuses (fal: 400, 413, 422); `provider_failed` for any other
 *   failure; `timeout` when `timeoutMs` passes. A failed answer carries its
 *   HTTP `status`.
 * @throws {Error} When the provider id is unknown or its key is missing.
 * @throws The reason of `opts.signal` when the caller aborts.
 *
 * @example
 * ```ts
 * import fs from 'node:fs';
 * import { removeBackground } from '@framers/agentos';
 *
 * // The cut-out's URL (fal's CDN).
 * const { image } = await removeBackground({ image: 'https://example.com/hero.png' });
 *
 * // The cut-out's bytes, and the matte.
 * const { image: png, mask } = await removeBackground({
 *   image: fs.readFileSync('hero.jpg'),
 *   output: 'buffer',
 *   returnMask: true,
 * });
 * fs.writeFileSync('hero-cut.png', png.buffer!);
 * ```
 */
export async function removeBackground(opts: RemoveBackgroundOptions): Promise<BackgroundRemovalResult> {
  opts.signal?.throwIfAborted();
  const imageUrl = toImageUrl(opts.image);

  const output = opts.output ?? 'url';
  if (!OUTPUTS.has(output)) {
    throw new SegmentationProviderError(`removeBackground output must be "url" or "buffer", not "${String(output)}".`, 'invalid_request');
  }
  const format = opts.format ?? 'png';
  if (!FORMATS.has(format)) {
    throw new SegmentationProviderError(`removeBackground format must be "png" or "webp", not "${String(format)}".`, 'invalid_request');
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BACKGROUND_REMOVAL_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new SegmentationProviderError('removeBackground timeoutMs must be a positive number of milliseconds.', 'invalid_request');
  }

  const provider = await resolveBackgroundRemovalProvider(opts.provider ?? 'fal', {
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
  });
  return provider.removeBackground({
    modelId: opts.model ?? provider.defaultModelId ?? '',
    imageUrl,
    output,
    format,
    returnMask: opts.returnMask === true,
    timeoutMs,
    signal: opts.signal,
    providerOptions: opts.providerOptions,
  });
}
