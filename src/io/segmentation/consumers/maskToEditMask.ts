/**
 * @module io/segmentation/consumers/maskToEditMask
 */
import type { SegmentMask } from '../types.js';

/**
 * Combine one or more segmentation masks into a single mask Buffer suitable for
 * `editImage()`'s `mask` input (white = edit region, black = keep).
 *
 * @param masks one mask or many (unioned)
 * @param opts.target `'object'` (default) edits the masked object; `'background'`
 *   inverts so everything except the object is edited.
 * @param opts.width optional canvas width; defaults to the first mask's.
 * @param opts.height optional canvas height; defaults to the first mask's.
 */
export async function maskToEditMask(
  masks: SegmentMask | SegmentMask[],
  opts: { target?: 'object' | 'background'; width?: number; height?: number } = {},
): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const list = Array.isArray(masks) ? masks : [masks];
  if (list.length === 0) throw new Error('maskToEditMask requires at least one mask.');

  const first = await sharp(list[0].mask).metadata();
  const width = opts.width ?? first.width ?? 0;
  const height = opts.height ?? first.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error('maskToEditMask: could not determine mask dimensions; pass opts.width and opts.height.');
  }

  const layers = await Promise.all(
    list.map(async (m) => ({
      input: await sharp(m.mask).resize(width, height, { fit: 'fill' }).greyscale().png().toBuffer(),
      blend: 'screen' as const, // white-on-black union
    })),
  );

  let composed = sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite(layers)
    .greyscale();

  if (opts.target === 'background') composed = composed.negate();
  return composed.png().toBuffer();
}
