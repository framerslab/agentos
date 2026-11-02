/**
 * @file videoInputs.ts
 * Shared handling of the inputs a video request carries to a provider:
 * images given as bytes or URLs, and the provider-specific options bag.
 */

import type { VideoImageInput, VideoProviderOptionBag } from './types.js';

/**
 * Provider ids that mark a {@link VideoProviderOptionBag} as keyed by
 * provider: the built-in providers, and every id registered through
 * `registerVideoProviderFactory()`.
 */
const KEYED_VIDEO_PROVIDER_IDS = new Set(['fal', 'replicate', 'runway', 'gemini']);

/**
 * Mark a provider id as one that keys a {@link VideoProviderOptionBag}, so a
 * bag holding an entry for that provider is read as keyed by every other
 * provider too. `registerVideoProviderFactory()` calls it for each id it
 * registers.
 *
 * @param providerId - The provider id; matched lowercased.
 */
export function registerKeyedVideoProviderId(providerId: string): void {
  KEYED_VIDEO_PROVIDER_IDS.add(providerId.toLowerCase());
}

/**
 * Whether a value is a plain object (not an array, not null).
 *
 * @param value - The value to test.
 * @returns `true` for a non-array object.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);
}

/**
 * Read one provider's options from a request's `providerOptions`.
 *
 * A bag that holds the provider's own id, or the id of any built-in video
 * provider (`fal`, `replicate`, `runway`, `gemini`) or of a provider
 * registered with `registerVideoProviderFactory()`, is keyed by provider: the
 * provider receives its own entry, or nothing when the bag has none for it. A
 * bag with no such key is flat and is returned whole to every provider that
 * reads its options. Keys match provider ids whatever their case.
 *
 * @param providerId - The id of the provider reading its options.
 * @param providerOptions - The request's `providerOptions`.
 * @returns The provider's options, or `undefined` when there are none.
 *
 * @example
 * ```ts
 * getVideoProviderOptions('fal', { fal: { end_image_url: url }, replicate: { last_frame: url } });
 * // -> { end_image_url: url }
 * getVideoProviderOptions('fal', { prompt_optimizer: false });
 * // -> { prompt_optimizer: false }
 * ```
 */
export function getVideoProviderOptions(
  providerId: string,
  providerOptions?: VideoProviderOptionBag | Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!isPlainRecord(providerOptions)) return undefined;

  // Keys match providers case-insensitively, for marking the bag as keyed
  // and for finding the provider's own entry alike.
  const id = providerId.toLowerCase();
  const keys = Object.keys(providerOptions);
  const keyed = keys.some((key) => key.toLowerCase() === id || KEYED_VIDEO_PROVIDER_IDS.has(key.toLowerCase()));
  if (!keyed) return providerOptions;

  const ownKey = keys.find((key) => key === providerId) ?? keys.find((key) => key.toLowerCase() === id);
  const own = ownKey === undefined ? undefined : providerOptions[ownKey];
  return isPlainRecord(own) ? own : undefined;
}

/**
 * Copy provider options into a request body without replacing a field the
 * body already holds.
 *
 * @param target - The body built from the request's typed fields; mutated.
 * @param extra - The provider's options.
 * @returns `target`.
 */
export function addProviderInputs(
  target: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (!(key in target)) target[key] = value;
  }
  return target;
}

/**
 * Read an image's MIME type from its first bytes.
 *
 * @param bytes - The image file's bytes.
 * @returns `image/png`, `image/jpeg`, `image/gif` or `image/webp`; `image/png`
 *   when none of their signatures matches.
 */
export function sniffImageMimeType(bytes: Uint8Array): string {
  const at = (i: number): number => bytes[i] ?? -1;
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

/**
 * The form of an image for a provider that takes image URLs: a string is
 * returned as given, and a `Buffer` becomes a `data:` URL with the MIME type
 * read from its first bytes.
 *
 * @param image - The image as bytes or a URL.
 * @returns A URL the provider can send in a JSON body.
 */
export function videoImageToUrl(image: VideoImageInput): string {
  if (typeof image === 'string') return image;
  const bytes = Buffer.isBuffer(image) ? image : Buffer.from(image as Uint8Array);
  return `data:${sniffImageMimeType(bytes)};base64,${bytes.toString('base64')}`;
}

/**
 * Whether a source image was given: a `Buffer`, or a string with text in it.
 *
 * @param image - The request's `image`.
 * @returns `true` when the request carries an image.
 */
export function hasVideoImage(image: VideoImageInput | undefined | null): image is VideoImageInput {
  if (typeof image === 'string') return image.trim().length > 0;
  return image != null;
}
