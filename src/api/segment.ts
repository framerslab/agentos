/**
 * @module api/segment
 */
import { imageToBuffer } from '../io/media/images/imageToBuffer.js';
import { resolveSegmentationMode } from '../io/segmentation/resolveMode.js';
import { resolveSegmentationProvider } from '../io/segmentation/SegmentationProviderRegistry.js';
import { SegmentationModeNotSupportedError } from '../io/segmentation/errors.js';
import type { SegmentOptions, SegmentationResult, SegmentationRequest } from '../io/segmentation/types.js';

/**
 * Segment an image into pixel masks.
 *
 * Exactly one prompt mode must be set: `prompt` (text), `points`, `box`, or
 * `automatic`. Returns one {@link SegmentMask} per detected region; an empty
 * `masks` array is a valid (non-error) result.
 *
 * @throws {InvalidSegmentationPromptError} zero or multiple prompt modes.
 * @throws {SegmentationModeNotSupportedError} provider lacks the resolved mode.
 * @throws {SegmentationProviderError} provider/network failure or timeout.
 */
export async function segment(opts: SegmentOptions): Promise<SegmentationResult> {
  const mode = resolveSegmentationMode(opts);

  const raw =
    opts.image instanceof Uint8Array && !Buffer.isBuffer(opts.image)
      ? Buffer.from(opts.image)
      : opts.image;
  const image = await imageToBuffer(raw as string | Buffer);

  const provider = await resolveSegmentationProvider(opts.provider ?? 'replicate');
  if (!provider.supportedModes().includes(mode)) {
    throw new SegmentationModeNotSupportedError(provider.providerId, mode);
  }

  const request: SegmentationRequest = {
    modelId: opts.model ?? provider.defaultModelId ?? '',
    image,
    mode,
    prompt: opts.prompt,
    points: opts.points?.map((p) => ({ x: p.x, y: p.y, label: p.label ?? 'foreground' })),
    box: opts.box,
    maxMasks: opts.maxMasks,
    minScore: opts.minScore,
    providerOptions: opts.providerOptions,
  };
  return provider.segment(request);
}
