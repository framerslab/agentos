/**
 * @file IVideoGenerator.ts
 * Provider interface for video generation (text-to-video and image-to-video).
 *
 * Follows the same pattern as {@link IImageProvider} in the image subsystem:
 * each concrete provider implements this interface, and instances are composed
 * into a {@link FallbackVideoProxy} chain for automatic failover.
 *
 * @see {@link FallbackVideoProxy} for the failover wrapper.
 * @see {@link IVideoAnalyzer} for the read-side analysis interface.
 */

import type { VideoGenerateRequest, ImageToVideoRequest, VideoResult } from './types.js';

// ---------------------------------------------------------------------------
// IVideoGenerator
// ---------------------------------------------------------------------------

/**
 * Abstraction over a video generation backend (Runway, Pika, Kling, Luma,
 * Stable Video, Google Veo, Replicate, etc.).
 *
 * ## Capability negotiation
 *
 * Not every provider supports every modality. The {@link supports} method
 * lets callers (and the {@link FallbackVideoProxy}) query whether a given
 * capability is available before invoking it.
 *
 * ## Lifecycle
 *
 * 1. Construct the provider.
 * 2. Call {@link initialize} with provider-specific configuration (API keys,
 *    base URLs, etc.).
 * 3. Use {@link generateVideo} and/or {@link imageToVideo}.
 * 4. Optionally call {@link shutdown} to release resources.
 */
export interface IVideoGenerator {
  /** Unique identifier for this provider (e.g. `'runway'`, `'pika'`). */
  readonly providerId: string;

  /** Whether {@link initialize} has been called successfully. */
  readonly isInitialized: boolean;

  /** Default model used when the request omits `modelId`. */
  readonly defaultModelId?: string;

  /**
   * Initialise the provider with runtime configuration.
   *
   * @param config - Provider-specific key/value pairs (API keys, endpoints,
   *   model overrides, etc.).
   */
  initialize(config: Record<string, unknown>): Promise<void>;

  /**
   * Generate a video from a text prompt.
   *
   * @param request - The generation parameters.
   * @returns A result envelope containing one or more generated videos.
   */
  generateVideo(request: VideoGenerateRequest): Promise<VideoResult>;

  /**
   * Generate a video from a source image and a motion prompt.
   *
   * `request.image` is a `Buffer` or a URL string (`https://` or `data:`);
   * see `VideoImageInput` in `types.ts`.
   *
   * This method is optional — providers that do not support image-to-video
   * should either omit it or have {@link supports} return `false` for
   * `'image-to-video'`.
   *
   * @param request - The image-to-video parameters.
   * @returns A result envelope containing one or more generated videos.
   */
  imageToVideo?(request: ImageToVideoRequest): Promise<VideoResult>;

  /**
   * Query whether this provider supports a given capability.
   *
   * @param capability - The capability to check.
   * @returns `true` if the provider can handle the requested capability.
   */
  supports(capability: 'text-to-video' | 'image-to-video'): boolean;

  /**
   * Release any resources held by the provider (HTTP connections, polling
   * loops, temp files, etc.).
   */
  shutdown?(): Promise<void>;
}
